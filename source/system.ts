import {
  Connection as CoreConnection,
  ClientEndpoint as CoreClientEndpoint,
  ClientService as CoreClientService,
  Process as CoreProcess,
  Program as CoreProgram,
  ServerEndpoint as CoreServerEndpoint,
  ServerService as CoreServerService,
  Session as CoreSession,
  execute as executeRequest,
  isServiceAddress,
  parseEndpointReference,
  parseConnectionSnapshot,
  parseProgramDefinition,
  parsePermissions,
  parseSessionSnapshot,
  type Appearance,
  type AppearanceUpdate,
  type ClientDeclaration,
  type ConnectionEvents,
  type ConnectionSnapshot,
  type ExecuteRequest,
  type ExecuteResult,
  type EndpointLifecycle,
  type EndpointLifecycleEvents,
  type ServiceLifecycle,
  type ServiceLifecycleEvents,
  type ServiceProgramMetadata,
  type EndpointDeclaration,
  type Launch,
  type ClientLaunch,
  type ServerLaunch,
  type Position,
  type ProgramDefinition,
  type ProgramEvents,
  type ProgramCommandChunk,
  type ProgramInstallOptions,
  type ProgramUninstallOptions,
  type ProgramIconSize,
  type ProgramProcessRunEvent as CoreProgramProcessRunEvent,
  type ProgramProcessRunOptions as CoreProgramProcessRunOptions,
  type ProgramSql,
  type ProgramStore,
  type ProcessEvents,
  type ServiceAddress,
  type ShellOptions,
  type Size,
  type System as CoreSystem,
  type SystemConnection,
  type SystemConnectionEvents,
  type SystemProcessEvents,
  type SystemProcess,
  type SystemProgram,
  type SystemProgramEvents,
  type SystemUploads,
  type SystemSession,
  type SystemSessionEvents,
  type SystemService,
  type SystemServiceEvents,
  type SessionEvents,
  type SessionSnapshot,
  type Storage,
  type Subscribable,
  type WritableAppearance,
  type Window,
  type WindowEvents,
  type WindowFrame,
  type WindowGeometry,
  type WindowTransaction
} from "@phreshos/core"
import { homedir } from "node:os"
import { gatewayAddress } from "./address.js"
import Events from "./events.js"
import HandleRegistry from "./handle-registry.js"
import { resolveHome } from "./home.js"
import { filesystemStorage, nativeStorage } from "./storage.js"
import { programPermissions, programSql, programStore } from "./program-resources.js"
import { EndpointTrafficHandle, ServerTrafficHandle } from "./traffic.js"
import SystemRepresentation, {
  processIdentityState,
  type ProcessIdentityState,
  type ProcessState,
  type ProgramAddress,
  type ProgramState
} from "./representation.js"
import { GatewayConnection, openConnection } from "./transport.js"
import Uploads from "./uploads.js"
import shell from "./shell.js"
import network from "./network.js"

type ProgramProcessRunOptions = CoreProgramProcessRunOptions
type ProgramProcessRunEvent = CoreProgramProcessRunEvent

interface SystemState {
  readonly connection: GatewayConnection
  readonly handles: HandleRegistry
  readonly lifetime: AbortController
  readonly representation: SystemRepresentation
  closed: boolean
}

const systems = new WeakMap<System, SystemState>()
const processSnapshots = new WeakMap<object, ProcessIdentityState>()

/** One connected owner-local implementation of the shared System contract. */
export class System implements CoreSystem {
  public readonly storage: Storage
  public readonly appearance: WritableAppearance
  public readonly program: SystemProgram
  public readonly process: SystemProcess
  public readonly connection: SystemConnection
  public readonly session: SystemSession
  public readonly service: SystemService
  public readonly uploads: SystemUploads
  public readonly network = network(() => connectedSignal(this))

  public execute<Request extends ExecuteRequest>(request: Request): Promise<ExecuteResult<Request>> {
    return executeRequest(this, request)
  }

  public async *shell(command: string, options: ShellOptions = {}) {
    yield* shell(command, { ...options, signal: connectedSignal(this, options.signal) })
  }

  private constructor(connection: GatewayConnection) {
    const lifetime = new AbortController()
    const handles = new HandleRegistry()
    const representation = new SystemRepresentation(connection)

    systems.set(this, { connection, handles, lifetime, representation, closed: false })
    connection.onDisconnect(() => void closeSystem(this, new Error("This System connection is closed")))
    this.storage = nativeStorage(homedir(), "the native filesystem", () => connectedSignal(this))
    this.appearance = new SystemAppearance(this)
    this.program = new ProgramRegistry(this)
    this.process = new ProcessRegistry(this)
    this.connection = new ConnectionRegistry(this)
    this.session = new SessionRegistry(this)
    this.service = new ServiceRegistry(this)
    this.uploads = new Uploads(value => uploadRequest(this, value), () => connectedSignal(this))
    representation.activate()
  }

  /** Connect to the System selected by argument, environment, or owner default. */
  public static async connect(home?: string) {
    const resolved = resolveHome(home)
    const address = gatewayAddress(resolved)
    const connection = await openConnection(address)

    try { return new System(connection) }
    catch (error) {
      try { await connection.disconnect() }
      catch { /* Preserve the representation failure that made this connection unusable. */ }

      throw error
    }
  }

