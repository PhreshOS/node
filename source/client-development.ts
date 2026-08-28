import type { ClientDevelopment } from "@phreshos/core"
import { spawn, type ChildProcess } from "node:child_process"
import { connect } from "node:net"
import { delimiter, join } from "node:path"
import type { GatewayEvent } from "./transport.js"

const readinessTimeout = 15_000
const pollingInterval = 200
const reportingInterval = 2_000
const sandboxedClientOrigin = "null"

/** One client development server owned by a Gateway development run. */
export class DevelopmentClient {
  private readonly child: ChildProcess
  private readonly output: GatewayEvent[] = []
  private stopped = false
  private result: CommandExit | null = null
  private outputWaiter: (() => void) | null = null
  private readonly completion: Promise<CommandExit>

  public constructor(command: string, directory: string) {
    this.child = spawn(command, {
      cwd: directory,
      env: commandEnvironment(directory),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    })

    this.child.stdout?.on("data", chunk => this.push(outputEvent("out", chunk)))
    this.child.stderr?.on("data", chunk => this.push(outputEvent("err", chunk)))

    this.completion = new Promise(resolve => {
      let settled = false
      const finish = (exit: CommandExit) => {
        if (settled) return
        settled = true
        this.result = exit
        this.outputWaiter?.()
        this.outputWaiter = null
        resolve(exit)
      }
      this.child.once("error", error => finish({ code: null, signal: null, error }))
      this.child.once("exit", (code, signal) => finish({ code, signal, error: null }))
    })
  }

  public drain() { return this.output.splice(0) }

  public exited() { return this.completion }

  public exitResult() { return this.result }

  public outputAvailable() {
    if (this.output.length || this.result) return Promise.resolve()
    return new Promise<void>(resolve => { this.outputWaiter = resolve })
  }

  public async stop() {
    if (this.stopped) return
    this.stopped = true
    if (!running(this.child)) return

    terminate(this.child, "SIGTERM")
    await waitUntilStopped(this.child, 1_000)
    if (running(this.child)) terminate(this.child, "SIGKILL")
    await waitUntilStopped(this.child, 1_000)
  }

  public endingWasRequested() { return this.stopped }

  private push(event: GatewayEvent) {
    this.output.push(event)
    this.outputWaiter?.()
    this.outputWaiter = null
  }
}

/** Refuse to claim a URL already served by an unrelated process. */
export async function assertAvailable(url: string) {
  if (!await occupied(url)) return
  throw new Error(`Client development URL is already in use: ${url}`)
}

/** Wait until a development Client can be loaded by a sandboxed Program iframe. */
export async function* waitForDevelopmentClient(config: ClientDevelopment, client?: DevelopmentClient, signal?: AbortSignal) {
  const began = Date.now()
  let nextReport = began + reportingInterval

  while (Date.now() - began < readinessTimeout) {
    throwIfAborted(signal)

    for (const event of client?.drain() ?? []) yield event

    const exit = client?.exitResult()
    if (exit && !client?.endingWasRequested()) throw commandFailure(exit)

    const availability = await inspect(config.url, readinessTimeout - (Date.now() - began))
    if (availability === "ready") return
    if (availability === "cors-blocked") {
      throw new Error([
        `Client development URL responded, but does not allow the sandboxed Client origin: ${config.url}`,
        "Enable CORS so the response includes Access-Control-Allow-Origin: *."
      ].join("\n"))
    }

    const now = Date.now()
    if (now >= nextReport) {
      yield { event: "waiting", subject: "client", url: config.url }
      while (nextReport <= now) nextReport += reportingInterval
    }

    await pause(Math.min(pollingInterval, readinessTimeout - (now - began)), signal)
  }

  throw new Error(`Client development URL did not respond within 15 seconds: ${config.url}`)
}

export function commandFailure(exit: CommandExit) {
  if (exit.error) return new Error(`Client development command failed: ${exit.error.message}`)
  if (exit.signal) return new Error(`Client development command ended on ${exit.signal}`)
  return new Error(`Client development command exited with ${exit.code ?? 0}`)
}

export interface CommandExit {
  code: number | null
  signal: NodeJS.Signals | null
  error: Error | null
}

function outputEvent(stream: "out" | "err", chunk: unknown): GatewayEvent {
  return { event: "output", source: "client-development", stream, text: String(chunk) }
}

function commandEnvironment(directory: string) {
  const key = Object.keys(process.env).find(name => name.toLowerCase() === "path") ?? "PATH"
  const inherited = process.env[key]
  return { ...process.env, [key]: [join(directory, "node_modules", ".bin"), inherited].filter(Boolean).join(delimiter) }
}

async function occupied(url: string) {
  const location = new URL(url)
  const port = Number(location.port || (location.protocol === "https:" ? 443 : 80))

  return await new Promise<boolean>(resolve => {
    const socket = connect({ host: location.hostname, port })
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("timeout", () => finish(false))
  })
}

async function inspect(url: string, remaining: number): Promise<"unavailable" | "cors-blocked" | "ready"> {
  try {
    const response = await fetch(url, {
      headers: { origin: sandboxedClientOrigin },
      signal: AbortSignal.timeout(Math.max(1, Math.min(500, remaining)))
    })
    const allowedOrigin = response.headers.get("access-control-allow-origin")?.trim()
    await response.body?.cancel()
    return allowedOrigin === "*" || allowedOrigin === sandboxedClientOrigin ? "ready" : "cors-blocked"
  } catch { return "unavailable" }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) }
  catch { child.kill(signal) }
}

function running(child: ChildProcess) {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch { return child.exitCode === null && child.signalCode === null }
}

async function waitUntilStopped(child: ChildProcess, milliseconds: number) {
  const deadline = Date.now() + milliseconds
  while (running(child) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
}

function pause(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, Math.max(0, milliseconds))
    const cancel = () => {
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error("The operation was cancelled"))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
    }
    function finish() { cleanup(); resolve() }
    if (signal?.aborted) cancel()
    else signal?.addEventListener("abort", cancel, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was cancelled")
}
