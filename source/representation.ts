import { randomUUID } from "node:crypto"
import type {
  Appearance,
  ClientDeclaration,
  EndpointDeclaration,
  ServiceKey,
  WindowGeometry,
  WindowLayer
} from "@phreshos/core"
import type { GatewayConnection } from "./transport.js"

export interface ProgramState {
  reference: string
  identity: string
  assetId: string
  installed: boolean
  name: string
  version: string | null
  description: string | null
  hasAgent: boolean
  server: EndpointDeclaration | null
  client: ClientDeclaration | null
}

export interface WindowState {
  title: string
  position: WindowGeometry["position"]
  size: WindowGeometry["size"]
  depth: number
  minimized: boolean
  layer: WindowLayer
  location: string
}

export interface ProcessState {
  reference: string
  identity: string
  name: string | null
  program: string
  parent: ProcessAddress | null
  options: Record<string, string>
  startedAt: Date
  server: { ready: boolean, service: boolean } | null
  client: { service: boolean, sameOrigin: boolean, window: WindowState } | null
}

export interface ProcessAddress {
  reference: string
  identity: string
}

export type Observation =
  | Readonly<{ scope: "endpoint", process: string, endpoint: "server" | "client", event: string | null }>
  | Readonly<{ scope: "traffic", process: string, endpoint: "server" | "client", kind: "publish" | "ask" | "answer", event: string | null }>
  | Readonly<{ scope: "service", key: ServiceKey, kind: "events" | "lifecycle", event: string | null }>

type Listener = (...values: unknown[]) => unknown

interface CommandEvent {
  event?: string
  [key: string]: unknown
}

const maximumStreamQueue = 256

/** A connection-owned, live representation of the authoritative System model. */
export default class SystemRepresentation {
  public readonly authorization: string
  public readonly programs = new Map<string, ProgramState>()
  public readonly processes = new Map<string, ProcessState>()
  public appearance: Appearance

  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly release: (() => void)[] = []

  public constructor(private readonly connection: GatewayConnection) {
    const session = ownerSession(connection.session)

    this.authorization = session.authorization
    this.appearance = session.linkManager.appearance.value

    for (const [, value] of session.authManager.programManager.programs) {
      const program = programState(value)
      this.programs.set(program.identity, program)
    }

    for (const [, value] of session.authManager.processManager.processes) {
      const process = processState(value)
      this.processes.set(process.identity, process)
    }

    this.followModel(session.linkManager.appearance.key)
  }

  public activate() { this.connection.activate() }

  public close() {
    for (const stop of this.release.splice(0)) stop()
    this.listeners.clear()
  }

  public call<Result = unknown>(event: string, ...values: unknown[]) {
    return this.connection.call<Result>(`/auth${event}`, this.authorization, ...values)
  }