  /** Close this owner connection and abort every attached operation it owns. */
  public async disconnect() {
    await closeSystem(this, new Error("This System connection is closed"))
  }

}

function systemState(system: System) {
  const state = systems.get(system)
  if (!state) throw new Error("Unknown System connection")
  return state
}

function closeSystem(system: System, reason: Error) {
  const state = systemState(system)
  if (state.closed) return Promise.resolve()
  state.closed = true
  state.lifetime.abort(reason)
  state.representation.close()
  state.handles.clear()
  return state.connection.disconnect()
}

function requireConnected(system: System) {
  if (systemState(system).closed) throw new Error("This System connection is closed")
}

function connectedSignal(system: System, signal?: AbortSignal) {
  const lifetime = systemState(system).lifetime.signal
  requireConnected(system)
  return signal ? AbortSignal.any([signal, lifetime]) : lifetime
}

function representation(system: System) {
  requireConnected(system)
  return systemState(system).representation
}

function programHandle(system: System, snapshot: ProgramState) {
  const handle = systemState(system).handles.obtain(`program:${snapshot.reference}`, () => new ProgramHandle(system, snapshot))
  handle.update(snapshot)
  return handle
}

function processHandle(system: System, snapshot: ProcessIdentityState) {
  return systemState(system).handles.obtain(`process:${snapshot.reference}`, () => new ProcessHandle(system, snapshot))
}

function connectionHandle(system: System, value: unknown) {
  const snapshot = parseConnectionSnapshot(value)
  const handle = systemState(system).handles.obtain(`connection:${snapshot.identity}`, () => new ConnectionHandle(system, snapshot))
  return handle
}

function sessionHandle(system: System, value: unknown) {
  const snapshot = parseSessionSnapshot(value)
  const handle = systemState(system).handles.obtain(`session:${snapshot.identity}`, () => new SessionHandle(system, snapshot))
  return handle
}

class SystemAppearance extends Events<{ change: Appearance }> {
  public constructor(private readonly system: System) {
    super(["change"], (_event, subscriber) => representation(system).on("appearance", subscriber))
  }

  public async snapshot() {
    return representation(this.system).appearance
  }

  public async update(appearance: AppearanceUpdate) {
    await representation(this.system).call("/appearance/update", appearance)
  }
}

class ConnectionRegistry extends Events<SystemConnectionEvents> implements SystemConnection {
  public constructor(private readonly system: System) {
    super(["create", "disconnect"], (event, subscriber) => {
      if (event === null) throw new Error("System Connection events are named")
      return representation(system).on(`connection:${event}`, value => subscriber(connectionHandle(system, value)))
    })
  }

  public async list() {
    const snapshots = await representation(this.system).call<unknown[]>("/connection/list")
    return snapshots.map(value => connectionHandle(this.system, value))
  }

  public async find(identity: string) {
    const snapshot = await representation(this.system).call<unknown>("/connection/find", identity)
    return snapshot === null ? null : connectionHandle(this.system, snapshot)
  }
}

class ConnectionHandle extends CoreConnection {
  public readonly subscribe: CoreConnection["subscribe"]
  public readonly wait: CoreConnection["wait"]
  public readonly events: CoreConnection["events"]
  public readonly identity: string
  public constructor(private readonly system: System, snapshot: ConnectionSnapshot) {
    super()
    this.identity = snapshot.identity
    const events = new Events<ConnectionEvents>(["sessionChange", "disconnect"], (event, subscriber) => {
      if (event === null) throw new Error("Connection events are named")
      return representation(system).on(`connection:${this.identity}:${event}`, value => {
        if (event === "sessionChange") subscriber(value === null ? null : sessionHandle(system, value))
        else subscriber(undefined)
      })
    })
    this.subscribe = events.subscribe
    this.wait = events.wait
    this.events = events.events
  }

  public async connected() {
    const snapshot = parseConnectionSnapshot(await representation(this.system).call("/connection/state", this.identity))
    return snapshot.connected
  }

  public async session() {
    const snapshot = await representation(this.system).call("/connection/session", this.identity)
    return snapshot === null ? null : sessionHandle(this.system, snapshot)
  }

  public async signIn() {
    return sessionHandle(this.system, await representation(this.system).call("/connection/sign-in", this.identity))
  }
}

class SessionRegistry extends Events<SystemSessionEvents> implements SystemSession {
  public constructor(private readonly system: System) {
    super(["create", "end"], (event, subscriber) => {
      if (event === null) throw new Error("System Session events are named")
      return representation(system).on(`session:${event}`, (...values) => {
        const session = sessionHandle(system, values[0])
        subscriber(event === "end" ? { session, reason: values[1] } : session)
      })
    })
  }

  public async list() {
    const snapshots = await representation(this.system).call<unknown[]>("/session/list")
    return snapshots.map(value => sessionHandle(this.system, value))
  }

  public async find(identity: string) {
    const snapshot = await representation(this.system).call<unknown>("/session/find", identity)
    return snapshot === null ? null : sessionHandle(this.system, snapshot)
  }
}

