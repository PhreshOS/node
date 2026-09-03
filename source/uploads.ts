import { isUploadFile, type SystemUploads, type Upload } from "@phreshos/core"
import { randomUUID } from "node:crypto"
import { createReadStream, createWriteStream, mkdirSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"

type Ask = (request: object) => Promise<unknown>

/** Owner-local implementation of the System's opaque upload collection. */
export default class Uploads implements SystemUploads {
  private accessPromise: Promise<Access> | null = null

  public constructor(private readonly ask: Ask, private readonly lifetime: () => AbortSignal) {}

  public async path() {
    return (await this.access()).path
  }

  public async write(value: unknown): Promise<Upload> {
    const signal = this.active()
    const access = await this.access()
    const source = content(value)
    const identity = randomUUID()
    const file = `${identity}.${source.extension}`
    const temporary = join(access.path, `.${identity}.uploading`)
    const destination = join(access.path, file)
    let size = 0

    mkdirSync(access.path, { recursive: true })

    try {
      await pipeline(
        Readable.fromWeb(source.stream as unknown as NodeReadableStream<Uint8Array>),
        async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            size += chunk.byteLength
            if (size > access.limit) throw new Error(`The upload exceeds ${access.limit / 1024 / 1024 / 1024} GB`)
            yield chunk
          }
        },
        createWriteStream(temporary, { flags: "wx" }),
        { signal }
      )
      signal.throwIfAborted()
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }

    const upload = await this.stat(file)
    if (!upload) throw new Error("The completed upload could not be described")
    return upload
  }

  public async stream(file: string) {
    const signal = this.active()
    requireFile(file)
    const access = await this.access()
    return Readable.toWeb(createReadStream(join(access.path, file), { signal })) as unknown as ReadableStream<Uint8Array>
  }

  public async bytes(file: string) { return new Uint8Array(await new Response(await this.stream(file)).arrayBuffer()) }
  public async text(file: string) { return new Response(await this.stream(file)).text() }
  public async json<Value>(file: string) { return JSON.parse(await this.text(file)) as Value }

  public async stat(file: string) {
    this.active()
    requireFile(file)
    return await this.ask({ capability: "uploads", operation: "stat", file }) as Upload | null
  }

  private access() {
    this.active()
    if (!this.accessPromise) {
      const resolving = this.ask({ capability: "uploads", operation: "access" }).then(value => {
        const access = value as Partial<Access> | null
        if (!access || typeof access.path !== "string" || !isAbsolute(access.path) || typeof access.limit !== "number") throw new Error("The System returned invalid upload access")
        return { path: access.path, limit: access.limit }
      })
      const retained = resolving.catch(error => {
        if (this.accessPromise === retained) this.accessPromise = null
        throw error
      })
      this.accessPromise = retained
    }
    return this.accessPromise
  }

  private active() {
    const signal = this.lifetime()
    signal.throwIfAborted()
    return signal
  }
}

function requireFile(file: string) {
  if (!isUploadFile(file)) throw new Error("That is not an upload file")
}

function content(value: unknown) {
  if (typeof File !== "undefined" && value instanceof File) {
    const type = value.type || "application/octet-stream"
    return { stream: value.stream(), extension: extension(value.name, type) }
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) return { stream: value.stream(), extension: extension("", value.type) }
  if (value instanceof ReadableStream) return { stream: value, extension: "bin" }
  if (value instanceof Uint8Array) return { stream: new Blob([bytes(value)]).stream(), extension: "bin" }
  if (value instanceof ArrayBuffer) return { stream: new Blob([value]).stream(), extension: "bin" }
  if (typeof value === "string") return { stream: new Blob([value]).stream(), extension: "txt" }
  return { stream: new Blob([JSON.stringify(value)]).stream(), extension: "json" }
}

function bytes(value: Uint8Array) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function extension(name: string, type: string) {
  const named = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  if (named && /^[a-z0-9]+$/.test(named)) return named
  return extensions[type] ?? "bin"
}

const extensions: Readonly<Record<string, string>> = {
  "application/json": "json",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "text/plain": "txt"
}

interface Access { path: string, limit: number }
