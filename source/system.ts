import {
  Client as CoreClient,
  ClientService as CoreClientService,
  Endpoint as CoreEndpoint,
  Process as CoreProcess,
  Program as CoreProgram,
  Server as CoreServer,
  ServerService as CoreServerService,
  isServiceKey,
  type Appearance,
  type ClientDeclaration,
  type EndpointLifecycle,
  type EndpointLifecycleEvents,
  type EndpointDeclaration,
  type Launch,
  type ClientLaunch,
  type ServerLaunch,
  type Position,
  type ProgramDefinition,
  type ProgramEvents,
  type ProgramCommandChunk,
  type ProgramIconSize,
  type ProgramProcessEvents,
  type ProgramSql,
  type ProgramStore,
  type ProcessEvents,
  type ServiceKey,
  type Size,
  type System as CoreSystem,
  type SystemClientEntity,
  type SystemEndpointEntity,
  type SystemProcessEntity,
  type SystemProcessEvents,
  type SystemProcess,
  type SystemProcessRunEvent,
  type SystemProcessRunOptions,
  type SystemProgram,
  type SystemProgramEntity,
  type SystemProgramEvents,
  type SystemServerEntity,
  type SystemUploads,
  type SystemStorage,
  type WritableAppearance,
  type Window,
  type WindowEvents,
  type WindowGeometry
} from "@phreshos/core"
import type { Socket } from "node:net"
import { homedir } from "node:os"
import { gatewayAddress } from "./address.js"
import Events from "./events.js"
import HandleRegistry from "./handle-registry.js"
import { resolveHome } from "./home.js"
import { filesystemStorage, nativeStorage } from "./storage.js"
import { programPermissions, programSql, programStore } from "./program-resources.js"
import { EndpointTrafficHandle, ServerTrafficHandle } from "./traffic.js"
import { openConnection, request, streamProgram, type TransportEvent } from "./transport.js"
import Uploads from "./uploads.js"

export type ProgramProcessRunOptions = SystemProcessRunOptions
export type ProgramProcessRunEvent = SystemProcessRunEvent

type ServiceEndpoint = ServiceKey["endpoint"]

type ServiceAddress<Endpoint extends ServiceEndpoint> = Omit<ServiceKey, "endpoint"> & Readonly<{
  endpoint: Endpoint
}>

type ServiceHandle<Endpoint extends ServiceEndpoint, EventsMap extends object, Fallback = unknown> = Endpoint extends "server"
  ? ServerService<EventsMap, Fallback>
  : ClientService<EventsMap, Fallback>

interface SystemTransport {
  control(request: object, signal?: AbortSignal): Promise<unknown>
  api(request: object, signal?: AbortSignal): Promise<unknown>
  lifecycle(request: object, signal?: AbortSignal): AsyncGenerator<TransportEvent, void, void>
}

interface SystemState {
  readonly address: string
  readonly connection: Socket
  readonly handles: HandleRegistry
  readonly lifetime: AbortController
  readonly transport: SystemTransport
  closed: boolean
}

const systems = new WeakMap<System, SystemState>()

const ProgramBase = CoreProgram as unknown as new () => object
const ProcessBase = CoreProcess as unknown as new () => object
const ServerBase = CoreServer as unknown as new () => object
const ClientBase = CoreClient as unknown as new () => object

/** One connected owner-local implementation of the shared System contract. */
export class System implements CoreSystem {
  public readonly storage = nativeStorage(homedir(), "the native filesystem")
  public readonly appearance: WritableAppearance
  public readonly program: SystemProgram
  public readonly process: SystemProcess
  public readonly uploads: SystemUploads

  public fetch(input: RequestInfo | URL, init?: RequestInit) {
    return fetch(input, init)
  }

  private constructor(address: string, connection: Socket) {
    const lifetime = new AbortController()
    const handles = new HandleRegistry()
    const transport: SystemTransport = {
      control: (value, signal) => request(address, "system", value, connectedSignal(this, signal)),
      api: (value, signal) => request(address, "api", value, connectedSignal(this, signal)),
      lifecycle: (value, signal) => streamProgram(address, value, connectedSignal(this, signal))
    }

    systems.set(this, { address, connection, handles, lifetime, transport, closed: false })
    this.appearance = new SystemAppearance(transport)
    this.program = new ProgramRegistry(this)
    this.process = new ProcessRegistry(this)
    this.uploads = new Uploads(value => transport.api(value))
  }

