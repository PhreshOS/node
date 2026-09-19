import { randomUUID } from "node:crypto"
import {
  parseConnectionSnapshot,
  parseProgramSnapshot,
  parseAppearance,
  parseWindowFrame,
  parseWindowTransaction,
  parseSessionSnapshot,
  parseSessionEndSnapshot,
  type Appearance,
  type ProcessSnapshot,
  type ProgramSnapshot,
  type ServiceKey,
  type WindowLayer,
  type WindowState as CoreWindowState
} from "@phreshos/core"
import type { GatewayConnection } from "./transport.js"

export type ProgramState = ProgramSnapshot & Readonly<{ installed: boolean }>

export type WindowState = Omit<CoreWindowState, "front"> & Readonly<{ depth: number }>

export interface ProcessIdentityState {
  reference: string
  identity: string
  name: string | null
  program: string
  options: ProcessSnapshot["options"]
  startedAt: Date
}

export interface ProcessState extends ProcessIdentityState {
  serverEndpoint: boolean
  server: { ready: boolean, service: boolean } | null
  client: { service: boolean, sameOrigin: boolean } | null
  clientEndpoint: { window: WindowState } | null
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
  public readonly programs = new Map<string, ProgramState>()
  public readonly processes = new Map<string, ProcessState>()
  public appearance: Appearance

  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly release: (() => void)[] = []

  public constructor(private readonly connection: GatewayConnection) {
    const snapshot = ownerSystem(connection.snapshot)

    this.appearance = parseAppearance(snapshot.linkManager.appearance.value)

    for (const [, value] of snapshot.authManager.programManager.programs) {
      const program = programState(value)
      this.programs.set(program.identity, program)
    }

    for (const [, value] of snapshot.authManager.processManager.processes) {
      const process = processState(value)
      this.processes.set(process.identity, process)
    }

    this.followModel(snapshot.linkManager.appearance.key)
  }

  public activate() { this.connection.activate() }

  public close() {
    for (const stop of this.release.splice(0)) stop()
    this.listeners.clear()
  }

  public call<Result = unknown>(event: string, ...values: unknown[]) {
    return this.connection.call<Result>(`/auth${event}`, ...values)
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
      this.appearance = parseAppearance(value)
      this.emit("appearance", this.appearance)
    })

    subscribe("/auth/program/create", value => this.arriveProgram("create", value))
    subscribe("/auth/program/install", value => this.arriveProgram("install", value))
    subscribe("/auth/program/uninstall", (value, purge) => this.uninstallProgram(value, purge === true))
    subscribe("/auth/program/forget", value => this.forgetProgram(value))

    subscribe("/auth/process/created", value => this.createProcess(value))
    subscribe("/auth/process/server-ready", identity => this.serverReady(identity))
    subscribe("/auth/process/server-start", (identity, value) => this.changeEndpoint(identity, "server", value))
    subscribe("/auth/process/server-stop", (identity, value) => this.changeEndpoint(identity, "server", value, false))
    subscribe("/auth/process/client-start", (identity, value) => this.changeEndpoint(identity, "client", value))
    subscribe("/auth/process/client-stop", (identity, value) => this.changeEndpoint(identity, "client", value, false))
    subscribe("/auth/process/client-access", (identity, value) => this.changeEndpoint(identity, "client", value))
    subscribe("/auth/process/exited", (value, code, signal) => this.exitProcess(value, code, signal))

    subscribe("/auth/connection/create", value => this.connectionEvent("create", value))
    subscribe("/auth/connection/disconnect", value => this.connectionEvent("disconnect", value))
    subscribe("/auth/connection/session-change", (connection, session) => {
      const parsed = parseConnectionSnapshot(connection)
      this.emit(`connection:${parsed.identity}:sessionChange`, session === null ? null : parseSessionSnapshot(session))
    })
    subscribe("/auth/session/create", value => this.sessionEvent("create", value))
    subscribe("/auth/session/connection-attach", (session, connection) => {
      const parsed = parseSessionSnapshot(session)
      this.emit(`session:${parsed.identity}:connectionAttach`, parseConnectionSnapshot(connection))
    })
    subscribe("/auth/session/connection-detach", (session, connection) => {
      const parsed = parseSessionSnapshot(session)
      this.emit(`session:${parsed.identity}:connectionDetach`, parseConnectionSnapshot(connection))
    })
    subscribe("/auth/session/end", (session, reason) => {
      const parsed = parseSessionEndSnapshot({ ...(session as object), reason })
      this.emit(`session:${parsed.identity}:end`, parsed.reason)
      this.emit("session:end", parsed, parsed.reason)
    })

    for (const event of ["move", "resize", "geometry", "change-title", "change-header", "change-frame", "change-opening-transaction", "raise", "minimize", "maximize"] as const) {
      subscribe(`/auth/process/${event}`, value => this.changeWindow(event, value))
    }
  }

  private connectionEvent(event: "create" | "disconnect", value: unknown) {
    const connection = parseConnectionSnapshot(value)
    this.emit(`connection:${connection.identity}:${event}`)
    this.emit(`connection:${event}`, connection)
  }

  private sessionEvent(event: "create", value: unknown) {
    const session = parseSessionSnapshot(value)
    this.emit(`session:${session.identity}:${event}`)
    this.emit(`session:${event}`, session)
  }

  private arriveProgram(event: "create" | "install", value: unknown) {
    const program = programState(value)
    this.programs.set(program.identity, program)
    this.emit(`program:${program.reference}:change`, program)
    this.emit(`program:${event}`, program)
  }

  private uninstallProgram(value: unknown, purge: boolean) {
    const program = programState(value)
    this.programs.set(program.identity, program)
    this.emit(`program:${program.reference}:change`, program)
    this.emit(`program:${program.reference}:uninstall`, purge)
    this.emit("program:uninstall", program, purge)
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
    const program = this.programs.get(process.program)
    if (program) this.emit(`program:${program.reference}:processCreate`, process)
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
    current.clientEndpoint = incoming.clientEndpoint
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
    const program = this.programs.get(process.program)
    if (program) this.emit(`program:${program.reference}:processExit`, process, exit)
  }

  private changeWindow(event: string, value: unknown) {
    if (!record(value) || typeof value.identity !== "string" || !record(value.window)) return
    const process = this.processes.get(value.identity)
    if (!process?.clientEndpoint) return
    process.clientEndpoint.window = windowState(value.window)
    if (event !== "change-opening-transaction") this.emit(`window:${process.identity}:${camel(event)}`, windowMessage(event, process))
    this.emit(`process:${process.reference}:change`, process)
  }

  private emit(event: string, ...values: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...values)
  }
}

