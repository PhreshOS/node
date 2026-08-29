import {
  isRelativeValue,
  layers,
  type Config,
  type Exit,
  type Position,
  type ProgramDescription,
  type ServerExecution,
  type Size,
  type System as SystemContract,
  type SystemProcessEntity,
  type SystemProgramEntity
} from "@phreshos/core"
import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { delimiter, isAbsolute, join, normalize, resolve, sep } from "node:path"
import { createJiti } from "jiti"
import { assertAvailable, commandFailure, DevelopmentClient, waitForDevelopmentClient } from "./client-development.js"

const configFile = "phresh.config.ts"

/** One loaded Program authoring project rooted at an absolute directory. */
export class Project {
  public readonly directory: string
  public readonly config: Config

  private constructor(config: Config, directory: string) {
    validateConfig(config)
    this.directory = resolve(directory)
    this.config = Object.freeze(config)
  }

  /** Discover a project from cwd, a directory, or a phresh.config.ts path. */
  public static async open(source: string = process.cwd()) {
    const selected = resolve(source)
    const path = selected.endsWith(configFile) ? selected : resolve(selected, configFile)

    if (!existsSync(path)) throw new Error(`There is no ${configFile} here — run: phresh init`)

    const config = await createJiti(import.meta.url).import<Config>(path, { default: true }).catch((error: Error) => {
      throw new Error(`${configFile} could not be read (${error.message})`)
    })

    if (!config) throw new Error(`${configFile} must export its config as the default export`)

    return new Project(config, resolve(path, ".."))
  }

  /** Create a project from an already loaded definition. */
  public static define(config: Config, options: ProjectOptions = {}) {
    return new Project(config, options.directory ?? process.cwd())
  }

  /** Read this project's package manifest. */
  public async manifest() {
    const path = resolve(this.directory, "package.json")

    if (!existsSync(path)) throw new Error("There is no package.json here")

    const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest

    if (typeof manifest.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
      throw new Error("package.json must have a kebab-case name")
    }

    return manifest
  }

  /** Resolve this authoring definition into one runnable Program description. */
  public description(mode: ProjectMode): ProgramDescription {
    const config = this.config
    const server = serverHalf(config.server, mode)
    const client = clientHalf(config.client, mode)

    if (mode === "development" && !config.server?.development && !config.client?.development) {
      throw new Error("Nothing here says how this Program is developed")
    }

    return {
      identity: config.identity,
      name: config.name,
      version: config.version,
      description: config.description,
      icon: config.icon && resolve(this.directory, config.icon),
      agent: config.agent && resolve(this.directory, config.agent),
      storage: resolve(this.directory, "storage"),
      ...server && { server: {
        location: resolve(this.directory, server.location),
        start: server.start,
        installCommand: config.server?.installCommand,
        uninstallCommand: config.server?.uninstallCommand,
        ...serverExecution(server)
      } },
      ...client && { client: {
        location: /^https?:\/\//i.test(client.location) ? client.location : resolve(this.directory, client.location),
        start: client.start,
        title: config.client?.title,
        size: config.client?.size,
        position: config.client?.position,
        layer: config.client?.layer,
        minimize: config.client?.minimize
      } }
    } as ProgramDescription
  }

  /** Run the optional author-owned production build command. */
  public async build() {
    const command = this.config.buildCommand
    if (!command) return

    await new Promise<void>((done, fail) => {
      const child = spawn(command, {
        cwd: this.directory,
        env: commandEnvironment(this.directory),
        shell: true,
        stdio: "inherit"
      })

      child.once("error", error => fail(new Error(`Build command failed: ${error.message}`)))
      child.once("exit", (code, signal) => {
        if (signal) fail(new Error(`Build command ended on ${signal}`))
        else if (code !== 0) fail(new Error(`Build command exited with ${code ?? 0}`))
        else done()
      })
    })
  }

  /** Build and run this project's production Program until its Process exits. */
  public async start(system: SystemContract, options: ProjectRunOptions = {}) {
    await this.build()
    return await this.run(system, "production", options)
  }

  /** Run this project's development Program and its optional Client server. */
  public async dev(system: SystemContract, options: ProjectRunOptions = {}) {
    return await this.run(system, "development", options)
  }

  /** Build and install this project's production Program. */
  public async install(system: SystemContract): Promise<SystemProgramEntity> {
    await this.build()
    const program = await system.forceCreateProgram(this.description("production"))
    let installed = false

    try {
      for await (const chunk of program.install()) write(chunk.stream, chunk.text)
      installed = true
      return program
    } finally {
      if (!installed) await forgetCurrent(program)
    }
  }