  /** Connect to the System selected by argument, environment, or owner default. */
  public static async connect(home?: string) {
    const resolved = resolveHome(home)
    const address = gatewayAddress(resolved)
    return new System(address, await openConnection(address))
  }

  /** Atomically replace one runtime Program without touching its installed form. */
  public async forceCreateProgram(source: ProgramDefinition | string): Promise<SystemProgramEntity> {
    requireConnected(this)
    for await (const event of transport(this).lifecycle({ word: "force-create", program: source })) {
      if (event.event === "created") return programHandle(this, required(event.program as ProgramSnapshot | undefined))
    }
    throw new Error("The System did not confirm the created Program")
  }

  /** Close this owner connection and abort every attached operation it owns. */
  public async disconnect() {
    const state = systemState(this)
    if (state.closed) return
    state.closed = true
    state.lifetime.abort(new Error("This System connection is closed"))
    state.connection.destroy()
    state.handles.clear()
  }

  public service<Endpoint extends ServiceEndpoint>(key: ServiceAddress<Endpoint>): ServiceHandle<Endpoint, {}>
  public service<EventsMap extends object = {}, Fallback = unknown>(key: ServiceAddress<"server">): ServerService<EventsMap, Fallback>
  public service<EventsMap extends object = {}, Fallback = unknown>(key: ServiceAddress<"client">): ClientService<EventsMap, Fallback>
  public service(key: ServiceKey): unknown {
    requireConnected(this)
    if (!isServiceKey(key)) throw new Error("A complete service key is required")

    const normalized = Object.freeze({
      ...(key.program === undefined ? {} : { program: key.program }),
      process: key.process,
      endpoint: key.endpoint
    })
    const identity = JSON.stringify([key.program ?? null, key.process, key.endpoint])

    return systemState(this).handles.obtain(`service:${identity}`, () => normalized.endpoint === "server"
      ? new ServerServiceHandle(this, normalized as ServiceKey & { endpoint: "server" })
      : new ClientServiceHandle(this, normalized as ServiceKey & { endpoint: "client" }))
  }
}

function systemState(system: System) {
  const state = systems.get(system)
  if (!state) throw new Error("Unknown System connection")
  return state
}

function requireConnected(system: System) {
  if (systemState(system).closed) throw new Error("This System connection is closed")
}

function connectedSignal(system: System, signal?: AbortSignal) {
  const lifetime = systemState(system).lifetime.signal
  requireConnected(system)
  return signal ? AbortSignal.any([signal, lifetime]) : lifetime
}

function transport(system: System) {
  requireConnected(system)
  return systemState(system).transport
}

function programHandle(system: System, snapshot: ProgramSnapshot) {
  const handle = systemState(system).handles.obtain(`program:${snapshot.reference}`, () => new ProgramHandle(system, snapshot))
  handle.update(snapshot)
  return handle
}

function processHandle(system: System, snapshot: ProcessSnapshot) {
  return systemState(system).handles.obtain(`process:${snapshot.reference}`, () => new ProcessHandle(system, snapshot))
}

class SystemAppearance extends Events<{ change: Appearance }> {
  public constructor(private readonly transport: SystemTransport) {
    super(["change"], (_event, signal) => transport.api({ capability: "appearance", operation: "wait" }, signal))
  }

  public async snapshot() {
    return await this.transport.api({ capability: "appearance", operation: "snapshot" }) as Appearance
  }

  public async update(appearance: Appearance) {
    await this.transport.api({ capability: "appearance", operation: "update", value: appearance })
  }
}

class ProgramRegistry extends Events<SystemProgramEvents> {
  public constructor(private readonly system: System) {
    super(["create", "forget", "install", "uninstall"], (event, signal, timeout) => (
      transport(system).control({ capability: "program", operation: "wait", input: { event, timeout } }, signal)
        .then(value => this.event(value))
    ))
  }

  public async list(onlyInstalled = false) {
    const programs: ProgramHandle[] = []
    let offset = 0

    while (true) {
      const page = await transport(this.system).control({
        capability: "program",
        operation: "list",
        input: { installedOnly: onlyInstalled, limit: 100, offset }
      }) as Page<ProgramSnapshot>

      programs.push(...page.data.map(snapshot => programHandle(this.system, snapshot)))
      offset += page.data.length
      if (!page.truncated || !page.data.length) return programs
    }
  }

  public async find(identity: string) {
    try {
      const snapshot = await transport(this.system).control({ capability: "program", operation: "inspect", input: { program: identity } }) as ProgramSnapshot
      return programHandle(this.system, snapshot)
    } catch (error) {
      if (unknown(error, "Program")) return null
      throw error
    }
  }

