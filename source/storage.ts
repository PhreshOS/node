import type { EntryStat, SystemStorage } from "@phreshos/core"
import { randomUUID } from "node:crypto"
import { createReadStream, createWriteStream, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"

/** Create one filesystem implementation bounded beneath a resolved absolute root. */
export function filesystemStorage(source: string | (() => Promise<string>), label: string): SystemStorage {
  let root: Promise<string> | null = null

  const resolveRoot = () => {
    if (!root) root = Promise.resolve(typeof source === "string" ? source : source()).then(value => {
      if (!isAbsolute(value)) throw new Error("A Storage root must be absolute")
      return value
    })
    return root
  }

  const path = () => resolveRoot()
  const resolve = async (...parts: string[]) => contained(await path(), parts)

  async function stream(...parts: [string, ...string[]]) {
    const destination = await resolve(...parts)
    const found = describe(destination)
    if (!found) throw new Error(`There is no ${parts.join("/")} in ${label}`)
    if (found.kind !== "file") throw new Error(`${parts.join("/")} is not a file`)
    return Readable.toWeb(createReadStream(destination)) as unknown as ReadableStream<Uint8Array>
  }

  async function write(...args: [...path: [string, ...string[]], value: unknown]) {
    const parts = args.slice(0, -1) as string[]
    const destination = await resolve(...parts)
    const temporary = join(dirname(destination), `.${randomUUID()}.writing`)
    mkdirSync(dirname(destination), { recursive: true })

    try {
      await pipeline(
        Readable.fromWeb(content(args.at(-1)) as unknown as NodeReadableStream<Uint8Array>),
        createWriteStream(temporary, { flags: "wx" })
      )
      renameSync(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  return {
    path,
    resolve,
    stream,
    async bytes(...parts) { return new Uint8Array(await new Response(await stream(...parts)).arrayBuffer()) },
    async text(...parts) { return new Response(await stream(...parts)).text() },
    async json<Value>(...parts: [string, ...string[]]) { return JSON.parse(await new Response(await stream(...parts)).text()) as Value },
    write,
    async stat(...parts) { return describe(await resolve(...parts)) },
    async list(...parts) { return readdirSync(await resolve(...parts)).sort() },
    async delete(...parts) {
      if (!parts.length) throw new Error("Emptying a place is clear, not delete")
      rmSync(await resolve(...parts), { recursive: true, force: true })
    },
    async clear(...parts) {
      const destination = await resolve(...parts)
      const found = describe(destination)
      if (found && found.kind !== "directory") throw new Error("Only a Storage directory can be cleared")
      rmSync(destination, { recursive: true, force: true })
      mkdirSync(destination, { recursive: true })
    }
  }
}

function content(value: unknown): ReadableStream<Uint8Array> {
  if (value instanceof ReadableStream) return value
  if (value instanceof Uint8Array) return new Blob([bytes(value)]).stream()
  if (value instanceof ArrayBuffer) return new Blob([value]).stream()
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.stream()
  if (typeof value === "string") return new Blob([value]).stream()
  return new Blob([JSON.stringify(value)]).stream()
}

function bytes(value: Uint8Array) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function contained(root: string, parts: string[]) {
  const destination = join(root, ...parts)
  const step = relative(root, destination)
  if (step === ".." || step.startsWith(`..${sep}`) || isAbsolute(step)) throw new Error("A Storage path may not leave its configured directory")

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

function describe(path: string): EntryStat | null {
  let value
  try { value = statSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  if (value.isFile()) return { kind: "file", size: value.size, modifiedAt: value.mtimeMs }
  if (value.isDirectory()) return { kind: "directory", modifiedAt: value.mtimeMs }
  return { kind: "other", modifiedAt: value.mtimeMs }
}
