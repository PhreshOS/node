import {
  ClientServiceHandler as CoreClientServiceHandler,
  ServerServiceHandler as CoreServerServiceHandler,
  type Appearance,
  type ClientDeclaration,
  type ClientServiceChannel,
  type EndpointDeclaration,
  type Launch,
  type LaunchClient,
  type Position,
  type ProgramEvents,
  type ProgramCommandChunk,
  type ServerServiceChannel,
  type ServiceHandler,
  type ServiceKey,
  type Size,
  type System,
  type SystemClientEntity,
  type SystemEndpointEntity,
  type SystemProcessEntity,
  type SystemProcessEntityEvents,
  type SystemProcessEvents,
  type SystemProgramEntity,
  type SystemProgramEvents,
  type SystemProgramProcessEvents,
  type SystemServerEntity,
  type Window,
  type WindowEvents,
  type WindowGeometry
} from "@phreshos/core"
import { homedir } from "node:os"
import Events from "./events.js"
import { filesystemStorage } from "./storage.js"
import type { GatewayEvent } from "./transport.js"
import Uploads from "./uploads.js"

export interface SystemTransport {
  control(request: object, signal?: AbortSignal): Promise<unknown>
  api(request: object, signal?: AbortSignal): Promise<unknown>
  lifecycle(request: object, signal?: AbortSignal): AsyncGenerator<GatewayEvent, void, void>
}

/** Build the exact shared System contract over an owner-local Gateway transport. */
export function gatewaySystem(transport: SystemTransport): System {
  return new GatewaySystem(transport)
}

class GatewaySystem implements System {
  public readonly storage = filesystemStorage(homedir(), "the native home directory")
  public readonly appearance: GatewayAppearance
  public readonly program: ProgramRegistry
  public readonly process: ProcessRegistry
  public readonly uploads: Uploads

  public constructor(public readonly transport: SystemTransport) {
    this.appearance = new GatewayAppearance(transport)
    this.program = new ProgramRegistry(this)
    this.process = new ProcessRegistry(this)
    this.uploads = new Uploads(request => transport.api(request))
  }

  public service<EventsMap extends object = {}>(key: ServiceKey & { endpoint: "server" }): ServerService<EventsMap>
  public service<EventsMap extends object = {}>(key: ServiceKey & { endpoint: "client" }): ClientService<EventsMap>
  public service(key: ServiceKey): ServiceHandler {
    return key.endpoint === "server"
      ? new ServerService(this, key as ServiceKey & { endpoint: "server" })
      : new ClientService(this, key as ServiceKey & { endpoint: "client" })
  }
}

class GatewayAppearance extends Events<{ change: Appearance }> {
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
  public constructor(private readonly system: GatewaySystem) {
    super(["create", "forget", "install", "uninstall"], (event, signal, timeout) => (
      system.transport.control({ capability: "program", operation: "wait", input: { event, timeout } }, signal)
        .then(value => this.event(value))
    ))
  }

  public async list(onlyInstalled = false) {
    const programs: ProgramHandle[] = []
    let offset = 0

    while (true) {
      const page = await this.system.transport.control({
        capability: "program",
        operation: "list",
        input: { installedOnly: onlyInstalled, limit: 100, offset }
      }) as Page<ProgramSnapshot>

      programs.push(...page.data.map(snapshot => new ProgramHandle(this.system, snapshot)))
      offset += page.data.length
      if (!page.truncated || !page.data.length) return programs
    }
  }

  public async find(identity: string) {
    try {
      const snapshot = await this.system.transport.control({ capability: "program", operation: "inspect", input: { program: identity } }) as ProgramSnapshot
      return new ProgramHandle(this.system, snapshot)
    } catch (error) {
      if (unknown(error, "Program")) return null
      throw error
    }
  }

  public async create(source: object | string) {
    let identity: string | null = null
    for await (const event of this.system.transport.lifecycle({ word: "create", program: source })) {
      if (event.event === "created") identity = String(event.identity)
    }
    if (!identity) throw new Error("The System did not confirm the created Program")
    const program = await this.find(identity)
    if (!program) throw new Error("The created Program cannot be found")
    return program
  }

  private async event(value: unknown) {
    const waited = value as { event?: string, payload?: unknown }
    if (waited.event === "uninstall") {
      const payload = waited.payload as { program?: ProgramSnapshot, everythingRemoved?: boolean }
      return { program: new ProgramHandle(this.system, required(payload.program)), everythingRemoved: payload.everythingRemoved === true }
    }
    return new ProgramHandle(this.system, required(waited.payload as ProgramSnapshot | undefined))
  }
}