  public async create(source: ProgramDefinition | string) {
    for await (const event of transport(this.system).lifecycle({ word: "create", program: source })) {
      if (event.event === "created") return programHandle(this.system, required(event.program as ProgramSnapshot | undefined))
    }
    throw new Error("The System did not confirm the created Program")
  }

  private async event(value: unknown) {
    const waited = value as { event?: string, payload?: unknown }
    if (waited.event === "uninstall") {
      const payload = waited.payload as { program?: ProgramSnapshot, everything?: boolean }
      return { program: programHandle(this.system, required(payload.program)), everything: payload.everything === true }
    }
    return programHandle(this.system, required(waited.payload as ProgramSnapshot | undefined))
  }
}

interface ProgramHandle extends SystemProgramEntity {}

class ProgramHandle extends ProgramBase {
  private readonly reference: string
  public readonly identity: string
  public readonly data: SystemStorage
  public readonly cache: SystemStorage
  public readonly store: ProgramStore
  public readonly logs: ProgramSql
  public readonly database: ProgramSql
  public readonly process: ProgramProcesses
  public readonly startup: ProgramStartup
  public readonly permissions
  private snapshot: ProgramSnapshot

  public constructor(private readonly system: System, snapshot: ProgramSnapshot) {
    super()
    this.snapshot = snapshot
    this.reference = snapshot.reference
    this.identity = snapshot.identity
    const address = this.address()
    bindEvents(this, new Events<ProgramEvents>(["forget", "uninstall"], (event, signal, timeout) => transport(system).api({
      capability: "program", operation: "wait", handle: address, event, timeout
    }, signal)))
    const request = (value: object) => transport(system).api(value)
    this.data = filesystemStorage(() => programStoragePath(system, address, "data"), `Program "${this.identity}" data`)
    this.cache = filesystemStorage(() => programStoragePath(system, address, "cache"), `Program "${this.identity}" cache`)
    this.store = programStore(request, address)
    this.logs = programSql(request, address, "logs")
    this.database = programSql(request, address, "database")
    this.process = new ProgramProcesses(system, this)
    this.startup = new ProgramStartup(system, this)
    this.permissions = programPermissions(request, address)
  }

  public get name() { return this.snapshot.name }
  public get version() { return this.snapshot.version }
  public get description() { return this.snapshot.description }
  public get hasAgent() { return this.snapshot.hasAgent }
  public get server(): EndpointDeclaration | null {
    return this.snapshot.server ? Object.freeze({
      start: this.snapshot.server.start,
      service: this.snapshot.server.service
    }) : null
  }
  public get client(): ClientDeclaration | null {
    return this.snapshot.client ? Object.freeze({
      start: this.snapshot.client.start,
      service: this.snapshot.client.service,
      title: this.snapshot.client.title,
      size: this.snapshot.client.size,
      position: this.snapshot.client.position,
      layer: this.snapshot.client.layer,
      minimize: this.snapshot.client.minimize,
      permissions: Object.freeze(Object.fromEntries(Object.entries(this.snapshot.client.permissions).map(([name, values]) => [name, Object.freeze([...values])])))
    }) : null
  }

  public update(snapshot: ProgramSnapshot) {
    if (snapshot.reference !== this.reference) throw new Error("A Program handle cannot become another Program")
    this.snapshot = snapshot
  }

  public async icon(size: ProgramIconSize = "medium") {
    const value = await transport(this.system).api({ capability: "program", operation: "icon", handle: this.address(), size })
    if (!Array.isArray(value) || value.some(byte => typeof byte !== "number")) throw new Error("The System returned an invalid Program icon")
    return new Blob([Uint8Array.from(value)], { type: "image/png" })
  }

  public async agent() {
    if (!this.hasAgent) return null
    const value = await transport(this.system).api({ capability: "program", operation: "agent", handle: this.address() })
    return typeof value === "string" ? value : null
  }

  public async installed() {
    for await (const event of transport(this.system).lifecycle({ word: "installed", handle: this.address() })) {
      if (event.event === "installedState") return event.installed === true
    }
    throw new Error("The System returned no Program installation state")
  }

  public install() { return command(this.system, { word: "install-existing", handle: this.address() }) }
  public uninstall(everything = false) { return command(this.system, { word: "uninstall-existing", handle: this.address(), everything }) }

  public async fork(identity: string) {
    for await (const event of transport(this.system).lifecycle({ word: "fork", handle: this.address(), identity })) {
      if (event.event === "created") return programHandle(this.system, required(event.program as ProgramSnapshot | undefined))
    }
    throw new Error("The System did not confirm the forked Program")
  }