export type ProgramAddress = Readonly<{ identity: string, reference: string }>

function ownerSystem(value: unknown) {
  if (!record(value)) throw new Error("The System Gateway returned an invalid System snapshot")
  const linkManager = value.linkManager
  const authManager = value.authManager
  if (!record(linkManager) || !record(linkManager.appearance) || typeof linkManager.appearance.key !== "string") throw new Error("The System Gateway returned invalid Appearance state")
  if (!record(authManager) || !record(authManager.programManager) || !record(authManager.processManager)) throw new Error("The System Gateway returned an invalid System state")
  const programs = authManager.programManager.programs
  const processes = authManager.processManager.processes
  if (!Array.isArray(programs) || !Array.isArray(processes)) throw new Error("The System Gateway returned invalid domain collections")

  return {
    linkManager: { appearance: { key: linkManager.appearance.key, value: linkManager.appearance.value } },
    authManager: {
      programManager: { programs: programs as [string, unknown][] },
      processManager: { processes: processes as [string, unknown][] }
    }
  }
}

function programState(value: unknown): ProgramState {
  const parsed = parseProgramSnapshot(value)
  if (parsed.installed === undefined) throw new Error("The System returned a Program without installation state")

  return { ...parsed, installed: parsed.installed }

}

function processState(value: unknown): ProcessState {
  const identity = processIdentityState(value)
  const source = value as Record<string, unknown>

  return {
    ...identity,
    server: record(source.server) ? { ready: source.server.ready === true, service: source.server.service === true } : null,
    serverEndpoint: source.serverEndpoint === true,
    client: record(source.client) ? {
      service: source.client.service === true,
      sameOrigin: source.client.sameOrigin === true
    } : null,
    clientEndpoint: source.clientEndpoint === null
      ? null
      : { window: windowState((source.clientEndpoint as Record<string, unknown>).window) }
  }
}

/** Read the immutable facts needed to retain one Process handle. */
export function processIdentityState(value: unknown): ProcessIdentityState {
  if (!record(value) || typeof value.reference !== "string" || typeof value.identity !== "string" || !record(value.options)) {
    throw new Error("The System returned an invalid Process")
  }

  const program = typeof value.program === "string"
    ? value.program
    : record(value.program) && typeof value.program.identity === "string"
      ? value.program.identity
      : null
  const startedAt = value.startedAt instanceof Date ? value.startedAt : new Date(String(value.startedAt))

  if (program === null) throw new Error("The System returned an invalid Process owner")
  if (Number.isNaN(startedAt.getTime())) throw new Error("The System returned an invalid Process start time")

  return {
    reference: value.reference,
    identity: value.identity,
    name: typeof value.name === "string" ? value.name : null,
    program,
    options: value.options as Record<string, string>,
    startedAt
  }
}

function windowState(value: unknown): WindowState {
  if (!record(value) || typeof value.title !== "string" || typeof value.header !== "boolean" || typeof value.depth !== "number" || typeof value.minimized !== "boolean" || typeof value.maximized !== "boolean") {
    throw new Error("The System returned an invalid Window")
  }
  return {
    title: value.title,
    header: value.header,
    frame: parseWindowFrame(value.frame),
    transaction: parseWindowTransaction(value.transaction),
    position: value.position as WindowState["position"],
    size: value.size as WindowState["size"],
    depth: value.depth,
    minimized: value.minimized,
    maximized: value.maximized,
    layer: value.layer as WindowLayer
  }
}

function windowMessage(event: string, process: ProcessState) {
  const window = process.clientEndpoint!.window
  if (event === "move") return window.position
  if (event === "resize") return window.size
  if (event === "geometry") return { position: window.position, size: window.size }
  if (event === "change-title") return window.title
  if (event === "change-header") return window.header
  if (event === "change-frame") return window.frame
  if (event === "minimize") return window.minimized
  if (event === "maximize") return window.maximized
  return true
}

function camel(value: string) {
  if (value === "change-title") return "changeTitle"
  if (value === "change-header") return "changeHeader"
  if (value === "change-frame") return "changeFrame"
  return value
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function exception(error: unknown) { return error instanceof Error ? error : new Error(String(error)) }
function abortReason(signal: AbortSignal) { return signal.reason instanceof Error ? signal.reason : new Error("The operation was cancelled") }