class ProgramHandle extends Events<ProgramEvents> implements SystemProgramEntity {
  public readonly identity: string
  public readonly name: string
  public readonly version: string | null
  public readonly description: string | null
  public readonly hasAgent: boolean
  public readonly server: EndpointDeclaration | null
  public readonly client: ClientDeclaration | null
  public readonly process: ProgramProcesses

  public constructor(private readonly system: GatewaySystem, snapshot: ProgramSnapshot) {
    super(["forget", "uninstall"], (event, signal, timeout) => system.transport.control({
      capability: "program", operation: "wait", input: { program: snapshot.identity, event, timeout }
    }, signal).then(value => (value as { payload?: unknown }).payload))
    this.identity = snapshot.identity
    this.name = snapshot.name
    this.version = snapshot.version
    this.description = snapshot.description
    this.hasAgent = snapshot.hasAgent
    this.server = snapshot.server ? Object.freeze({ start: snapshot.server.start }) : null
    this.client = snapshot.client ? Object.freeze({
      start: snapshot.client.start,
      title: snapshot.client.title,
      size: snapshot.client.size,
      position: snapshot.client.position,
      layer: snapshot.client.layer,
      minimize: snapshot.client.minimize
    }) : null
    this.process = new ProgramProcesses(system, this)
  }

  public async agent() {
    if (!this.hasAgent) return null
    const value = await this.system.transport.control({ capability: "program", operation: "agent", input: { program: this.identity } }) as { content?: unknown }
    return typeof value.content === "string" ? value.content : null
  }

  public async installed() {
    const value = await this.system.transport.control({ capability: "program", operation: "inspect", input: { program: this.identity } }) as ProgramSnapshot
    if (typeof value.installed !== "boolean") throw new Error("The System returned no Program installation state")
    return value.installed
  }

  public install() { return command(this.system, { word: "install-existing", identity: this.identity }) }
  public uninstall(everything = false) { return command(this.system, { word: "uninstall-existing", identity: this.identity, everything }) }

  public async forget() {
    for await (const _event of this.system.transport.lifecycle({ word: "forget", identity: this.identity })) { /* consume completion */ }
  }
}