  public async forget() {
    for await (const _event of transport(this.system).lifecycle({ word: "forget", handle: this.address() })) { /* consume completion */ }
  }

  public address() { return Object.freeze({ identity: this.identity, reference: this.reference }) }
}

class ProgramStartup {
  public constructor(private readonly system: System, private readonly program: ProgramHandle) {}

  public async get() {
    for await (const event of transport(this.system).lifecycle({
      word: "startup", handle: this.program.address(), operation: "get"
    })) {
      if (event.event === "startup") return event.launch as Launch | null
    }
    throw new Error("The System returned no Program startup state")
  }

  public async enable(launch: Launch = {}) {
    await this.change("enable", launch)
  }

  public async disable() {
    await this.change("disable")
  }

  private async change(operation: "enable" | "disable", launch?: Launch) {
    for await (const event of transport(this.system).lifecycle({
      word: "startup", handle: this.program.address(), operation, launch
    })) {
      if (event.event === "startup") return
    }
    throw new Error("The System did not confirm the Program startup change")
  }
}

class ProgramProcesses extends Events<ProgramProcessEvents> {
  public constructor(private readonly system: System, private readonly program: ProgramHandle) {
    super(["create", "exit"], (event, signal, timeout) => transport(system).api({
      capability: "programProcess", operation: "wait", handle: program.address(), event, timeout
    }, signal).then(value => programProcessEvent(system, event, value)))
  }

  public async list() {
    const value = await transport(this.system).api({ capability: "programProcess", operation: "list", handle: this.program.address() })
    if (!Array.isArray(value)) throw new Error("The System returned an invalid Program Process list")
    return value.map(snapshot => processHandle(this.system, snapshot as ProcessSnapshot))
  }
  public async first() { return (await this.list()).sort(chronological)[0] ?? null }
  public async last() { return (await this.list()).sort(chronological).at(-1) ?? null }

  public async find(identityOrName: string) {
    const found = (await this.list()).find(process => process.identity === identityOrName || process.name === identityOrName)
    return found ?? null
  }

  public create(launch: Launch = {}) { return this.createExact("create-process", launch) }

  public async *run(launch: Launch = {}, options: ProgramProcessRunOptions = {}): AsyncGenerator<ProgramProcessRunEvent, void, void> {
    let process: ProcessHandle | null = null

    for await (const event of transport(this.system).lifecycle({
      word: "run-process",
      handle: this.program.address(),
      launch
    }, options.signal)) {
      if (event.event === "started") {
        process = processHandle(this.system, required(event.process as ProcessSnapshot | undefined))
        yield Object.freeze({ event: "started", process })
      } else if (event.event === "output") {
        if ((event.stream !== "stdout" && event.stream !== "stderr") || typeof event.text !== "string") {
          throw new Error("The System returned an invalid Process output event")
        }
        yield Object.freeze({
          event: "output",
          stream: event.stream,
          text: event.text
        })
      } else if (event.event === "exited") {
        if (!process) throw new Error("The System ended a Process before confirming its start")
        const value = event.exit as { status?: unknown, code?: unknown, signal?: unknown } | undefined
        if (!value
          || (value.status !== "exited" && value.status !== "signaled")
          || (value.code !== null && typeof value.code !== "number")
          || (value.signal !== null && typeof value.signal !== "string")) {
          throw new Error("The System returned an invalid Process exit event")
        }
        const exit = Object.freeze({
          status: value.status,
          code: value.code,
          signal: value.signal
        })
        yield Object.freeze({ event: "exited", process, exit })
      } else throw new Error("The System returned an unknown Process run event")
    }
  }
  public findOrCreate(launch: Launch & { name: string }) { return this.createExact("find-or-create-process", launch) }

  public async exitAll() {
    const processes = await this.list()
    await Promise.all(processes.map(process => process.exit()))
    return processes.map(process => process.identity)
  }

  private async createExact(word: "create-process" | "find-or-create-process", launch: Launch) {
    for await (const event of transport(this.system).lifecycle({ word, handle: this.program.address(), launch })) {
      if (event.event === "createdProcess") return processHandle(this.system, required(event.process as ProcessSnapshot | undefined))
    }
    throw new Error("The System did not confirm the created Process")
  }
}

class ProcessRegistry extends Events<SystemProcessEvents> {
  public constructor(private readonly system: System) {
    super(["create", "exit"], (event, signal, timeout) => transport(system).control({
      capability: "process", operation: "wait", input: { event, timeout }
    }, signal).then(value => processEvent(system, value)))
  }