class SessionHandle extends CoreSession {
  public readonly subscribe: CoreSession["subscribe"]
  public readonly wait: CoreSession["wait"]
  public readonly events: CoreSession["events"]
  public readonly identity: string
  public constructor(private readonly system: System, snapshot: SessionSnapshot) {
    super()
    this.identity = snapshot.identity
    const events = new Events<SessionEvents>(["connectionAttach", "connectionDetach", "end"], (event, subscriber) => {
      if (event === null) throw new Error("Session events are named")
      return representation(system).on(`session:${this.identity}:${event}`, (...values) => {
        if (event === "connectionAttach" || event === "connectionDetach") subscriber(connectionHandle(system, values[0]))
        else subscriber({ reason: values[0] })
      })
    })
    this.subscribe = events.subscribe
    this.wait = events.wait
    this.events = events.events
  }

  public async valid() {
    const snapshot = parseSessionSnapshot(await representation(this.system).call("/session/state", this.identity))
    return snapshot.valid
  }

  public async connections() {
    const snapshots = await representation(this.system).call<unknown[]>("/session/connections", this.identity)
    return snapshots.map(value => connectionHandle(this.system, value))
  }

  public async signOut() {
    await representation(this.system).call("/session/sign-out", this.identity)
  }
}

class ServiceRegistry extends Events<SystemServiceEvents, never> implements SystemService {
  public constructor(private readonly system: System) {
    super(["available", "unavailable"], (event, subscriber) => {
      if (event === null) throw new Error("System Service events are named")
      return representation(system).on(`service:${event}`, value => subscriber(this.prepare(parseServiceAddress(value))))
    })
  }

  public async list(): Promise<(CoreServerService | CoreClientService)[]> {
    const addresses = await representation(this.system).call<unknown[]>("/process/service/list")
    return addresses.map(value => this.prepare(parseServiceAddress(value)))
  }

  public async search(name: string): Promise<(CoreServerService | CoreClientService)[]> {
    const addresses = await representation(this.system).call<unknown[]>("/process/service/search", name)
    return addresses.map(value => this.prepare(parseServiceAddress(value)))
  }

  public prepare<EventsMap extends object = {}, Fallback = unknown>(address: ServiceAddress<"server">): CoreServerService<EventsMap, Fallback>
  public prepare<EventsMap extends object = {}, Fallback = unknown>(address: ServiceAddress<"client">): CoreClientService<EventsMap, Fallback>
  public prepare(address: ServiceAddress): CoreServerService | CoreClientService
  public prepare(address: ServiceAddress): CoreServerService | CoreClientService {
    const normalized = parseServiceAddress(address)
    const identity = JSON.stringify([normalized.program, normalized.process, normalized.endpoint])

    return systemState(this.system).handles.obtain(`service:${identity}`, () => normalized.endpoint === "server"
      ? new ServerServiceHandle(this.system, normalized as ServiceAddress<"server">)
      : new ClientServiceHandle(this.system, normalized as ServiceAddress<"client">))
  }
}

class ProgramRegistry extends Events<SystemProgramEvents> {
  public constructor(private readonly system: System) {
    super(["create", "forget", "install", "uninstall", "pinned", "permissions"], (event, subscriber) => {
      if (event === null) throw new Error("System Program events are named")
      return representation(system).on(`program:${event}`, (...values) => subscriber(this.event(event, values)))
    })
  }

  public async list(onlyInstalled = false) {
    return [...representation(this.system).programs.values()]
      .filter(program => !onlyInstalled || program.installed)
      .sort((left, right) => left.identity.localeCompare(right.identity))
      .map(program => programHandle(this.system, program))
  }

  public async find(identity: string) {
    const program = representation(this.system).programs.get(identity)
    return program ? programHandle(this.system, program) : null
  }

  public async create(source: ProgramDefinition | string) {
    const identity = await representation(this.system).call<string>("/program/create-program", source)
    return programHandle(this.system, required(representation(this.system).programs.get(identity), identity))
  }

  public async forceCreate(source: ProgramDefinition | string): Promise<CoreProgram> {
    requireConnected(this.system)
    const identity = await representation(this.system).call<string>("/program/force-create-program", source, "")
    return programHandle(this.system, required(representation(this.system).programs.get(identity), identity))
  }

  private event(event: string, values: unknown[]) {
    const program = programHandle(this.system, required(values[0] as ProgramState | undefined))
    if (event === "uninstall") return { program, purge: values[1] === true }
    if (event === "pinned") return { program, pinned: values[1] === true }
    if (event === "permissions") return { program, permissions: parsePermissions((values[0] as ProgramState).permissions) }
    return program
  }
}

class ProgramHandle extends CoreProgram {
  public override readonly subscribe: Subscribable<ProgramEvents, never>["subscribe"]
  public override readonly wait: Subscribable<ProgramEvents, never>["wait"]
  public override readonly events: Subscribable<ProgramEvents, never>["events"]
  private readonly reference: string
  public readonly identity: string
  public readonly data: Storage
  public readonly cache: Storage
  public readonly store: ProgramStore
  public readonly logs: ProgramSql
  public readonly database: ProgramSql
  public readonly startup: ProgramStartup
  public readonly permissions
  private snapshot: ProgramState