  public on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)

    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(event)
    }
  }

  public follow(observation: Observation, listener: (event: string, value: unknown) => unknown, impossible?: (error: Error) => void) {
    const subscription = randomUUID()
    let active = true
    const stopEvent = this.connection.subscribe("/auth/process/followed", (received, event, value) => {
      if (active && received === subscription && typeof event === "string") listener(event, value)
    })
    const stopImpossible = this.connection.subscribe("/auth/process/impossible", (received, reason) => {
      if (!active || received !== subscription) return
      stop()
      impossible?.(new Error(String(reason)))
    })
    const stop = () => {
      if (!active) return
      active = false
      stopEvent()
      stopImpossible()
      void this.call("/process/unfollow", subscription).catch(() => undefined)
    }

    void this.call("/process/follow", subscription, observation).catch(error => {
      if (!active) return
      stop()
      impossible?.(exception(error))
    })

    return stop
  }

  /** Stream one Program command through the live LinkManager connection. */
  public command(operation: "install" | "uninstall" | "run", subject: ProgramAddress, value: unknown, signal?: AbortSignal) {
    const stream = randomUUID()
    const queue: CommandEvent[] = []
    let wake: (() => void) | null = null
    let ended = false
    let failure: Error | null = null
    const stopOutput = this.connection.subscribe("/auth/program/command-output", (received, output) => {
      if (received !== stream || ended) return
      if (!record(output)) failure = new Error("The System returned an invalid Program command event")
      else if (queue.length >= maximumStreamQueue) failure = new Error(`System stream queue exceeded its capacity of ${maximumStreamQueue}`)
      else queue.push(output as CommandEvent)
      wake?.()
      wake = null
    })
    const cancel = () => { void this.call("/program/command-cancel", stream).catch(() => undefined) }
    const abort = () => {
      failure = abortReason(signal!)
      cancel()
      wake?.()
      wake = null
    }

    if (signal?.aborted) {
      failure = abortReason(signal)
      ended = true
    } else signal?.addEventListener("abort", abort, { once: true })

    const running = ended
      ? Promise.resolve()
      : this.call("/program/command", stream, operation, subject, value, "").then(
        () => { ended = true; wake?.(); wake = null },
        error => { failure = signal?.aborted ? abortReason(signal) : exception(error); ended = true; wake?.(); wake = null }
      )

    return (async function* () {
      try {
        while (true) {
          if (queue.length) {
            yield queue.shift()!
            continue
          }
          if (failure) throw failure
          if (ended) return
          await new Promise<void>(resolve => { wake = resolve })
        }
      } finally {
        stopOutput()
        signal?.removeEventListener("abort", abort)
        if (!ended) cancel()
        await running.catch(() => undefined)
      }
    })()
  }

  private followModel(appearance: string) {
    const subscribe = (event: string, listener: Listener) => this.release.push(this.connection.subscribe(event, listener))

    subscribe(`property-update:${appearance}`, value => {
      this.appearance = value as Appearance
      this.emit("appearance", this.appearance)
    })

    subscribe("/auth/program/create", value => this.arriveProgram("create", value))
    subscribe("/auth/program/install", value => this.arriveProgram("install", value))
    subscribe("/auth/program/uninstall", (value, everything) => this.uninstallProgram(value, everything === true))
    subscribe("/auth/program/forget", value => this.forgetProgram(value))

    subscribe("/auth/process/created", value => this.createProcess(value))
    subscribe("/auth/process/server-ready", identity => this.serverReady(identity))
    subscribe("/auth/process/server-start", (identity, value) => this.changeEndpoint(identity, "server", value))
    subscribe("/auth/process/server-stop", (identity, value) => this.changeEndpoint(identity, "server", value, false))
    subscribe("/auth/process/client-start", (identity, value) => this.changeEndpoint(identity, "client", value))
    subscribe("/auth/process/client-stop", (identity, value) => this.changeEndpoint(identity, "client", value, false))
    subscribe("/auth/process/client-access", (identity, value) => this.changeEndpoint(identity, "client", value))
    subscribe("/auth/process/exited", (value, code, signal) => this.exitProcess(value, code, signal))

    for (const event of ["move", "resize", "geometry", "change-title", "raise", "minimize"] as const) {
      subscribe(`/auth/process/${event}`, value => this.changeWindow(event, value))
    }
  }

  private arriveProgram(event: "create" | "install", value: unknown) {
    const program = programState(value)
    this.programs.set(program.identity, program)
    this.emit(`program:${program.reference}:change`, program)
    this.emit(`program:${event}`, program)
  }

  private uninstallProgram(value: unknown, everything: boolean) {
    const program = programState(value)
    this.programs.set(program.identity, program)
    this.emit(`program:${program.reference}:change`, program)
    this.emit(`program:${program.reference}:uninstall`, everything)
    this.emit("program:uninstall", program, everything)
  }

  private forgetProgram(value: unknown) {
    if (typeof value !== "string") return
    const program = this.programs.get(value)
    if (!program) return
    this.programs.delete(value)
    this.emit(`program:${program.reference}:forget`)
    this.emit("program:forget", program)
  }

  private createProcess(value: unknown) {
    const process = processState(value)
    this.processes.set(process.identity, process)
    this.emit("process:create", process)
    this.emit(`program:${process.program}:process:create`, process)
  }

  private serverReady(value: unknown) {
    if (typeof value !== "string") return
    const process = this.processes.get(value)
    if (!process?.server) return
    process.server.ready = true
    this.emit(`endpoint:${process.reference}:server:ready`)
  }

  private changeEndpoint(identity: unknown, endpoint: "server" | "client", value: unknown, running = true) {
    if (typeof identity !== "string") return
    const current = this.processes.get(identity)
    if (!current) return
    const incoming = processState(value)

    current.server = incoming.server
    current.client = incoming.client
    this.emit(`endpoint:${current.reference}:${endpoint}:${running ? "start" : "stop"}`)
    this.emit(`process:${current.reference}:change`, current)
  }

  private exitProcess(value: unknown, code: unknown, signal: unknown) {
    const received = processState(value)
    const process = this.processes.get(received.identity) ?? received
    this.processes.delete(process.identity)
    const exit = {
      status: typeof signal === "string" ? "signaled" as const : "exited" as const,
      code: typeof code === "number" ? code : null,
      signal: typeof signal === "string" ? signal : null
    }
    this.emit(`process:${process.reference}:exit`, exit)
    this.emit("process:exit", process, exit)
    this.emit(`program:${process.program}:process:exit`, process, exit)
  }

  private changeWindow(event: string, value: unknown) {
    if (!record(value) || typeof value.identity !== "string" || !record(value.window)) return
    const process = this.processes.get(value.identity)
    if (!process?.client) return
    process.client.window = windowState(value.window)
    this.emit(`window:${process.identity}:${camel(event)}`, windowMessage(event, process))
    this.emit(`process:${process.reference}:change`, process)
  }

  private emit(event: string, ...values: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...values)
  }
}