  public list() { return listProcesses(this.system) }

  public async find(identity: string) {
    try {
      const snapshot = await transport(this.system).control({ capability: "process", operation: "inspect", input: { process: identity } }) as ProcessSnapshot
      return processHandle(this.system, snapshot)
    } catch (error) {
      if (unknown(error, "Process")) return null
      throw error
    }
  }
}

interface ProcessHandle extends SystemProcessEntity {}

class ProcessHandle extends ProcessBase {
  public readonly identity: string
  public readonly name: string | null
  public readonly startedAt: Date
  public readonly server: ServerEndpoint
  public readonly client: ClientEndpoint

  public constructor(private readonly system: System, private readonly snapshot: ProcessSnapshot) {
    super()
    bindEvents(this, new Events<ProcessEvents>(["exit"], (event, signal, timeout) => transport(system).control({
      capability: "process", operation: "wait", input: { process: snapshot.identity, event, timeout }
    }, signal).then(exactProcessEvent)))
    this.identity = snapshot.identity
    this.name = snapshot.name
    this.startedAt = new Date(snapshot.startedAt)
    this.server = new ServerEndpoint(system, this)
    this.client = new ClientEndpoint(system, this)
  }

  public program() { return programHandle(this.system, required(this.snapshot.programSnapshot, this.snapshot.program)) }

  public async parent() {
    if (!await this.exists()) throw new Error(`Process "${this.identity}" no longer exists`)
    if (this.snapshot.parent === null) return null
    const parent = await this.system.process.find(this.snapshot.parent)
    if (!parent) throw new Error("The parent Process no longer exists")
    return parent
  }

  public async option(name: string) { return this.snapshot.options[name] }

  public async exit() {
    await transport(this.system).control({ capability: "process", operation: "exit", input: { process: this.identity } })
  }

  public async exited() { return await this.system.process.find(this.identity) === null }

  private async exists() { return !await this.exited() }
}

class EndpointOperations extends Events<{}, unknown> {
  public readonly lifecycle: EndpointLifecycle

  public constructor(
    public readonly system: System,
    public readonly owner: ProcessHandle,
    public readonly endpoint: "server" | "client"
  ) {
    super([], (event, signal, timeout) => event === null
      ? transport(system).api({ capability: "endpoint", operation: "wait", process: owner.identity, endpoint, event, timeout }, signal)
      : transport(system).control({
        capability: "endpoint", operation: "wait", input: { process: owner.identity, endpoint, event, timeout }
      }, signal).then(value => (value as { payload?: unknown }).payload))
    this.lifecycle = new Events<EndpointLifecycleEvents>(["start", "stop"], (event, signal, timeout) => {
      return waitEndpointLifecycle(system, owner, endpoint, event, signal, timeout)
    })
  }

  public process() { return Promise.resolve(this.owner) }

  public async exists() {
    const value = await this.inspect()
    return value.running
  }

  public async start(launch: ServerLaunch | ClientLaunch = {}) { await this.operation("start", launch) }
  public async stop() { await this.operation("stop") }

  public async waitReady(timeout?: number) {
    await transport(this.system).control({ capability: "endpoint", operation: "waitReady", input: {
      process: this.owner.identity, endpoint: this.endpoint, timeout
    } })
  }

  public async isService() {
    return await transport(this.system).api({
      capability: "endpoint", operation: "isService", process: this.owner.identity, endpoint: this.endpoint
    }) as boolean
  }

  public publish(event: string, payload?: unknown) {
    void transport(this.system).control({ capability: "endpoint", operation: "publish", input: {
      process: this.owner.identity, endpoint: this.endpoint, event, payload
    } })
  }

  private inspect() {
    return transport(this.system).control({ capability: "endpoint", operation: "inspect", input: {
      process: this.owner.identity, endpoint: this.endpoint
    } }) as Promise<EndpointSnapshot>
  }

  private async operation(operation: "start" | "stop", launch?: ServerLaunch | ClientLaunch) {
    await transport(this.system).control({ capability: "endpoint", operation, input: {
      process: this.owner.identity, endpoint: this.endpoint, ...(launch ? { launch } : {})
    } })
  }
}

interface ServerEndpoint extends SystemServerEntity {}

class ServerEndpoint extends ServerBase {
  public readonly endpoint = "server" as const
  public readonly traffic: ServerTrafficHandle
  public readonly lifecycle: EndpointLifecycle
  private readonly base: EndpointOperations