  public constructor(private readonly system: System, snapshot: ProgramState) {
    super()
    this.snapshot = snapshot
    this.reference = snapshot.reference
    this.identity = snapshot.identity
    const address = this.address()
    const events = new Events<ProgramEvents>(["processCreate", "processExit", "forget", "uninstall", "pinned", "permissions"], (event, subscriber) => {
      if (event === null) throw new Error("Program events are named")
      return representation(system).on(`program:${this.reference}:${event}`, (...values) => {
        if (event === "processCreate" || event === "processExit") subscriber(programProcessEvent(system, event, values))
        else if (event === "uninstall") subscriber({ purge: values[0] === true })
        else if (event === "pinned") subscriber(values[0] === true)
        else if (event === "permissions") subscriber(parsePermissions(values[0]))
        else subscriber(undefined)
      })
    })
    this.subscribe = events.subscribe
    this.wait = events.wait
    this.events = events.events
    representation(system).on(`program:${this.reference}:change`, value => this.update(value as ProgramState))
    const call = <Result = unknown>(event: string, ...values: unknown[]) => representation(system).call<Result>(event, ...values)
    this.data = filesystemStorage(() => programStoragePath(system, address, "data"), `Program "${this.identity}" data`, () => connectedSignal(system))
    this.cache = filesystemStorage(() => programStoragePath(system, address, "cache"), `Program "${this.identity}" cache`, () => connectedSignal(system))
    this.store = programStore(call, address)
    this.logs = programSql(call, address, "logs")
    this.database = programSql(call, address, "database")
    this.startup = new ProgramStartup(system, this)
    this.permissions = programPermissions(call, address)
  }

  public get name() { return this.snapshot.name }
  public get assetId() { return this.snapshot.assetId }
  public get version() { return this.snapshot.version }
  public get description() { return this.snapshot.description }
  public get hasAgent() { return this.snapshot.hasAgent }
  public get server(): EndpointDeclaration | null {
    return this.snapshot.server ? Object.freeze({
      start: this.snapshot.server.start,
      service: this.snapshot.server.service
    }) : null
  }
  public get client(): ClientDeclaration | null { return this.snapshot.client }

  public pinned() { return representation(this.system).call<boolean>("/program/pinned", this.address(), "get") }
  public async pin() { await representation(this.system).call("/program/pinned", this.address(), "pin") }
  public async unpin() { await representation(this.system).call("/program/pinned", this.address(), "unpin") }

  public update(snapshot: ProgramState) {
    if (snapshot.reference !== this.reference) throw new Error("A Program handle cannot become another Program")
    this.snapshot = snapshot
  }

  public async icon(size: ProgramIconSize = "medium") {
    const value = await representation(this.system).call<unknown>("/program/icon", this.address(), size)
    if (!Array.isArray(value) || value.some(byte => typeof byte !== "number")) throw new Error("The System returned an invalid Program icon")
    return new Blob([Uint8Array.from(value)], { type: "image/png" })
  }

  public async definition() {
    return parseProgramDefinition(await representation(this.system).call<unknown>("/program/definition", this.address()))
  }

  public async agent() {
    if (!this.hasAgent) return null
    const value = await representation(this.system).call<unknown>("/program/agent", this.address())
    return typeof value === "string" ? value : null
  }

  public async installed() {
    return this.snapshot.installed
  }

  public async processes() {
    return [...representation(this.system).processes.values()]
      .filter(process => process.program === this.identity)
      .map(process => processHandle(this.system, process))
  }

  public async firstProcess() { return (await this.processes()).sort(chronological)[0] ?? null }

  public async lastProcess() { return (await this.processes()).sort(chronological).at(-1) ?? null }

  public async findProcess(identityOrName: string) {
    return (await this.processes()).find(process => process.identity === identityOrName || process.name === identityOrName) ?? null
  }

  public createProcess(launch: Launch = {}) { return this.createExactProcess("create-process", launch) }

  public findOrCreateProcess(launch: Launch & { name: string }) { return this.createExactProcess("find-or-create-process", launch) }

  public async exitProcesses() {
    return await representation(this.system).call<string[]>("/process/exit-all", this.identity, "")
  }

  public async *runProcess(launch: Launch = {}, options: ProgramProcessRunOptions = {}): AsyncGenerator<ProgramProcessRunEvent, void, void> {
    let process: ProcessHandle | null = null

    for await (const event of representation(this.system).command("run", this.address(), launch, options.signal)) {
      if (event.event === "started") {
        const identity = (event.process as { identity?: unknown } | undefined)?.identity
        if (typeof identity !== "string") throw new Error("The System returned an invalid started Process")
        process = processHandle(this.system, required(representation(this.system).processes.get(identity), identity))
        yield Object.freeze({ event: "started", process })
      } else if (event.event === "output") {
        if ((event.stream !== "stdout" && event.stream !== "stderr") || typeof event.text !== "string") {
          throw new Error("The System returned an invalid Process output event")
        }
        yield Object.freeze({ event: "output", stream: event.stream, text: event.text })
      } else if (event.event === "exited") {
        if (!process) throw new Error("The System ended a Process before confirming its start")
        const value = event.exit as { status?: unknown, code?: unknown, signal?: unknown } | undefined
        if (!value
          || (value.status !== "exited" && value.status !== "signaled")
          || (value.code !== null && typeof value.code !== "number")
          || (value.signal !== null && typeof value.signal !== "string")) {
          throw new Error("The System returned an invalid Process exit event")
        }
        const exit = Object.freeze({ status: value.status, code: value.code, signal: value.signal })
        yield Object.freeze({ event: "exited", process, exit })
      } else throw new Error("The System returned an unknown Process run event")
    }
  }

  public install(options: ProgramInstallOptions = {}) { return command(this.system, "install", this.address(), options) }
  public uninstall(options: ProgramUninstallOptions = {}) { return command(this.system, "uninstall", this.address(), options) }

