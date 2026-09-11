import {
  Storage,
  StorageFile,
  type FileStat,
  type StorageChange,
  type StorageListOptions,
  type StorageReadOptions,
  type StorageSpace,
  type StorageStat,
  type StorageTransferOptions,
  type StorageWatchOptions,
  type StorageWriteOptions,
  type WritableContent
} from "@phreshos/core"
import { randomUUID } from "node:crypto"
import {
  createReadStream,
  createWriteStream,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync
} from "node:fs"
import { rm, watch as watchPath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { content } from "./content.js"

/** Create one filesystem implementation bounded beneath a resolved absolute root. */
export function filesystemStorage(source: string | (() => Promise<string>), label: string, lifetime?: Lifetime): Storage {
  return new NodeStorage(new StorageBoundary(source, label, contained, lifetime), [])
}

/** Create native filesystem access entered from one resolved absolute path. */
export function nativeStorage(source: string | (() => Promise<string>), label: string, lifetime?: Lifetime): Storage {
  return new NodeStorage(new StorageBoundary(source, label, native, lifetime), [])
}

class StorageBoundary {
  private root: Promise<string> | null = null

  public constructor(
    private readonly source: string | (() => Promise<string>),
    public readonly label: string,
    private readonly locate: Locator,
    private readonly lifetime?: Lifetime
  ) {}

  public active() {
    const signal = this.lifetime?.()
    signal?.throwIfAborted()
    return signal
  }

  public async path(parts: readonly string[]) {
    return this.locate(await this.rootPath(), parts)
  }

  private rootPath() {
    this.active()

    if (!this.root) {
      const resolving = Promise.resolve(typeof this.source === "string" ? this.source : this.source()).then(value => {
        this.active()
        if (!isAbsolute(value)) throw new Error("A Storage root must be absolute")
        return value
      })

      const retained = resolving.catch(error => {
        if (this.root === retained) this.root = null
        throw error
      })

      this.root = retained
    }

    return this.root
  }
}

class NodeStorage extends Storage {
  public constructor(private readonly boundary: StorageBoundary, private readonly parts: readonly string[]) {
    super()
  }

  public async name() { const path = await this.path(); return basename(path) || path }
  public path() { return this.boundary.path(this.parts) }

  public navigate(...parts: string[]) {
    return new NodeStorage(this.boundary, [...this.parts, ...parts])
  }

  public file(...parts: [string, ...string[]]) {
    return new NodeStorageFile(this.boundary, [...this.parts, ...parts])
  }

  public async create() {
    this.boundary.active()
    mkdirSync(await this.path(), { recursive: true })
  }

  public async stat(): Promise<StorageStat | null> {
    this.boundary.active()
    const value = describe(await this.path())
    if (!value) return null
    if (value.kind !== "storage") throw new Error(`${await this.path()} is not a Storage directory`)
    return value.stat
  }

  public async list(options: StorageListOptions = {}) {
    this.boundary.active()
    const depth = listDepth(options)
    const entries: Array<Storage | StorageFile> = []
    await this.collect(entries, [], depth)
    return entries
  }

  private async collect(entries: Array<Storage | StorageFile>, relativeParts: string[], depth: number) {
    if (depth === 0) return
    const location = this.navigate(...relativeParts)
    const found = await location.stat()
    if (!found) throw new Error(`There is no ${await location.path()} in ${this.boundary.label}`)

    for (const name of readdirSync(await location.path()).sort()) {
      const childParts = [...relativeParts, name]
      const child = describe(await this.boundary.path([...this.parts, ...childParts]))
      if (!child) continue

      if (child.kind === "file") entries.push(this.file(...childParts as [string, ...string[]]))
      else {
        entries.push(this.navigate(...childParts))
        if (depth > 1) await this.collect(entries, childParts, depth - 1)
      }
    }
  }

  public async copy(destination: Storage, options: StorageTransferOptions = {}) {
    await copyStorage(this, destination, options)
  }

  public async move(destination: Storage, options: StorageTransferOptions = {}) {
    const [sourcePath, destinationPath] = await Promise.all([this.path(), destination.path()])
    if (samePath(sourcePath, destinationPath)) return
    await copyStorage(this, destination, options)
    await this.delete()
  }

  public async delete() {
    this.boundary.active()
    rmSync(await this.path(), { recursive: true, force: true })
  }

  public async clear() {
    this.boundary.active()
    const destination = await this.path()
    const found = describe(destination)
    if (found?.kind === "file") throw new Error("Only a Storage directory can be cleared")
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
  }

  public async space(): Promise<StorageSpace> {
    this.boundary.active()
    const value = statfsSync(await this.path())
    const capacity = value.blocks * value.bsize
    const available = value.bavail * value.bsize
    return { capacity, available, used: capacity - value.bfree * value.bsize }
  }

  public async *watch(options: StorageWatchOptions = {}): AsyncGenerator<StorageChange, void, void> {
    const lifetime = this.boundary.active()
    const signal = combinedSignal(lifetime, options.signal)

    for await (const change of watchPath(await this.path(), { recursive: options.recursive, signal })) {
      yield { event: change.eventType, path: change.filename === null ? null : String(change.filename) }
    }
  }
}

class NodeStorageFile extends StorageFile {
  public constructor(private readonly boundary: StorageBoundary, private readonly parts: readonly string[]) {
    super()
  }

  public async name() { const path = await this.path(); return basename(path) || path }
  public path() { return this.boundary.path(this.parts) }

  public async stat(): Promise<FileStat | null> {
    this.boundary.active()
    const value = describe(await this.path())
    if (!value) return null
    if (value.kind !== "file") throw new Error(`${await this.path()} is not a file`)
    return value.stat
  }

  public async stream(options: StorageReadOptions = {}) {
    const signal = this.boundary.active()
    const destination = await this.path()
    const found = await this.stat()
    if (!found) throw new Error(`There is no ${this.parts.join("/")} in ${this.boundary.label}`)
    if (options.length === 0) return new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    const range = readRange(options)
    return Readable.toWeb(createReadStream(destination, { ...range, signal })) as unknown as ReadableStream<Uint8Array>
  }

  public async bytes(options?: StorageReadOptions) {
    return new Uint8Array(await new Response(await this.stream(options)).arrayBuffer())
  }

  public async text(options?: StorageReadOptions) {
    return new Response(await this.stream(options)).text()
  }

  public async json<Value>() {
    return JSON.parse(await this.text()) as Value
  }

  public async write(value: WritableContent, options: StorageWriteOptions = {}) {
    const signal = this.boundary.active()
    const destination = await this.path()
    const temporary = join(dirname(destination), `.${randomUUID()}.writing`)
    mkdirSync(dirname(destination), { recursive: true })

    try {
      await pipeline(
        Readable.fromWeb(content(value).stream as unknown as NodeReadableStream<Uint8Array>),
        createWriteStream(temporary, { flags: "wx" }),
        { signal }
      )
      signal?.throwIfAborted()

      if (options.overwrite === false) {
        linkSync(temporary, destination)
        rmSync(temporary, { force: true })
      } else renameSync(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  public async append(value: WritableContent) {
    const signal = this.boundary.active()
    const destination = await this.path()
    mkdirSync(dirname(destination), { recursive: true })
    await pipeline(
      Readable.fromWeb(content(value).stream as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(destination, { flags: "a" }),
      { signal }
    )
  }

  public async copy(destination: StorageFile, options: StorageTransferOptions = {}) {
    const [sourcePath, destinationPath] = await Promise.all([this.path(), destination.path()])
    if (samePath(sourcePath, destinationPath)) return
    await destination.write(await this.stream(), { overwrite: options.overwrite ?? false })
  }

  public async move(destination: StorageFile, options: StorageTransferOptions = {}) {
    const [sourcePath, destinationPath] = await Promise.all([this.path(), destination.path()])
    if (samePath(sourcePath, destinationPath)) return
    await this.copy(destination, options)
    await this.delete()
  }

  public async delete() {
    this.boundary.active()
    rmSync(await this.path(), { force: true })
  }
}

type Locator = (root: string, parts: readonly string[]) => string
type Lifetime = () => AbortSignal
type DescribedEntry = { kind: "storage", stat: StorageStat } | { kind: "file", stat: FileStat }

function native(root: string, parts: readonly string[]) {
  return resolvePath(root, ...parts)
}

function contained(root: string, parts: readonly string[]) {
  const destination = join(root, ...parts)
  const step = relative(root, destination)
  if (step === ".." || step.startsWith(`..${sep}`) || isAbsolute(step)) throw new Error("A Storage path may not leave its configured boundary")

  let current = root
  for (const part of step.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("A Storage path may not pass through a symbolic link")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
  }
  return destination
}

function describe(path: string): DescribedEntry | null {
  let value
  try { value = statSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  const modifiedAt = Math.round(value.mtimeMs)
  if (value.isFile()) return { kind: "file", stat: { size: value.size, modifiedAt } }
  if (value.isDirectory()) return { kind: "storage", stat: { modifiedAt } }
  throw new Error(`${path} is neither a file nor a Storage directory`)
}

function readRange(options: StorageReadOptions) {
  const offset = options.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("A Storage read offset must be a non-negative safe integer")
  if (options.length === undefined) return { start: offset }
  if (!Number.isSafeInteger(options.length) || options.length < 0) throw new Error("A Storage read length must be a non-negative safe integer")
  if (!Number.isSafeInteger(offset + options.length)) throw new Error("A Storage byte range must use safe integers")
  return { start: offset, end: offset + options.length - 1 }
}

function listDepth(options: StorageListOptions) {
  if (options.depth !== undefined && (!Number.isSafeInteger(options.depth) || options.depth < 0)) {
    throw new Error("A Storage list depth must be a non-negative safe integer")
  }
  if (options.depth !== undefined && !options.recursive) throw new Error("A Storage list depth requires recursive listing")
  if (!options.recursive) return 1
  return options.depth ?? Number.POSITIVE_INFINITY
}

async function copyStorage(source: Storage, destination: Storage, options: StorageTransferOptions) {
  const [sourcePath, destinationPath] = await Promise.all([source.path(), destination.path()])
  if (samePath(sourcePath, destinationPath)) return
  if (descendsFrom(destinationPath, sourcePath)) throw new Error("A Storage directory cannot be copied inside itself")
  if (!await source.stat()) throw new Error(`There is no Storage directory at ${sourcePath}`)

  if (await destination.stat()) {
    if (!options.overwrite) throw new Error(`A Storage directory already exists at ${destinationPath}`)
    await destination.delete()
  }

  await destination.create()
  for (const entry of await source.list()) {
    const name = await entry.name()
    if (entry instanceof StorageFile) await entry.copy(destination.file(name), options)
    else await entry.copy(destination.navigate(name), options)
  }
}

function samePath(left: string, right: string) {
  return resolvePath(left) === resolvePath(right)
}

function descendsFrom(path: string, parent: string) {
  const step = relative(parent, path)
  return step !== "" && step !== ".." && !step.startsWith(`..${sep}`) && !isAbsolute(step)
}

function combinedSignal(left?: AbortSignal, right?: AbortSignal) {
  if (left && right) return AbortSignal.any([left, right])
  return left ?? right
}