  public constructor(private readonly system: System, private readonly owner: ProcessHandle) {
    super()
    this.base = new EndpointOperations(system, owner, "server")
    this.traffic = new ServerTrafficHandle(
      (value, signal) => transport(system).api(value, signal),
      owner.identity,
      "server",
      value => endpointFromReference(system, value)
    )
    this.lifecycle = this.base.lifecycle
    bindEvents(this, this.base)
  }

  public process() { return this.base.process() }
  public exists() { return this.base.exists() }
  public waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public isService() { return this.base.isService() }
  public start(launch?: ServerLaunch) { return this.base.start(launch) }
  public stop() { return this.base.stop() }
  public publish(event: string, payload?: unknown) { return this.base.publish(event, payload) }

  public async ask<Answer = unknown>(event: string, payload?: unknown) {
    return await transport(this.system).control({ capability: "endpoint", operation: "ask", input: {
      process: this.owner.identity, endpoint: "server", event, payload
    } }) as Answer
  }

  public timeout(milliseconds: number) {
    return { ask: <Answer = unknown>(event: string, payload?: unknown) => transport(this.system).control({
      capability: "endpoint", operation: "ask", input: { process: this.owner.identity, endpoint: "server", event, payload, timeout: milliseconds }
    }) as Promise<Answer> }
  }

}

interface ClientEndpoint extends SystemClientEntity {}

class ClientEndpoint extends ClientBase {
  public readonly endpoint = "client" as const
  public readonly traffic: EndpointTrafficHandle
  public readonly lifecycle: EndpointLifecycle
  public readonly window: SystemWindow
  private readonly base: EndpointOperations

  public constructor(system: System, owner: ProcessHandle) {
    super()
    this.base = new EndpointOperations(system, owner, "client")
    this.traffic = new EndpointTrafficHandle(
      (value, signal) => transport(system).api(value, signal),
      owner.identity,
      "client",
      value => endpointFromReference(system, value)
    )
    this.lifecycle = this.base.lifecycle
    bindEvents(this, this.base)
    this.window = new SystemWindow(system, owner)
  }

  public process() { return this.base.process() }
  public exists() { return this.base.exists() }
  public waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public isService() { return this.base.isService() }
  public start(launch?: ClientLaunch) { return this.base.start(launch) }
  public stop() { return this.base.stop() }
  public publish(event: string, payload?: unknown) { return this.base.publish(event, payload) }

}

class SystemWindow extends Events<WindowEvents> implements Window {
  public constructor(private readonly system: System, private readonly process: ProcessHandle) {
    super(["move", "resize", "geometry", "minimize", "changeTitle", "front"], (event, signal, timeout) => transport(system).control({
      capability: "window", operation: "wait", input: { process: process.identity, event, timeout }
    }, signal).then(value => (value as { payload?: unknown }).payload))
  }

  public async title() { return (await this.snapshot()).title }
  public async position() { return (await this.snapshot()).position }
  public async size() { return (await this.snapshot()).size }
  public async minimized() { return (await this.snapshot()).minimized }
  public async front() { return (await this.snapshot()).front }
  public async layer() { return (await this.snapshot()).layer }
  public async location() { return (await this.snapshot()).location }
  public async move(position: Position) { await this.change("move", { position }) }
  public async resize(size: Size) { await this.change("resize", { size }) }
  public async setGeometry(geometry: WindowGeometry) { await this.change("setGeometry", geometry) }
  public async minimize(minimized = true) { await this.change("minimize", { minimized }) }
  public async changeTitle(title: string) { await this.change("changeTitle", { title }) }
  public async raise() { await this.change("raise", {}) }

  private snapshot() {
    return transport(this.system).control({ capability: "window", operation: "inspect", input: { process: this.process.identity } }) as Promise<WindowSnapshot>
  }

  private async change(operation: string, input: object) {
    await transport(this.system).control({ capability: "window", operation, input: { process: this.process.identity, ...input } })
  }
}

class ServiceBase {
  public readonly lifecycle: EndpointLifecycle

  public constructor(protected readonly system: System, protected readonly key: ServiceKey) {
    this.lifecycle = new Events<EndpointLifecycleEvents>(["start", "stop"], (event, signal, timeout) => transport(system).api({
      capability: "service", operation: "wait", scope: "lifecycle", key, event, timeout
    }, signal))
  }

  public async exists() { return await transport(this.system).api({ capability: "service", operation: "exists", key: this.key }) as boolean }

  public async waitReady(timeout?: number) {
    await transport(this.system).api({ capability: "service", operation: "waitReady", key: this.key, timeout })
  }

