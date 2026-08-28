import type { ProgramDescription, System, SystemControlClient, SystemControlRequest } from "@phreshos/core"
import type { Socket } from "node:net"
import { gatewayAddress } from "./address.js"
import { resolveHome } from "./home.js"
import { Project, type PackedProject, type ProjectMode } from "./project.js"
import { openConnection, request as gatewayRequest, streamProgram, type GatewayEvent } from "./transport.js"
import { gatewaySystem } from "./system.js"
import { assertAvailable, commandFailure, DevelopmentClient, waitForDevelopmentClient } from "./client-development.js"

/** One explicit owner-local connection to a running PhreshOS System. */
export class Gateway implements SystemControlClient {
  public readonly home: string
  public readonly address: string
  public readonly system: System
  private closed = false
  private readonly lifetime = new AbortController()

  private constructor(home: string, address: string, private readonly connection: Socket) {
    this.home = home
    this.address = address
    this.system = gatewaySystem({
      control: (request, signal) => this.control(request, signal),
      api: (request, signal) => this.api(request, signal),
      lifecycle: (request, signal) => this.lifecycle(request, signal)
    })
  }

  /** Connect to an already running System selected by argument, environment, or owner default. */
  public static async open(home?: string) {
    const resolvedHome = resolveHome(home)
    const address = gatewayAddress(resolvedHome)
    const connection = await openConnection(address)
    return new Gateway(resolvedHome, address, connection)
  }

  /** Execute one operation from the transport-neutral System-control vocabulary. */
  public execute(request: SystemControlRequest, signal?: AbortSignal) {
    this.requireOpen()
    return this.control(request, signal)
  }

  /** Build and package one local Program project. */
  public pack(project: Project): Promise<PackedProject> {
    this.requireOpen()
    return project.pack()
  }

  /** Install one local Program project in this Gateway's System. */
  public async *install(source: Project | ProgramDescription, options: InstallOptions = {}) {
    this.requireOpen()
    if (source instanceof Project) await source.build()
    const program = source instanceof Project ? source.description("production") : source
    yield* this.program({
      word: "install",
      program,
      run: options.run === true,
      startup: options.startup === true
    }, options.signal)
  }

  /** Build and start one local production Program, attached to this Gateway. */
  public start(project: Project, options: RunOptions = {}) {
    this.requireOpen()
    return this.runProject(project, "production", options)
  }

  /** Start one local Program in development, including its declared Client development server. */
  public dev(project: Project, options: RunOptions = {}) {
    this.requireOpen()
    return this.runProject(project, "development", options)
  }

  /** Uninstall one Program by identity or local Project. */
  public uninstall(program: string | Project, options: UninstallOptions = {}) {
    this.requireOpen()
    const identity = typeof program === "string" ? program : program.config.identity
    return this.program({ word: "uninstall", identity, everything: options.everything === true }, options.signal)
  }

  /** Close this Gateway without stopping the System. */
  public async close() {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort(new Error("This Gateway is closed"))
    this.connection.destroy()
  }

  private async *runProject(project: Project, mode: ProjectMode, options: RunOptions) {
    if (mode === "production") await project.build()
    const program = project.description(mode)
    const development = mode === "development" && program.client && (program.client.start ?? true)
      ? project.config.client?.development
      : undefined
    const command = development?.startCommand

    if (command) await assertAvailable(development.url)

    const client = command ? new DevelopmentClient(command, project.directory) : undefined
    const controller = new AbortController()
    const signal = this.signal(options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal)

    try {
      if (development) yield* waitForDevelopmentClient(development, client, signal)

      const lifecycle = this.program({ word: "run", program, options: options.options ?? {} }, signal)
      const iterator = lifecycle[Symbol.asyncIterator]()
      let lifecycleNext = iterator.next()
      let exit = client?.exited()
      let output = client?.outputAvailable()

      while (true) {
        for (const event of client?.drain() ?? []) yield event

        const outcome = await Promise.race([
          lifecycleNext.then(result => ({ source: "system" as const, result })),
          ...(exit ? [exit.then(result => ({ source: "client" as const, result }))] : []),
          ...(output ? [output.then(() => ({ source: "output" as const }))] : [])
        ])

        if (outcome.source === "output") {
          output = client?.outputAvailable()
          continue
        }

        if (outcome.source === "client") {
          exit = undefined
          if (!client?.endingWasRequested()) throw commandFailure(outcome.result)
          continue
        }

        if (outcome.result.done) return
        yield outcome.result.value
        lifecycleNext = iterator.next()
      }
    } finally {
      controller.abort(new Error("The local Program run ended"))
      await client?.stop()
    }
  }

  private program(request: ProgramRequest, signal?: AbortSignal): AsyncGenerator<GatewayEvent, void, void> {
    return this.lifecycle(request, signal)
  }

  private control(request: object, signal?: AbortSignal) {
    this.requireOpen()
    return gatewayRequest(this.address, "system", request, this.signal(signal))
  }

  private api(request: object, signal?: AbortSignal) {
    this.requireOpen()
    return gatewayRequest(this.address, "api", request, this.signal(signal))
  }

  private lifecycle(request: object, signal?: AbortSignal): AsyncGenerator<GatewayEvent, void, void> {
    this.requireOpen()
    return streamProgram(this.address, request, this.signal(signal))
  }

  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }

  private requireOpen() {
    if (this.closed) throw new Error("This Gateway is closed")
  }
}

export interface InstallOptions {
  run?: boolean
  startup?: boolean
  signal?: AbortSignal
}

export interface RunOptions {
  options?: Record<string, string>
  signal?: AbortSignal
}

export interface UninstallOptions {
  everything?: boolean
  signal?: AbortSignal
}

type ProgramRequest = Readonly<{
  word: "install"
  program: ProgramDescription
  run: boolean
  startup: boolean
}> | Readonly<{
  word: "run"
  program: ProgramDescription
  options: Record<string, string>
}> | Readonly<{
  word: "uninstall"
  identity: string
  everything: boolean
}>