  public async forget() {
    await representation(this.system).call("/program/forget-program", this.address(), "")
  }

  private async createExactProcess(word: "create-process" | "find-or-create-process", launch: Launch) {
    const route = word === "create-process" ? "/program/create-process" : "/program/find-or-create-process"
    const identity = await representation(this.system).call<string>(route, this.address(), launch, null)
    return processHandle(this.system, required(representation(this.system).processes.get(identity), identity))
  }

  public address() { return Object.freeze({ identity: this.identity, reference: this.reference }) }
}

class ProgramStartup {
  public constructor(private readonly system: System, private readonly program: ProgramHandle) {}

  public async get() {
    return await representation(this.system).call<Launch | null>("/program/startup", this.program.address(), "get")
  }

  public async enable(launch: Launch = {}) {
    await this.change("enable", launch)
  }

  public async disable() {
    await this.change("disable")
  }

  private async change(operation: "enable" | "disable", launch?: Launch) {
    await representation(this.system).call("/program/startup", this.program.address(), operation, launch)
  }
}

class ProcessRegistry extends Events<SystemProcessEvents> {
  public constructor(private readonly system: System) {
    super(["create", "exit"], (event, subscriber) => {
      if (event === null) throw new Error("System Process events are named")
      return representation(system).on(`process:${event}`, (...values) => subscriber(processEvent(system, event, values)))
    })
  }

  public list() { return listProcesses(this.system) }

  public async find(identity: string) {
    const process = representation(this.system).processes.get(identity)
    return process ? processHandle(this.system, process) : null
  }
}

class ProcessHandle extends CoreProcess {
  public override readonly subscribe: Subscribable<ProcessEvents, never>["subscribe"]
  public override readonly wait: Subscribable<ProcessEvents, never>["wait"]
  public override readonly events: Subscribable<ProcessEvents, never>["events"]
  public readonly identity: string
  public readonly name: string | null
  public readonly startedAt: Date
  public readonly server: ServerEndpoint
  public readonly client: ClientEndpoint

  public constructor(private readonly system: System, snapshot: ProcessIdentityState) {
    super()
    processSnapshots.set(this, snapshot)
    const events = new Events<ProcessEvents>(["exit"], (_event, subscriber) => (
      representation(system).on(`process:${snapshot.reference}:exit`, value => subscriber(value))
    ))
    this.subscribe = events.subscribe
    this.wait = events.wait
    this.events = events.events
    this.identity = snapshot.identity
    this.name = snapshot.name
    this.startedAt = new Date(snapshot.startedAt)
    this.server = new ServerEndpointHandle(system, this)
    this.client = new ClientEndpointHandle(system, this)
  }

  public program() {
    const snapshot = processState(this.system, this)
    return programHandle(this.system, required(representation(this.system).programs.get(snapshot.program), snapshot.program))
  }

  public async parent() {
    if (!await this.exists()) throw new Error(`Process "${this.identity}" no longer exists`)
    const value = await representation(this.system).call<unknown>("/process/parent", {
      identity: this.identity,
      reference: processReference(this)
    })
    return value === null ? null : processHandle(this.system, processIdentityState(value))
  }

  public async options<Options extends object = Readonly<Record<string, string>>>(): Promise<Readonly<Options>>
  public async options<Option extends string = string>(name: string): Promise<Option | undefined>
  public async options(name?: string) {
    const options = processState(this.system, this).options
    return name === undefined ? Object.freeze({ ...options }) : options[name]
  }

  public async exit() {
    await representation(this.system).call("/process/exit", this.identity)
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
    super([], (event, subscriber, impossible) => representation(system).follow({
      scope: "endpoint",
      process: owner.identity,
      endpoint,
      event
    }, (_received, payload) => subscriber(payload), impossible))
    this.lifecycle = new Events<EndpointLifecycleEvents>(["start", "stop"], (event, subscriber, impossible) => {
      try { this.requireEndpoint() }
      catch (error) {
        if (impossible) impossible(error instanceof Error ? error : new Error(String(error)))
        return () => undefined
      }
      return endpointLifecycle(system, owner, endpoint, event, subscriber, impossible)
    })
  }

  public async process() {
    this.requireEndpoint()
    return this.owner
  }

  public async running() {
    this.requireEndpoint()
    return endpointState(this.system, this.owner, this.endpoint) !== null
  }

  public async start(launch: ServerLaunch | ClientLaunch = {}) { await this.operation("start", launch) }
  public async stop() { await this.operation("stop") }

  public async waitReady(timeout?: number) {
    this.requireEndpoint()
    await waitEndpointReady(this.system, this.owner, this.endpoint, timeout)
  }

  public async isService() {
    this.requireEndpoint()
    return endpointState(this.system, this.owner, this.endpoint)?.service === true
  }

  public publish(event: string, payload?: unknown) {
    void representation(this.system).call("/process/endpoint/publish", this.owner.identity, this.endpoint, event, payload)
  }

  private async operation(operation: "start" | "stop", launch?: ServerLaunch | ClientLaunch) {
    await representation(this.system).call(`/process/endpoint/${operation}`, this.owner.identity, this.endpoint, launch)
  }