  public publish(event: string, payload?: unknown) {
    void transport(this.system).api({ capability: "service", operation: "publish", key: this.key, event, payload })
  }
}

/** Node-SDK handle for a Service provided by a Server Endpoint. */
export class ServerService<EventsMap extends object = {}, Fallback = unknown> extends CoreServerService<EventsMap, Fallback> {
  protected constructor() { super() }
}

class ServerServiceHandle<EventsMap extends object = {}, Fallback = unknown> extends ServerService<EventsMap, Fallback> {
  public override readonly lifecycle: EndpointLifecycle
  private readonly base: ServiceBase

  public constructor(private readonly system: System, private readonly key: ServiceKey & { endpoint: "server" }) {
    super()
    this.base = new ServiceBase(system, key)
    this.lifecycle = this.base.lifecycle
    bindEvents(this, new Events<EventsMap, Fallback>([], (event, signal, timeout) => transport(system).api({
      capability: "service", operation: "wait", scope: "events", key, event, timeout
    }, signal)))
  }

  public override exists() { return this.base.exists() }
  public override waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public override readonly publish = (event: string, payload?: unknown) => this.base.publish(event, payload)
  public override async ask<Answer = unknown>(event: string, payload?: unknown) {
    return await transport(this.system).api({ capability: "service", operation: "ask", key: this.key, event, payload }) as Answer
  }
  public override timeout(milliseconds: number) {
    return { ask: <Answer = unknown>(event: string, payload?: unknown) => transport(this.system).api({
      capability: "service", operation: "ask", key: this.key, event, payload, timeout: milliseconds
    }) as Promise<Answer> }
  }
}

/** Node-SDK handle for a Service provided by a Client Endpoint. */
export class ClientService<EventsMap extends object = {}, Fallback = unknown> extends CoreClientService<EventsMap, Fallback> {
  protected constructor() { super() }
}

class ClientServiceHandle<EventsMap extends object = {}, Fallback = unknown> extends ClientService<EventsMap, Fallback> {
  public override readonly lifecycle: EndpointLifecycle
  private readonly base: ServiceBase

  public constructor(system: System, key: ServiceKey & { endpoint: "client" }) {
    super()
    this.base = new ServiceBase(system, key)
    this.lifecycle = this.base.lifecycle
    bindEvents(this, new Events<EventsMap, Fallback>([], (event, signal, timeout) => transport(system).api({
      capability: "service", operation: "wait", scope: "events", key, event, timeout
    }, signal)))
  }

  public override exists() { return this.base.exists() }
  public override waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public override readonly publish = (event: string, payload?: unknown) => this.base.publish(event, payload)
}

async function listProcesses(system: System) {
  const processes: ProcessHandle[] = []
  let offset = 0
  while (true) {
    const page = await transport(system).control({ capability: "process", operation: "list", input: { limit: 100, offset } }) as Page<ProcessSnapshot>
    processes.push(...page.data.map(snapshot => processHandle(system, snapshot)))
    offset += page.data.length
    if (!page.truncated || !page.data.length) return processes
  }
}

async function* command(system: System, request: object): AsyncGenerator<ProgramCommandChunk, void, void> {
  for await (const event of transport(system).lifecycle(request)) {
    if (event.event === "output") yield {
      stream: event.stream === "stderr" ? "stderr" : "stdout",
      text: String(event.text ?? "")
    }
  }
}

async function waitEndpointLifecycle(
  system: System,
  owner: ProcessHandle,
  endpoint: "server" | "client",
  event: string | null,
  signal: AbortSignal,
  timeout = 10_000
) {
  if (event !== "start" && event !== "stop") throw new Error(`An Endpoint lifecycle has no "${event}" event`)
  await transport(system).control({
    capability: "endpoint",
    operation: "waitLifecycle",
    input: { process: owner.identity, endpoint, event, timeout }
  }, signal)
}

function processEvent(system: System, value: unknown): unknown {
  const waited = value as { event?: string, payload?: unknown }
  const payload = waited.payload as Record<string, unknown> | undefined
  if (waited.event === "exit" && payload) return {
    process: processHandle(system, required(payload.processSnapshot as ProcessSnapshot | undefined, String(payload.process ?? ""))),
    status: payload.status,
    code: payload.code,
    signal: payload.signal
  }
  if (payload && typeof payload.identity === "string") return processHandle(system, payload as unknown as ProcessSnapshot)
  return payload
}