export type ProgramAddress = Readonly<{ identity: string, reference: string }>

function ownerSession(value: unknown) {
  if (!record(value) || typeof value.authorization !== "string") throw new Error("The System Gateway returned an invalid owner session")
  const linkManager = value.linkManager
  const authManager = value.authManager
  if (!record(linkManager) || !record(linkManager.appearance) || typeof linkManager.appearance.key !== "string") throw new Error("The System Gateway returned invalid Appearance state")
  if (!record(authManager) || !record(authManager.programManager) || !record(authManager.processManager)) throw new Error("The System Gateway returned an invalid System state")
  const programs = authManager.programManager.programs
  const processes = authManager.processManager.processes
  if (!Array.isArray(programs) || !Array.isArray(processes)) throw new Error("The System Gateway returned invalid domain collections")

  return {
    authorization: value.authorization,
    linkManager: { appearance: { key: linkManager.appearance.key, value: linkManager.appearance.value as Appearance } },
    authManager: {
      programManager: { programs: programs as [string, unknown][] },
      processManager: { processes: processes as [string, unknown][] }
    }
  }
}

function programState(value: unknown): ProgramState {
  if (!record(value) || typeof value.reference !== "string" || typeof value.identity !== "string" || typeof value.assetId !== "string" || typeof value.name !== "string") {
    throw new Error("The System returned an invalid Program")
  }

  return {
    reference: value.reference,
    identity: value.identity,
    assetId: value.assetId,
    installed: value.installed === true,
    name: value.name,
    version: typeof value.version === "string" ? value.version : null,
    description: typeof value.description === "string" ? value.description : null,
    hasAgent: value.hasAgent === true,
    server: value.server as EndpointDeclaration | null,
    client: value.client as ClientDeclaration | null
  }
}

function processState(value: unknown): ProcessState {
  if (!record(value) || typeof value.reference !== "string" || typeof value.identity !== "string" || typeof value.program !== "string" || !record(value.options)) {
    throw new Error("The System returned an invalid Process")
  }

  const startedAt = value.startedAt instanceof Date ? value.startedAt : new Date(String(value.startedAt))
  if (Number.isNaN(startedAt.getTime())) throw new Error("The System returned an invalid Process start time")

  return {
    reference: value.reference,
    identity: value.identity,
    name: typeof value.name === "string" ? value.name : null,
    program: value.program,
    parent: address(value.parent),
    options: value.options as Record<string, string>,
    startedAt,
    server: record(value.server) ? { ready: value.server.ready === true, service: value.server.service === true } : null,
    client: record(value.client) ? {
      service: value.client.service === true,
      sameOrigin: value.client.sameOrigin === true,
      window: windowState(value.client.window)
    } : null
  }
}

function windowState(value: unknown): WindowState {
  if (!record(value) || typeof value.title !== "string" || typeof value.location !== "string" || typeof value.depth !== "number" || typeof value.minimized !== "boolean") {
    throw new Error("The System returned an invalid Window")
  }
  return {
    title: value.title,
    position: value.position as WindowState["position"],
    size: value.size as WindowState["size"],
    depth: value.depth,
    minimized: value.minimized,
    layer: value.layer as WindowLayer,
    location: value.location
  }
}

function address(value: unknown): ProcessAddress | null {
  if (!record(value) || typeof value.reference !== "string" || typeof value.identity !== "string") return null
  return { reference: value.reference, identity: value.identity }
}

function windowMessage(event: string, process: ProcessState) {
  const window = process.client!.window
  if (event === "move") return window.position
  if (event === "resize") return window.size
  if (event === "geometry") return { position: window.position, size: window.size }
  if (event === "change-title") return window.title
  if (event === "minimize") return window.minimized
  return true
}

function camel(value: string) { return value === "change-title" ? "changeTitle" : value }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function exception(error: unknown) { return error instanceof Error ? error : new Error(String(error)) }
function abortReason(signal: AbortSignal) { return signal.reason instanceof Error ? signal.reason : new Error("The operation was cancelled") }
