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
  type ClientServiceChannel,
  type EndpointDeclaration,
  type Launch,
  type LaunchClient,
  type Position,
  type ProgramDefinition,
  type ProgramEvents,
  type ProgramCommandChunk,
  type ServerServiceChannel,
  type Service,
  type ServiceKey,
  type Size,
  type System as CoreSystem,
  type SystemClientEntity,
  type SystemEndpointEntity,
  type SystemProcessEntity,
  type SystemProcessEntityEvents,
  type SystemProcessEvents,
  type SystemProcess,
  type SystemProgram,
  type SystemProgramEntity,
  type SystemProgramEvents,
  type SystemProgramProcessEvents,
  type SystemServerEntity,
  type SystemUploads,
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
import { filesystemStorage } from "./storage.js"
import { openConnection, request, streamProgram, type TransportEvent } from "./transport.js"
import Uploads from "./uploads.js"

export type ProgramProcessRunOptions = Readonly<{
  signal?: AbortSignal
}>

export type ProgramProcessRunEvent =
  | Readonly<{ event: "started", process: SystemProcessEntity }>
  | (Readonly<{ event: "output" }> & ProgramCommandChunk)
  | Readonly<{ event: "exited", process: SystemProcessEntity, exit: import("@phreshos/core").Exit }>

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
  public readonly storage = filesystemStorage(homedir(), "the native home directory")
  public readonly appearance: WritableAppearance
  public readonly program: SystemProgram
  public readonly process: SystemProcess
  public readonly uploads: SystemUploads

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

  public service<EventsMap extends object = {}>(key: ServiceKey & { endpoint: "server" }): ServerService<EventsMap>
  public service<EventsMap extends object = {}>(key: ServiceKey & { endpoint: "client" }): ClientService<EventsMap>
  public service(key: ServiceKey): Service {
    requireConnected(this)
    if (!isServiceKey(key)) throw new Error("A complete service key is required")

    const normalized = Object.freeze({ program: key.program, endpoint: key.endpoint, name: key.name })
    const identity = JSON.stringify([normalized.program, normalized.endpoint, normalized.name])

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
      const payload = waited.payload as { program?: ProgramSnapshot, everythingRemoved?: boolean }
      return { program: programHandle(this.system, required(payload.program)), everythingRemoved: payload.everythingRemoved === true }
    }
    return programHandle(this.system, required(waited.payload as ProgramSnapshot | undefined))
  }
}

interface ProgramHandle extends SystemProgramEntity {}

class ProgramHandle extends ProgramBase {
  private readonly reference: string
  public readonly identity: string
  public readonly process: ProgramProcesses
  public readonly startup: ProgramStartup
  private snapshot: ProgramSnapshot

  public constructor(private readonly system: System, snapshot: ProgramSnapshot) {
    super()
    this.snapshot = snapshot
    bindEvents(this, new Events<ProgramEvents>(["forget", "uninstall"], (event, signal, timeout) => transport(system).control({
      capability: "program", operation: "wait", input: { program: snapshot.identity, event, timeout }
    }, signal).then(value => (value as { payload?: unknown }).payload)))
    this.reference = snapshot.reference
    this.identity = snapshot.identity
    this.process = new ProgramProcesses(system, this)
    this.startup = new ProgramStartup(system, this)
  }

  public get name() { return this.snapshot.name }
  public get version() { return this.snapshot.version }
  public get description() { return this.snapshot.description }
  public get hasAgent() { return this.snapshot.hasAgent }
  public get server(): EndpointDeclaration | null {
    return this.snapshot.server ? Object.freeze({ start: this.snapshot.server.start }) : null
  }
  public get client(): ClientDeclaration | null {
    return this.snapshot.client ? Object.freeze({
      start: this.snapshot.client.start,
      title: this.snapshot.client.title,
      size: this.snapshot.client.size,
      position: this.snapshot.client.position,
      layer: this.snapshot.client.layer,
      minimize: this.snapshot.client.minimize
    }) : null
  }

  public update(snapshot: ProgramSnapshot) {
    if (snapshot.reference !== this.reference) throw new Error("A Program handle cannot become another Program")
    this.snapshot = snapshot
  }

  public async agent() {
    if (!this.hasAgent) return null
    const value = await transport(this.system).control({ capability: "program", operation: "agent", input: { program: this.identity } }) as { content?: unknown }
    return typeof value.content === "string" ? value.content : null
  }

  public async installed() {
    for await (const event of transport(this.system).lifecycle({ word: "installed", handle: this.address() })) {
      if (event.event === "installedState") return event.installed === true
    }
    throw new Error("The System returned no Program installation state")
  }