class ProgramProcesses extends Events<SystemProgramProcessEvents> {
  public constructor(private readonly system: GatewaySystem, private readonly program: ProgramHandle) {
    super(["endpointStart", "endpointStop", "create", "exit"], (event, signal, timeout) => system.transport.control({
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

  public create(launch: Launch = {}) { return createProcess(this.system, "create", this.program.identity, launch) }
  public findOrCreate(launch: Launch & { name: string }) { return createProcess(this.system, "findOrCreate", this.program.identity, launch) }

  public async exitAll() {
    const processes = await this.list()
    await Promise.all(processes.map(process => process.exit()))
    return processes.map(process => process.identity)
  }
}

class ProcessRegistry extends Events<SystemProcessEvents> {
  public constructor(private readonly system: GatewaySystem) {
    super(["endpointStart", "endpointStop", "create", "exit"], (event, signal, timeout) => system.transport.control({
      capability: "process", operation: "wait", input: { event, timeout }
    }, signal).then(value => processEvent(system, value)))
  }

  public list() { return listProcesses(this.system) }

  public async find(identity: string) {
    try {
      const snapshot = await this.system.transport.control({ capability: "process", operation: "inspect", input: { process: identity } }) as ProcessSnapshot
      return new ProcessHandle(this.system, snapshot)
    } catch (error) {
      if (unknown(error, "Process")) return null
      throw error
    }
  }
}

class ProcessHandle extends Events<SystemProcessEntityEvents> implements SystemProcessEntity {
  public readonly identity: string
  public readonly name: string | null
  public readonly startedAt: Date
  public readonly server: ServerEndpoint
  public readonly client: ClientEndpoint

  public constructor(private readonly system: GatewaySystem, private readonly snapshot: ProcessSnapshot) {
    super(["endpointStart", "endpointStop", "exit"], (event, signal, timeout) => system.transport.control({
      capability: "process", operation: "wait", input: { process: snapshot.identity, event, timeout }
    }, signal).then(value => processEvent(system, value)))
    this.identity = snapshot.identity
    this.name = snapshot.name
    this.startedAt = new Date(snapshot.startedAt)
    this.server = new ServerEndpoint(system, this)
    this.client = new ClientEndpoint(system, this)
  }

  public program() { return new ProgramHandle(this.system, required(this.snapshot.programSnapshot, this.snapshot.program)) }

  public async exit() {
    await this.system.transport.control({ capability: "process", operation: "exit", input: { process: this.identity } })
  }

  public async exited() { return await this.system.process.find(this.identity) === null }
}

abstract class EndpointHandle extends Events<{}, unknown> implements SystemEndpointEntity {
  public abstract readonly endpoint: "server" | "client"

  public constructor(protected readonly system: GatewaySystem, protected readonly owner: ProcessHandle, endpoint: "server" | "client") {
    super([], (event, signal, timeout) => event === null
      ? system.transport.api({ capability: "endpoint", operation: "wait", process: owner.identity, endpoint, event, timeout }, signal)
      : system.transport.control({
        capability: "endpoint", operation: "wait", input: { process: owner.identity, endpoint, event, timeout }
      }, signal).then(value => (value as { payload?: unknown }).payload))
  }

  public process() { return Promise.resolve(this.owner) }

  public async exists() {
    const value = await this.inspect()
    return value.running
  }

  public async start() { await this.operation("start") }
  public async stop() { await this.operation("stop") }

  public async service(): Promise<ServiceHandler | null> {
    const key = await this.system.transport.api({ capability: "endpoint", operation: "service", process: this.owner.identity, endpoint: this.endpoint }) as ServiceKey | null
    return key ? this.system.service(key as never) : null
  }

  public publish(event: string, payload?: unknown) {
    void this.system.transport.control({ capability: "endpoint", operation: "publish", input: {
      process: this.owner.identity, endpoint: this.endpoint, event, payload
    } })
  }

  protected inspect() {
    return this.system.transport.control({ capability: "endpoint", operation: "inspect", input: {
      process: this.owner.identity, endpoint: this.endpoint
    } }) as Promise<EndpointSnapshot>
  }

  protected async operation(operation: "start" | "stop", client?: LaunchClient) {
    await this.system.transport.control({ capability: "endpoint", operation, input: {
      process: this.owner.identity, endpoint: this.endpoint, ...(client ? { client } : {})
    } })
  }
}

class ServerEndpoint extends EndpointHandle implements SystemServerEntity {
  public readonly endpoint = "server" as const

  public constructor(system: GatewaySystem, owner: ProcessHandle) { super(system, owner, "server") }

  public async ask<Answer = unknown>(event: string, payload?: unknown) {
    return await this.system.transport.control({ capability: "endpoint", operation: "ask", input: {
      process: this.owner.identity, endpoint: "server", event, payload
    } }) as Answer
  }

  public timeout(milliseconds: number) {
    return { ask: <Answer = unknown>(event: string, payload?: unknown) => this.system.transport.control({
      capability: "endpoint", operation: "ask", input: { process: this.owner.identity, endpoint: "server", event, payload, timeout: milliseconds }
    }) as Promise<Answer> }
  }

  public async waitReady(timeout?: number) {
    await this.system.transport.control({ capability: "endpoint", operation: "waitReady", input: { process: this.owner.identity, endpoint: "server", timeout } })
  }

  public override async service<EventsMap extends object = {}>() {
    return await super.service() as ServerService<EventsMap> | null
  }
}

class ClientEndpoint extends EndpointHandle implements SystemClientEntity {
  public readonly endpoint = "client" as const
  public readonly window: GatewayWindow

  public constructor(system: GatewaySystem, owner: ProcessHandle) {
    super(system, owner, "client")
    this.window = new GatewayWindow(system, owner)
  }

  public override async start(overrides?: LaunchClient) { await this.operation("start", overrides) }

  public override async service<EventsMap extends object = {}>() {
    return await super.service() as ClientService<EventsMap> | null
  }
}

class GatewayWindow extends Events<WindowEvents> implements Window {
  public constructor(private readonly system: GatewaySystem, private readonly process: ProcessHandle) {
    super(["move", "resize", "geometry", "minimize", "changeTitle", "front"], (event, signal, timeout) => system.transport.control({
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
    return this.system.transport.control({ capability: "window", operation: "inspect", input: { process: this.process.identity } }) as Promise<WindowSnapshot>
  }

  private async change(operation: string, input: object) {
    await this.system.transport.control({ capability: "window", operation, input: { process: this.process.identity, ...input } })
  }
}

class ServiceBase extends Events<{ enable: undefined, disable: undefined }> {
  public readonly name: string

  public constructor(protected readonly system: GatewaySystem, protected readonly key: ServiceKey) {
    super(["enable", "disable"], (event, signal, timeout) => system.transport.api({
      capability: "service", operation: "wait", scope: "lifecycle", key, event, timeout
    }, signal))
    this.name = key.name
  }

  public async enabled() { return await this.system.transport.api({ capability: "service", operation: "enabled", key: this.key }) as boolean }
  public async waitReady(timeout?: number) { await this.system.transport.api({ capability: "service", operation: "waitReady", key: this.key, timeout }) }
}

class ServerService<EventsMap extends object = {}> extends CoreServerServiceHandler<EventsMap> {
  public override readonly name: string
  public override readonly channel: ServerServiceChannel<EventsMap>
  private readonly base: ServiceBase

  public constructor(system: GatewaySystem, key: ServiceKey & { endpoint: "server" }) {
    super()
    this.base = new ServiceBase(system, key)
    this.name = key.name
    this.channel = new ServerServiceChannelHandle(system, key) as unknown as ServerServiceChannel<EventsMap>
    Object.assign(this, eventsOf(this.base))
  }

  public override enabled() { return this.base.enabled() }
  public override waitReady(timeout?: number) { return this.base.waitReady(timeout) }
}

class ClientService<EventsMap extends object = {}> extends CoreClientServiceHandler<EventsMap> {
  public override readonly name: string
  public override readonly channel: ClientServiceChannel<EventsMap>
  private readonly base: ServiceBase

  public constructor(system: GatewaySystem, key: ServiceKey & { endpoint: "client" }) {
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
  public constructor(protected readonly system: GatewaySystem, protected readonly key: ServiceKey) {
    super([], (event, signal, timeout) => system.transport.api({ capability: "service", operation: "wait", scope: "channel", key, event, timeout }, signal))
  }
}

class ServerServiceChannelHandle extends ClientServiceChannelHandle {
  public async ask<Answer = unknown>(event: string, payload?: unknown) {
    return await this.system.transport.api({ capability: "service", operation: "ask", key: this.key, event, payload }) as Answer
  }
  public timeout(milliseconds: number) {
    return { ask: <Answer = unknown>(event: string, payload?: unknown) => this.system.transport.api({
      capability: "service", operation: "ask", key: this.key, event, payload, timeout: milliseconds
    }) as Promise<Answer> }
  }
  public publish(event: string, payload?: unknown) {
    void this.system.transport.api({ capability: "service", operation: "publish", key: this.key, event, payload })
  }
}

async function listProcesses(system: GatewaySystem, program?: string) {
  const processes: ProcessHandle[] = []
  let offset = 0
  while (true) {
    const page = await system.transport.control({ capability: "process", operation: "list", input: { program, limit: 100, offset } }) as Page<ProcessSnapshot>
    processes.push(...page.data.map(snapshot => new ProcessHandle(system, snapshot)))
    offset += page.data.length
    if (!page.truncated || !page.data.length) return processes
  }
}

async function createProcess(system: GatewaySystem, operation: "create" | "findOrCreate", program: string, launch: Launch) {
  const snapshot = await system.transport.control({ capability: "process", operation, input: { program, launch } }) as ProcessSnapshot
  return new ProcessHandle(system, snapshot)
}

async function* command(system: GatewaySystem, request: object): AsyncGenerator<ProgramCommandChunk, void, void> {
  for await (const event of system.transport.lifecycle(request)) {
    if (event.event === "output") yield {
      stream: event.stream === "stderr" ? "stderr" : "stdout",
      text: String(event.text ?? "")
    }
  }
}

function processEvent(system: GatewaySystem, value: unknown): unknown {
  const waited = value as { event?: string, payload?: unknown }
  const payload = waited.payload as Record<string, unknown> | undefined
  if (waited.event === "exit" && payload) return {
    process: new ProcessHandle(system, required(payload.processSnapshot as ProcessSnapshot | undefined, String(payload.process ?? ""))),
    status: payload.status,
    code: payload.code,
    signal: payload.signal
  }
  if ((waited.event === "endpointStart" || waited.event === "endpointStop") && payload?.processSnapshot) {
    const process = new ProcessHandle(system, payload.processSnapshot as ProcessSnapshot)
    return payload.endpoint === "client" ? process.client : process.server
  }
  if (payload && typeof payload.identity === "string") return new ProcessHandle(system, payload as unknown as ProcessSnapshot)
  return payload
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