  private requireEndpoint() {
    const state = processState(this.system, this.owner)
    const declared = this.endpoint === "server" ? state.serverEndpoint : state.clientEndpoint !== null
    if (!declared) throw new Error(`This Program declared no ${this.endpoint === "server" ? "Server" : "Client"} Endpoint`)
  }
}

class ServerEndpointHandle extends CoreServerEndpoint {
  public override readonly subscribe: Subscribable<{}, unknown>["subscribe"]
  public override readonly wait: Subscribable<{}, unknown>["wait"]
  public override readonly events: Subscribable<{}, unknown>["events"]
  public readonly endpoint = "server" as const
  public readonly traffic: ServerTrafficHandle
  public readonly lifecycle: EndpointLifecycle
  private readonly base: EndpointOperations

  public constructor(private readonly system: System, private readonly owner: ProcessHandle) {
    super()
    this.base = new EndpointOperations(system, owner, "server")
    this.traffic = new ServerTrafficHandle(
      representation(system),
      owner.identity,
      "server",
      value => endpointFromReference(system, value)
    )
    this.lifecycle = this.base.lifecycle
    this.subscribe = this.base.subscribe
    this.wait = this.base.wait
    this.events = this.base.events
  }

  public process() { return this.base.process() }
  public running() { return this.base.running() }
  public waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public isService() { return this.base.isService() }
  public start(launch?: ServerLaunch) { return this.base.start(launch) }
  public stop() { return this.base.stop() }
  public override readonly publish = (event: string, payload?: unknown) => this.base.publish(event, payload)

  public async ask<Answer = unknown>(event: string, payload?: unknown) {
    return await this.askWithin<Answer>(event, payload, 10_000)
  }

  public timeout(milliseconds: number) {
    return { ask: <Answer = unknown>(event: string, payload?: unknown) => this.askWithin<Answer>(event, payload, milliseconds) }
  }

  private askWithin<Answer>(event: string, payload: unknown, timeout: number) {
    return representation(this.system).call<Answer>("/process/endpoint/ask", this.owner.identity, event, payload, timeout)
  }

}

class ClientEndpointHandle extends CoreClientEndpoint {
  public override readonly subscribe: Subscribable<{}, unknown>["subscribe"]
  public override readonly wait: Subscribable<{}, unknown>["wait"]
  public override readonly events: Subscribable<{}, unknown>["events"]
  public readonly endpoint = "client" as const
  public readonly traffic: EndpointTrafficHandle
  public readonly lifecycle: EndpointLifecycle
  public readonly window: SystemWindow
  private readonly base: EndpointOperations

  public constructor(system: System, owner: ProcessHandle) {
    super()
    this.base = new EndpointOperations(system, owner, "client")
    this.traffic = new EndpointTrafficHandle(
      representation(system),
      owner.identity,
      "client",
      value => endpointFromReference(system, value)
    )
    this.lifecycle = this.base.lifecycle
    this.subscribe = this.base.subscribe
    this.wait = this.base.wait
    this.events = this.base.events
    this.window = new SystemWindow(system, owner)
  }

  public process() { return this.base.process() }
  public running() { return this.base.running() }
  public waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public isService() { return this.base.isService() }
  public start(launch?: ClientLaunch) { return this.base.start(launch) }
  public stop() { return this.base.stop() }
  public override readonly publish = (event: string, payload?: unknown) => this.base.publish(event, payload)

}

class SystemWindow extends Events<WindowEvents> implements Window {
  public constructor(private readonly system: System, private readonly process: ProcessHandle) {
    super(["move", "resize", "minimize", "maximize", "changeTitle", "changeHeader", "changeFrame", "changeTransaction", "front"], (event, subscriber) => {
      if (event === null) throw new Error("Window events are named")
      return representation(system).on(`window:${process.identity}:${event}`, subscriber)
    })
  }

  public async title() { return (await this.snapshot()).title }
  public async header() { return (await this.snapshot()).header }
  public async frame() { return (await this.snapshot()).frame }
  public async transaction() { return (await this.snapshot()).transaction }
  public async position() { return (await this.snapshot()).position }
  public async size() { return (await this.snapshot()).size }
  public async minimized() { return (await this.snapshot()).minimized }
  public async maximized() { return (await this.snapshot()).maximized }
  public async front() { return frontWindow(this.system, this.process) }
  public async layer() { return (await this.snapshot()).layer }
  public async move(position: Position) { await this.change("move", position) }
  public async resize(size: Size) { await this.change("resize", size) }
  public async setGeometry(geometry: WindowGeometry) { await this.change("set-geometry", geometry) }
  public async minimize(minimized = true) { await this.change("minimize", minimized) }
  public async maximize(maximized = true) { await this.change("maximize", maximized) }
  public async setTitle(title: string) { await this.change("set-title", title) }
  public async setHeader(header: boolean) { await this.change("set-header", header) }
  public async setFrame(frame: WindowFrame) { await this.change("set-frame", frame) }
  public async setTransaction(transaction: WindowTransaction) { await this.change("set-transaction", transaction) }
  public async raise() { await this.change("raise") }

  private snapshot() {
    const window = processState(this.system, this.process).clientEndpoint?.window
    if (!window) throw new Error(`Process "${this.process.identity}" has no Client declaration`)
    return Promise.resolve(window)
  }

  private async change(operation: string, input?: unknown) {
    await representation(this.system).call(`/process/${operation}`, this.process.identity, input)
  }
}