function programProcessEvent(system: System, event: string | null, value: unknown) {
  if (event === "create") return processHandle(system, value as ProcessSnapshot)

  const exit = value as Record<string, unknown>
  return {
    process: processHandle(system, required(exit.process as ProcessSnapshot | undefined)),
    status: exit.status,
    code: exit.code,
    signal: exit.signal
  }
}

function exactProcessEvent(value: unknown) {
  const payload = (value as { payload?: unknown }).payload as Record<string, unknown> | undefined
  if (!payload) return payload
  return {
    status: payload.status,
    code: payload.code,
    signal: payload.signal
  }
}

function bindEvents<Definitions extends object, Fallback>(target: object, events: Events<Definitions, Fallback>) {
  Object.assign(target, eventsOf(events))
}

function eventsOf<Definitions extends object, Fallback>(events: Events<Definitions, Fallback>) {
  return {
    subscribe: events.subscribe,
    waitFor: events.waitFor,
    events: events.events
  }
}

function chronological(left: SystemProcessEntity, right: SystemProcessEntity) { return left.startedAt.getTime() - right.startedAt.getTime() }
async function programStoragePath(system: System, handle: ReturnType<ProgramHandle["address"]>, area: "data" | "cache") {
  const value = await transport(system).api({ capability: "program", operation: "storagePath", handle, area })
  if (typeof value !== "string") throw new Error("The System returned an invalid Program storage path")
  return value
}

function endpointFromReference(system: System, value: unknown) {
  const reference = value as EndpointReference | null
  if (!reference || (reference.kind !== "server" && reference.kind !== "client")) throw new Error("The System returned an invalid Endpoint reference")
  const owner = processHandle(system, snapshotFromReference(reference.process))
  return reference.kind === "server" ? owner.server : owner.client
}

function snapshotFromReference(reference: ProcessReference): ProcessSnapshot {
  const owner = reference.program
  if (!owner || typeof owner.reference !== "string" || typeof owner.identity !== "string") throw new Error("The System returned an invalid Process reference")
  return {
    reference: reference.reference,
    identity: reference.identity,
    name: reference.name,
    program: owner.identity,
    programSnapshot: owner,
    parent: null,
    options: reference.options,
    startedAt: reference.startedAt,
    server: { declared: owner.server !== null, running: reference.server !== null, service: reference.server?.service === true },
    client: { declared: owner.client !== null, running: reference.client !== null, service: reference.client?.service === true }
  }
}
function unknown(error: unknown, entity: string) { return error instanceof Error && error.message.startsWith(`Unknown ${entity}`) }
function required<Value>(value: Value | undefined, identity = ""): Value {
  if (value !== undefined) return value
  throw new Error(`The System returned no ${identity ? `${identity} ` : ""}snapshot`)
}

interface Page<Value> { data: Value[], total: number, truncated: boolean }
interface ProgramSnapshot {
  reference: string
  identity: string
  name: string
  version: string | null
  description: string | null
  installed?: boolean
  hasAgent: boolean
  server: EndpointDeclaration | null
  client: ClientDeclaration | null
}
interface ProcessSnapshot {
  reference: string
  identity: string
  name: string | null
  program: string
  programSnapshot?: ProgramSnapshot
  parent: string | null
  options: Record<string, string>
  startedAt: string
  server: { declared: boolean, running: boolean, service: boolean }
  client: { declared: boolean, running: boolean, service: boolean }
}
interface ProcessReference {
  reference: string
  identity: string
  name: string | null
  program: ProgramSnapshot
  options: Record<string, string>
  startedAt: string
  server: { service: boolean } | null
  client: { service: boolean } | null
}
interface EndpointReference { kind: "server" | "client", process: ProcessReference }
interface EndpointSnapshot { running: boolean, service: boolean }
interface WindowSnapshot {
  title: string
  position: Position
  size: Size
  minimized: boolean
  front: boolean
  layer: Awaited<ReturnType<Window["layer"]>>
  location: string
}

export type Program = SystemProgramEntity
export const Program = CoreProgram

export type Process = SystemProcessEntity
export const Process = CoreProcess

export type Endpoint<EventsMap extends object = {}, Fallback = unknown> = SystemEndpointEntity<EventsMap, Fallback>
export const Endpoint = CoreEndpoint

export type Server<EventsMap extends object = {}, Fallback = unknown> = SystemServerEntity<EventsMap, Fallback>
export const Server = CoreServer

export type Client<EventsMap extends object = {}, Fallback = unknown> = SystemClientEntity<EventsMap, Fallback>
export const Client = CoreClient