  public install() { return command(this.system, { word: "install-existing", handle: this.address() }) }
  public uninstall(everything = false) { return command(this.system, { word: "uninstall-existing", handle: this.address(), everything }) }

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

class ProgramProcesses extends Events<SystemProgramProcessEvents> {
  public constructor(private readonly system: System, private readonly program: ProgramHandle) {
    super(["endpointStart", "endpointStop", "create", "exit"], (event, signal, timeout) => transport(system).control({
      capability: "process", operation: "wait", input: { program: program.identity, event, timeout }
    }, signal).then(value => processEvent(system, value)))
  }

  public async list() { return await listProcesses(this.system, this.program.identity) }
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
    super(["endpointStart", "endpointStop", "create", "exit"], (event, signal, timeout) => transport(system).control({
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
    bindEvents(this, new Events<SystemProcessEntityEvents>(["endpointStart", "endpointStop", "exit"], (event, signal, timeout) => transport(system).control({
      capability: "process", operation: "wait", input: { process: snapshot.identity, event, timeout }
    }, signal).then(value => processEvent(system, value))))
    this.identity = snapshot.identity
    this.name = snapshot.name
    this.startedAt = new Date(snapshot.startedAt)
    this.server = new ServerEndpoint(system, this)
    this.client = new ClientEndpoint(system, this)
  }

  public program() { return programHandle(this.system, required(this.snapshot.programSnapshot, this.snapshot.program)) }

  public async exit() {
    await transport(this.system).control({ capability: "process", operation: "exit", input: { process: this.identity } })
  }

  public async exited() { return await this.system.process.find(this.identity) === null }
}

class EndpointOperations extends Events<{}, unknown> {
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
  }

  public process() { return Promise.resolve(this.owner) }

  public async exists() {
    const value = await this.inspect()
    return value.running
  }

  public async start(client?: LaunchClient) { await this.operation("start", client) }
  public async stop() { await this.operation("stop") }

  public async service(): Promise<Service | null> {
    const key = await transport(this.system).api({ capability: "endpoint", operation: "service", process: this.owner.identity, endpoint: this.endpoint }) as ServiceKey | null
    return key ? this.system.service(key as never) : null
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

  private async operation(operation: "start" | "stop", client?: LaunchClient) {
    await transport(this.system).control({ capability: "endpoint", operation, input: {
      process: this.owner.identity, endpoint: this.endpoint, ...(client ? { client } : {})
    } })
  }
}

interface ServerEndpoint extends SystemServerEntity {}

class ServerEndpoint extends ServerBase {
  public readonly endpoint = "server" as const
  private readonly base: EndpointOperations

  public constructor(private readonly system: System, private readonly owner: ProcessHandle) {
    super()
    this.base = new EndpointOperations(system, owner, "server")
    bindEvents(this, this.base)
  }

  public process() { return this.base.process() }
  public exists() { return this.base.exists() }
  public start() { return this.base.start() }
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

  public async waitReady(timeout?: number) {
    await transport(this.system).control({ capability: "endpoint", operation: "waitReady", input: { process: this.owner.identity, endpoint: "server", timeout } })
  }

  public async service<EventsMap extends object = {}>() {
    return await this.base.service() as ServerService<EventsMap> | null
  }
}

interface ClientEndpoint extends SystemClientEntity {}

class ClientEndpoint extends ClientBase {
  public readonly endpoint = "client" as const
  public readonly window: SystemWindow
  private readonly base: EndpointOperations

  public constructor(system: System, owner: ProcessHandle) {
    super()
    this.base = new EndpointOperations(system, owner, "client")
    bindEvents(this, this.base)
    this.window = new SystemWindow(system, owner)
  }

  public process() { return this.base.process() }
  public exists() { return this.base.exists() }
  public start(overrides?: LaunchClient) { return this.base.start(overrides) }
  public stop() { return this.base.stop() }
  public publish(event: string, payload?: unknown) { return this.base.publish(event, payload) }

  public async service<EventsMap extends object = {}>() {
    return await this.base.service() as ClientService<EventsMap> | null
  }
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

class ServiceBase extends Events<{ enable: undefined, disable: undefined }> {
  public readonly name: string

  public constructor(protected readonly system: System, protected readonly key: ServiceKey) {
    super(["enable", "disable"], (event, signal, timeout) => transport(system).api({
      capability: "service", operation: "wait", scope: "lifecycle", key, event, timeout
    }, signal))
    this.name = key.name
  }

  public async enabled() { return await transport(this.system).api({ capability: "service", operation: "enabled", key: this.key }) as boolean }
  public async waitReady(timeout?: number) { await transport(this.system).api({ capability: "service", operation: "waitReady", key: this.key, timeout }) }
}

/** Node-SDK handle for a Service provided by a Server Endpoint. */
export class ServerService<EventsMap extends object = {}> extends CoreServerService<EventsMap> {
  protected constructor() { super() }
}

class ServerServiceHandle<EventsMap extends object = {}> extends ServerService<EventsMap> {
  public override readonly name: string
  public override readonly channel: ServerServiceChannel<EventsMap>
  private readonly base: ServiceBase

  public constructor(system: System, key: ServiceKey & { endpoint: "server" }) {
    super()
    this.base = new ServiceBase(system, key)
    this.name = key.name
    this.channel = new ServerServiceChannelHandle(system, key) as unknown as ServerServiceChannel<EventsMap>
    Object.assign(this, eventsOf(this.base))
  }

  public override enabled() { return this.base.enabled() }
  public override waitReady(timeout?: number) { return this.base.waitReady(timeout) }
}

/** Node-SDK handle for a Service provided by a Client Endpoint. */
export class ClientService<EventsMap extends object = {}> extends CoreClientService<EventsMap> {
  protected constructor() { super() }
}

class ClientServiceHandle<EventsMap extends object = {}> extends ClientService<EventsMap> {
  public override readonly name: string
  public override readonly channel: ClientServiceChannel<EventsMap>
  private readonly base: ServiceBase

  public constructor(system: System, key: ServiceKey & { endpoint: "client" }) {
    super()
    this.base = new ServiceBase(system, key)
    this.name = key.name
    this.channel = new ClientServiceChannelHandle(system, key) as unknown as ClientServiceChannel<EventsMap>
    Object.assign(this, eventsOf(this.base))
  }

  public override enabled() { return this.base.enabled() }
  public override waitReady(timeout?: number) { return this.base.waitReady(timeout) }
}

class ClientServiceChannelHandle extends Events<{}, unknown> {
  public constructor(protected readonly system: System, protected readonly key: ServiceKey) {
    super([], (event, signal, timeout) => transport(system).api({ capability: "service", operation: "wait", scope: "channel", key, event, timeout }, signal))
  }
}

class ServerServiceChannelHandle extends ClientServiceChannelHandle {
  public async ask<Answer = unknown>(event: string, payload?: unknown) {
    return await transport(this.system).api({ capability: "service", operation: "ask", key: this.key, event, payload }) as Answer
  }
  public timeout(milliseconds: number) {
    return { ask: <Answer = unknown>(event: string, payload?: unknown) => transport(this.system).api({
      capability: "service", operation: "ask", key: this.key, event, payload, timeout: milliseconds
    }) as Promise<Answer> }
  }
  public publish(event: string, payload?: unknown) {
    void transport(this.system).api({ capability: "service", operation: "publish", key: this.key, event, payload })
  }
}

async function listProcesses(system: System, program?: string) {
  const processes: ProcessHandle[] = []
  let offset = 0
  while (true) {
    const page = await transport(system).control({ capability: "process", operation: "list", input: { program, limit: 100, offset } }) as Page<ProcessSnapshot>
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

function processEvent(system: System, value: unknown): unknown {
  const waited = value as { event?: string, payload?: unknown }
  const payload = waited.payload as Record<string, unknown> | undefined
  if (waited.event === "exit" && payload) return {
    process: processHandle(system, required(payload.processSnapshot as ProcessSnapshot | undefined, String(payload.process ?? ""))),
    status: payload.status,
    code: payload.code,
    signal: payload.signal
  }
  if ((waited.event === "endpointStart" || waited.event === "endpointStop") && payload?.processSnapshot) {
    const process = processHandle(system, payload.processSnapshot as ProcessSnapshot)
    return payload.endpoint === "client" ? process.client : process.server
  }
  if (payload && typeof payload.identity === "string") return processHandle(system, payload as unknown as ProcessSnapshot)
  return payload
}

function bindEvents<Definitions extends object, Fallback>(target: object, events: Events<Definitions, Fallback>) {
  Object.assign(target, eventsOf(events))
}

function eventsOf<Definitions extends object, Fallback>(events: Events<Definitions, Fallback>) {
  return {
    subscribe: events.subscribe,
    waitFor: events.waitFor,
    events: events.events,
    observe: events.observe
  }
}

function chronological(left: SystemProcessEntity, right: SystemProcessEntity) { return left.startedAt.getTime() - right.startedAt.getTime() }
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
  server: { start: boolean } | null
  client: ClientDeclaration | null
}
interface ProcessSnapshot {
  reference: string
  identity: string
  name: string | null
  program: string
  programSnapshot?: ProgramSnapshot
  startedAt: string
  server: { declared: boolean, running: boolean }
  client: { declared: boolean, running: boolean }
}
interface EndpointSnapshot { running: boolean }
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

export type Endpoint<EventsMap extends object = {}> = SystemEndpointEntity<EventsMap>
export const Endpoint = CoreEndpoint

export type Server<EventsMap extends object = {}> = SystemServerEntity<EventsMap>
export const Server = CoreServer

export type Client<EventsMap extends object = {}> = SystemClientEntity<EventsMap>
export const Client = CoreClient