class ServiceBase {
  public readonly lifecycle: ServiceLifecycle

  public constructor(protected readonly system: System, protected readonly serviceAddress: ServiceAddress) {
    this.lifecycle = new Events<ServiceLifecycleEvents>(["available", "unavailable"], (event, subscriber, impossible) => representation(system).follow({
      scope: "service", address: serviceAddress, kind: "lifecycle", event
    }, (_received, payload) => subscriber(payload), impossible))
  }

  public address() { return this.serviceAddress }

  public async available() {
    return representation(this.system).call<boolean>("/process/service/available", this.serviceAddress)
  }

  public async waitReady(timeout?: number) {
    await representation(this.system).call("/process/service/wait-ready", this.serviceAddress, timeout)
  }

  public async programMetadata() {
    const value = await representation(this.system).call<unknown>("/process/service/program-metadata", this.serviceAddress)
    return parseServiceProgramMetadata(value)
  }

  public async programIcon(size: ProgramIconSize = "medium") {
    const value = await representation(this.system).call<unknown>("/process/service/program-icon", this.serviceAddress, size)
    return parseServiceProgramIcon(value)
  }

  public publish(event: string, payload?: unknown) {
    void representation(this.system).call("/process/service/publish", this.serviceAddress, event, payload)
  }
}

class ServerServiceHandle<EventsMap extends object = {}, Fallback = unknown> extends CoreServerService<EventsMap, Fallback> {
  public override readonly lifecycle: ServiceLifecycle
  public override readonly subscribe: Subscribable<EventsMap, Fallback>["subscribe"]
  public override readonly wait: Subscribable<EventsMap, Fallback>["wait"]
  public override readonly events: Subscribable<EventsMap, Fallback>["events"]
  private readonly base: ServiceBase

  public constructor(private readonly system: System, private readonly serviceAddress: ServiceAddress<"server">) {
    super()
    this.base = new ServiceBase(system, serviceAddress)
    this.lifecycle = this.base.lifecycle
    const events = new Events<EventsMap, Fallback>([], (event, subscriber, impossible) => representation(system).follow({
      scope: "service", address: serviceAddress, kind: "events", event
    }, (_received, payload) => subscriber(payload), impossible))
    this.subscribe = events.subscribe
    this.wait = events.wait
    this.events = events.events
  }

  public override address() { return this.serviceAddress }
  public override available() { return this.base.available() }
  public override programMetadata() { return this.base.programMetadata() }
  public override programIcon(size?: ProgramIconSize) { return this.base.programIcon(size) }
  public override waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public override readonly publish = (event: string, payload?: unknown) => this.base.publish(event, payload)
  public override async ask<Answer = unknown>(event: string, payload?: unknown) {
    return await representation(this.system).call<Answer>("/process/service/ask", this.serviceAddress, event, payload, 10_000)
  }
  public override timeout(milliseconds: number) {
    return { ask: <Answer = unknown>(event: string, payload?: unknown) => representation(this.system).call<Answer>(
      "/process/service/ask", this.serviceAddress, event, payload, milliseconds
    ) }
  }
}

class ClientServiceHandle<EventsMap extends object = {}, Fallback = unknown> extends CoreClientService<EventsMap, Fallback> {
  public override readonly lifecycle: ServiceLifecycle
  public override readonly subscribe: Subscribable<EventsMap, Fallback>["subscribe"]
  public override readonly wait: Subscribable<EventsMap, Fallback>["wait"]
  public override readonly events: Subscribable<EventsMap, Fallback>["events"]
  private readonly base: ServiceBase

  public constructor(system: System, private readonly serviceAddress: ServiceAddress<"client">) {
    super()
    this.base = new ServiceBase(system, serviceAddress)
    this.lifecycle = this.base.lifecycle
    const events = new Events<EventsMap, Fallback>([], (event, subscriber, impossible) => representation(system).follow({
      scope: "service", address: serviceAddress, kind: "events", event
    }, (_received, payload) => subscriber(payload), impossible))
    this.subscribe = events.subscribe
    this.wait = events.wait
    this.events = events.events
  }

  public override address() { return this.serviceAddress }
  public override available() { return this.base.available() }
  public override programMetadata() { return this.base.programMetadata() }
  public override programIcon(size?: ProgramIconSize) { return this.base.programIcon(size) }
  public override waitReady(timeout?: number) { return this.base.waitReady(timeout) }
  public override readonly publish = (event: string, payload?: unknown) => this.base.publish(event, payload)
}

async function listProcesses(system: System) {
  return [...representation(system).processes.values()]
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
    .map(process => processHandle(system, process))
}

async function* command(system: System, operation: "install" | "uninstall", subject: ProgramAddress, value?: unknown): AsyncGenerator<ProgramCommandChunk, void, void> {
  for await (const event of representation(system).command(operation, subject, value)) {
    if (event.event === "output") yield {
      stream: event.stream === "stderr" ? "stderr" : "stdout",
      text: String(event.text ?? "")
    }
  }
}

function endpointLifecycle(
  system: System,
  owner: ProcessHandle,
  endpoint: "server" | "client",
  event: string | null,
  subscriber: (message: unknown) => unknown,
  impossible?: (error: Error) => void
) {
  if (event !== "start" && event !== "stop") throw new Error(`An Endpoint lifecycle has no "${event}" event`)
  const model = representation(system)
  const stopEvent = model.on(`endpoint:${processReference(owner)}:${endpoint}:${event}`, () => subscriber(undefined))
  const stopExit = model.on(`process:${processReference(owner)}:exit`, () => impossible?.(new Error(`Process "${owner.identity}" exited`)))
  return () => { stopEvent(); stopExit() }
}

