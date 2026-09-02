import {
  isRelativeValue,
  layers,
  type Config,
  type ClientDevelopment,
  type Position,
  type ProgramDefinition,
  type ServerExecution,
  type Size,
  type System as SystemContract,
} from "@phreshos/core"
import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { delimiter, isAbsolute, join, normalize, resolve, sep } from "node:path"
import { createJiti } from "jiti"
import DevelopmentClient from "./development-client.js"

const configFile = "phresh.config.ts"
const defaultClientPort = 5200

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

  /** Create a Project from an already loaded authoring configuration. */
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

  /** Resolve this authoring configuration into its production Program definition. */
  public productionDefinition(): ProgramDefinition {
    return this.definition("production")
  }

  /** Resolve this authoring configuration into its development Program definition. */
  public developmentDefinition(): ProgramDefinition {
    return this.definition("development")
  }

  private definition(mode: ProjectMode, developmentClientUrl?: string): ProgramDefinition {
    const config = this.config
    const server = serverHalf(config.server, mode)
    const client = clientHalf(config.client, mode, developmentClientUrl)

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
        service: server.service,
        installCommand: config.server?.installCommand,
        uninstallCommand: config.server?.uninstallCommand,
        ...serverExecution(server)
      } },
      ...client && { client: {
        location: /^https?:\/\//i.test(client.location) ? client.location : resolve(this.directory, client.location),
        start: client.start,
        service: client.service,
        title: config.client?.title,
        size: config.client?.size,
        position: config.client?.position,
        layer: config.client?.layer,
        minimize: config.client?.minimize,
        permissions: config.client?.permissions
      } }
    } as ProgramDefinition
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

  /** Build this Project and return its production Process lifecycle generator. */
  public async start(system: SystemContract, options: ProjectRunOptions = {}) {
    await this.build()
    return await this.run(system, this.productionDefinition(), options)
  }

  /** Prepare this Project's Client development source and return its Process lifecycle. */
  public async dev(system: SystemContract, options: ProjectRunOptions = {}) {
    const development = this.config.client?.development
    const startsClient = Boolean(development && (this.config.client?.start ?? true))

    if (!startsClient || !development) return await this.run(system, this.developmentDefinition(), options)

    if (development.startCommand) return this.developmentRun(system, development, options)

    const prepared = await this.prepareDevelopment(system, development, options)
    return prepared.client.supervise(prepared.lifecycle)
  }

  private async *developmentRun(system: SystemContract, development: ClientDevelopment, options: ProjectRunOptions) {
    const prepared = await this.prepareDevelopment(system, development, options)

    yield* prepared.client.supervise(prepared.lifecycle)
  }

  private async prepareDevelopment(system: SystemContract, development: ClientDevelopment, options: ProjectRunOptions) {
    const client = await DevelopmentClient.prepare(development, this.directory)
    const program = await system.forceCreateProgram(this.definition("development", client.url))

    try {
      await client.start(program.assetId, options.signal)
      const lifecycle = program.process.run({ options: options.options ?? {} }, { signal: client.processSignal(options.signal) })
      return { client, lifecycle }
    } catch (error) {
      await client.dispose(error)
      await program.forget().catch(() => undefined)
      throw error
    }
  }

  /** Build this Project and return its Program installation generator. */
  public async install(system: SystemContract) {
    await this.build()
    const program = await system.forceCreateProgram(this.productionDefinition())
    return program.install()
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

    const declaration = Buffer.from(JSON.stringify(packageDefinition(this.config, version), null, 4) + "\n")
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

  private async run(system: SystemContract, definition: ProgramDefinition, options: ProjectRunOptions) {
    const program = await system.forceCreateProgram(definition)
    return program.process.run({ options: options.options ?? {} }, { signal: options.signal })
  }
}

export type ProjectMode = "production" | "development"

export interface ProjectOptions { directory?: string }

export interface ProjectRunOptions {
  options?: Record<string, string>
  signal?: AbortSignal
}

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

function serverHalf(half: Config["server"], mode: ProjectMode) {
  if (!half) return null

  const { development, startCommand, entryFile, ...declared } = half

  if (mode === "production" || !development) return { ...declared, ...serverExecution({ startCommand, entryFile } as ServerExecution) }

  return { ...declared, location: ".", ...serverExecution(development) }
}

function serverExecution(server: ServerExecution) {
  return server.startCommand !== undefined ? { startCommand: server.startCommand } : { entryFile: server.entryFile }
}

function clientHalf(half: Config["client"], mode: ProjectMode, developmentUrl?: string) {
  if (!half) return null
  const { development, ...declared } = half
  return mode === "development" && development
    ? { ...declared, location: developmentUrl ?? development.url ?? `http://localhost:${defaultClientPort}/` }
    : declared
}

function validateConfig(config: Config) {
  if (typeof config.identity !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.identity)) {
    throw new Error("A Program's identity must be kebab-case")
  }
  if (!config.server && !config.client) throw new Error("A Program must have a Server Endpoint, a Client Endpoint, or both")

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
    if (declared.service !== undefined && typeof declared.service !== "boolean") throw new Error(`A declared ${half} Endpoint's service default must be true or false`)
  }

  if (!(config.server && (config.server.start ?? true)) && !(config.client && (config.client.start ?? true))) {
    throw new Error("A Program's default Process must start a Server Endpoint, a Client Endpoint, or both")
  }

  if (config.server) execution(config.server, "A Server Endpoint")
  if (config.server?.development) execution(config.server.development, "server.development")

  if (config.client?.layer !== undefined && !layers.includes(config.client.layer)) {
    throw new Error(`A Client Endpoint's layer must be one of ${layers.join(", ")}`)
  }

  if (config.client?.development) {
    const development = config.client.development
    if (development.url !== undefined && !httpUrl(development.url)) {
      throw new Error("client.development.url must be a valid HTTP or HTTPS URL")
    }
    if (development.startCommand !== undefined && (typeof development.startCommand !== "string" || !development.startCommand.trim())) {
      throw new Error("client.development.startCommand must be non-empty text")
    }
    if (development.url === undefined && development.startCommand === undefined) {
      throw new Error("client.development must declare a URL or start command")
    }
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

function packageDefinition(config: Config, version: string) {
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
      service: config.server.service,
      installCommand: config.server.installCommand,
      uninstallCommand: config.server.uninstallCommand,
      ...serverExecution(config.server)
    } },
    ...config.client && { client: {
      location: "client",
      start: config.client.start,
      service: config.client.service,
      title: config.client.title,
      size: config.client.size,
      position: config.client.position,
      layer: config.client.layer,
      minimize: config.client.minimize,
      permissions: config.client.permissions
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