  /** Build and package this Program into its canonical release shape. */
  public async pack(): Promise<PackedProject> {
    await this.build()

    const manifest = await this.manifest()
    const version = this.config.version ?? manifest.version ?? "0.0.0"
    const zip = new AdmZip()

    if (this.config.server) place(zip, this.directory, this.config.server.location, "server")
    if (this.config.client) {
      place(zip, this.directory, this.config.client.location, "client")
      if (!zip.getEntry("client/index.html")) throw new Error(`The Client files have no index.html at ${this.config.client.location}`)
    }
    if (this.config.icon) file(zip, this.directory, this.config.icon, "icon.png", "Program icon")
    if (this.config.agent) file(zip, this.directory, this.config.agent, "agent.md", "Program agent documentation")

    const declaration = Buffer.from(JSON.stringify(packageDescription(this.config, version), null, 4) + "\n")
    zip.addFile("program.json", declaration)

    const archive = `${this.config.identity}@${version}.zip`
    const bytes = zip.toBuffer()
    const digest = createHash("sha256").update(bytes).digest("hex")
    const archivePath = resolve(this.directory, archive)
    const declarationPath = resolve(this.directory, "program.json")
    const checksumPath = resolve(this.directory, `${archive}.sha256`)

    writeFileSync(declarationPath, declaration)
    writeFileSync(archivePath, bytes)
    writeFileSync(checksumPath, `${digest}  ${archive}\n`)

    return Object.freeze({ archive, archivePath, checksumPath, declarationPath, digest })
  }

  private async run(system: SystemContract, mode: ProjectMode, options: ProjectRunOptions): Promise<ProjectRunResult> {
    const description = this.description(mode)
    const development = mode === "development" && description.client && (description.client.start ?? true)
      ? this.config.client?.development
      : undefined
    const command = development?.startCommand

    if (command) await assertAvailable(development.url)

    const client = command ? new DevelopmentClient(command, this.directory) : undefined
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    let program: SystemProgramEntity | null = null

    try {
      if (development) {
        for await (const event of waitForDevelopmentClient(development, client, signal)) presentDevelopment(event)
      }

      program = await system.forceCreateProgram(description)
      const run = program.process.run({ options: options.options ?? {} }, { signal })
      const iterator = run[Symbol.asyncIterator]()
      let lifecycle = iterator.next()
      let developmentExit = client?.exited()
      let developmentOutput = client?.outputAvailable()
      let process: SystemProcessEntity | null = null
      let ending: Exit | null = null

      while (true) {
        for (const event of client?.drain() ?? []) presentDevelopment(event)

        const outcome = await Promise.race([
          lifecycle.then(result => ({ source: "system" as const, result })),
          ...(developmentExit ? [developmentExit.then(result => ({ source: "client" as const, result }))] : []),
          ...(developmentOutput ? [developmentOutput.then(() => ({ source: "output" as const }))] : [])
        ])

        if (outcome.source === "output") {
          developmentOutput = client?.outputAvailable()
          continue
        }

        if (outcome.source === "client") {
          developmentExit = undefined
          if (!client?.endingWasRequested()) throw commandFailure(outcome.result)
          continue
        }

        if (outcome.result.done) break

        const event = outcome.result.value
        if (event.event === "started") process = event.process
        else if (event.event === "output") write(event.stream, event.text)
        else ending = event.exit

        lifecycle = iterator.next()
      }

      if (!process || !ending) throw new Error("The System ended the Program run without a complete Process lifecycle")

      return Object.freeze({ process, exit: ending })
    } finally {
      controller.abort(new Error("The Project run ended"))
      await client?.stop()
      if (program) await forgetCurrent(program)
    }
  }
}

export type ProjectMode = "production" | "development"

export interface ProjectOptions { directory?: string }

export interface ProjectRunOptions {
  options?: Record<string, string>
  signal?: AbortSignal
}

export type ProjectRunResult = Readonly<{
  process: SystemProcessEntity
  exit: Exit
}>

export type PackedProject = Readonly<{
  archive: string
  archivePath: string
  checksumPath: string
  declarationPath: string
  digest: string
}>

export interface Manifest {
  name: string
  version?: string
  description?: string
  packageManager?: string
  scripts?: Record<string, string>
}

function presentDevelopment(event: { event?: string, stream?: unknown, text?: unknown }) {
  if (event.event === "output") write(event.stream === "err" ? "stderr" : "stdout", String(event.text ?? ""))
}

function write(stream: "stdout" | "stderr", text: string) {
  (stream === "stderr" ? process.stderr : process.stdout).write(text)
}

async function forgetCurrent(program: SystemProgramEntity) {
  try { await program.forget() }
  catch (error) {
    if (error instanceof Error && error.message === "The Program represented by this handle does not exist") return
    throw error
  }
}

function serverHalf(half: Config["server"], mode: ProjectMode) {
  if (!half) return null

  const { development, startCommand, entryFile, ...description } = half

  if (mode === "production" || !development) return { ...description, ...serverExecution({ startCommand, entryFile } as ServerExecution) }

  return { ...description, location: ".", ...serverExecution(development) }
}