function processEvent(system: System, event: string, values: unknown[]) {
  const process = processHandle(system, required(values[0] as ProcessState | undefined))
  return event === "exit" ? { process, ...(values[1] as object) } : process
}

function programProcessEvent(system: System, event: string | null, values: unknown[]) {
  const process = processHandle(system, required(values[0] as ProcessState | undefined))
  return event === "processExit" ? { process, ...(values[1] as object) } : process
}

function chronological(left: Process, right: Process) { return left.startedAt.getTime() - right.startedAt.getTime() }
async function programStoragePath(system: System, handle: ReturnType<ProgramHandle["address"]>, area: "data" | "cache") {
  const value = await representation(system).call<unknown>("/program/area", handle, area, "path", [])
  if (typeof value !== "string") throw new Error("The System returned an invalid Program storage path")
  return value
}

function endpointFromReference(system: System, value: unknown) {
  if (value === null) return null
  const reference = parseEndpointReference(value)
  const owner = processHandle(system, required(representation(system).processes.get(reference.process.identity), reference.process.identity))
  return reference.kind === "server" ? owner.server : owner.client
}

function processState(system: System, process: ProcessHandle) {
  const original = required(processSnapshots.get(process))
  const current = representation(system).processes.get(process.identity)
  if (!current || current.reference !== original.reference) throw new Error(`Process "${process.identity}" no longer exists`)
  return current
}

function processReference(process: ProcessHandle) { return required(processSnapshots.get(process)).reference }

function endpointState(system: System, process: ProcessHandle, endpoint: "server" | "client") {
  const current = representation(system).processes.get(process.identity)
  const original = required(processSnapshots.get(process))
  return current?.reference === original.reference ? current[endpoint] : null
}

function waitEndpointReady(system: System, process: ProcessHandle, endpoint: "server" | "client", timeout = 10_000) {
  if (endpointReady(endpointState(system, process, endpoint), endpoint)) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const model = representation(system)
    const reference = processReference(process)
    const finish = (work: () => void) => {
      clearTimeout(timer)
      stopStart()
      stopReady()
      stopExit()
      work()
    }
    const inspect = () => {
      if (endpointReady(endpointState(system, process, endpoint), endpoint)) finish(resolve)
    }
    const stopStart = model.on(`endpoint:${reference}:${endpoint}:start`, inspect)
    const stopReady = model.on(`endpoint:${reference}:${endpoint}:ready`, inspect)
    const stopExit = model.on(`process:${reference}:exit`, () => finish(() => reject(new Error(`Process "${process.identity}" exited`))))
    const timer = setTimeout(() => finish(() => reject(new Error("The Endpoint did not become ready before the timeout"))), timeout)
    inspect()
  })
}

function endpointReady(state: ProcessState["server"] | ProcessState["client"], endpoint: "server" | "client") {
  return state !== null && (endpoint === "client" || "ready" in state && state.ready)
}

function parseServiceAddress(value: unknown): ServiceAddress {
  if (!isServiceAddress(value)) throw new Error("A complete Service address is required")
  return Object.freeze({ program: value.program, process: value.process, endpoint: value.endpoint })
}

function parseServiceProgramMetadata(value: unknown): ServiceProgramMetadata {
  if (!value || typeof value !== "object") throw new Error("The System returned invalid Service Program metadata")

  const metadata = value as { name?: unknown, version?: unknown }

  if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
    throw new Error("The System returned invalid Service Program metadata")
  }

  return Object.freeze({ name: metadata.name, version: metadata.version })
}

function parseServiceProgramIcon(value: unknown) {
  if (!Array.isArray(value) || value.some(byte => typeof byte !== "number")) {
    throw new Error("The System returned an invalid Service Program icon")
  }
  return new Blob([Uint8Array.from(value)], { type: "image/png" })
}

function frontWindow(system: System, process: ProcessHandle) {
  const owner = processState(system, process)
  const window = owner.client ? owner.clientEndpoint?.window : null
  if (!window || window.minimized) return false
  return ![...representation(system).processes.values()].some(candidate => {
    const other = candidate.client ? candidate.clientEndpoint?.window : null
    return other && !other.minimized && other.layer === window.layer && other.depth > window.depth
  })
}

async function uploadRequest(system: System, value: object) {
  const request = value as { operation?: unknown, file?: unknown }
  if (request.operation === "access") return representation(system).call("/uploads/access")
  if (request.operation === "stat") return representation(system).call("/uploads/stat", request.file)
  throw new Error(`The Uploads API does not know "${String(request.operation)}"`)
}

function required<Value>(value: Value | undefined, identity = ""): Value {
  if (value !== undefined) return value
  throw new Error(`The System returned no ${identity ? `${identity} ` : ""}snapshot`)
}

type Process = CoreProcess
type ServerEndpoint<EventsMap extends object = {}, Fallback = unknown> = CoreServerEndpoint<EventsMap, Fallback>
type ClientEndpoint<EventsMap extends object = {}, Fallback = unknown> = CoreClientEndpoint<EventsMap, Fallback>