function serverExecution(server: ServerExecution) {
  return server.startCommand !== undefined ? { startCommand: server.startCommand } : { entryFile: server.entryFile }
}

function clientHalf(half: Config["client"], mode: ProjectMode) {
  if (!half) return null
  const { development, ...declared } = half
  return mode === "development" && development ? { ...declared, location: development.url } : declared
}

function validateConfig(config: Config) {
  if (typeof config.identity !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.identity)) {
    throw new Error("A Program's identity must be kebab-case")
  }
  if (!config.server && !config.client) throw new Error("A Program must have a Server half, a Client half, or both")

  for (const field of ["name", "version", "description", "icon", "agent", "website"] as const) {
    if (config[field] !== undefined && typeof config[field] !== "string") throw new Error(`A Program's ${field} must be text`)
  }

  if (config.agent !== undefined && config.agent.trim().length === 0) throw new Error("A Program's agent documentation must be a non-empty path")
  if (config.website !== undefined) {
    try { new URL(config.website) }
    catch { throw new Error("A Program's website must be a valid URL") }
  }

  for (const half of ["server", "client"] as const) {
    const declared = config[half]
    if (!declared) continue
    if (typeof declared.location !== "string") throw new Error(`A declared ${half} half must have a location`)
    if (declared.start !== undefined && typeof declared.start !== "boolean") throw new Error(`A declared ${half} Endpoint's start default must be true or false`)
  }

  if (!(config.server && (config.server.start ?? true)) && !(config.client && (config.client.start ?? true))) {
    throw new Error("A Program's default Process must start a Server Endpoint, a Client Endpoint, or both")
  }

  if (config.server) execution(config.server, "A Server half")
  if (config.server?.development) execution(config.server.development, "server.development")

  if (config.client?.layer !== undefined && !layers.includes(config.client.layer)) {
    throw new Error(`A Client half's layer must be one of ${layers.join(", ")}`)
  }

  if (config.client?.development && !httpUrl(config.client.development.url)) {
    throw new Error("client.development.url must be a valid HTTP or HTTPS URL")
  }

  for (const [name, value] of [["size", config.client?.size], ["position", config.client?.position]] as const) {
    if (value === undefined) continue
    const pair = name === "size" ? [(value as Size).width, (value as Size).height] : [(value as Position).x, (value as Position).y]
    if (!pair.every(isRelativeValue)) throw new Error(`A Window's ${name} values must be pixels or relative expressions`)
  }
}

function execution(value: { startCommand?: unknown, entryFile?: unknown }, owner: string) {
  const command = typeof value.startCommand === "string" && value.startCommand.trim().length > 0
  const entry = typeof value.entryFile === "string" && value.entryFile.trim().length > 0

  if (command === entry) throw new Error(`${owner} must declare exactly one non-empty startCommand or entryFile`)
  if (entry && !contained(value.entryFile as string)) throw new Error(`${owner}'s entryFile must remain inside its Server directory`)
}

function contained(entry: string) {
  if (isAbsolute(entry)) return false
  const path = normalize(entry)
  return path !== ".." && !path.startsWith(`..${sep}`)
}

function httpUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch { return false }
}

function commandEnvironment(directory: string) {
  const key = Object.keys(process.env).find(name => name.toLowerCase() === "path") ?? "PATH"
  const inherited = process.env[key]
  return { ...process.env, [key]: [join(directory, "node_modules", ".bin"), inherited].filter(Boolean).join(delimiter) }
}

function packageDescription(config: Config, version: string) {
  return {
    identity: config.identity,
    name: config.name,
    version,
    description: config.description,
    icon: config.icon ? "icon.png" : undefined,
    agent: config.agent ? "agent.md" : undefined,
    categories: config.categories,
    keywords: config.keywords,
    website: config.website,
    ...config.server && { server: {
      location: "server",
      start: config.server.start,
      installCommand: config.server.installCommand,
      uninstallCommand: config.server.uninstallCommand,
      ...serverExecution(config.server)
    } },
    ...config.client && { client: {
      location: "client",
      start: config.client.start,
      title: config.client.title,
      size: config.client.size,
      position: config.client.position,
      layer: config.client.layer,
      minimize: config.client.minimize
    } }
  }
}

function place(zip: AdmZip, directory: string, location: string, half: string) {
  const from = resolve(directory, location)
  if (!existsSync(from)) throw new Error(`The ${half} files are not at ${location}`)
  zip.addLocalFolder(from, half)
}

function file(zip: AdmZip, directory: string, location: string, target: string, label: string) {
  const from = resolve(directory, location)
  if (!existsSync(from) || !statSync(from).isFile()) throw new Error(`The ${label} is not at ${location}`)
  zip.addFile(target, readFileSync(from))
}
