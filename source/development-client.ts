import type { ClientDevelopment, SystemProcessRunEvent } from "@phreshos/core"
import { spawn, type ChildProcess } from "node:child_process"
import { connect, createServer } from "node:net"
import { delimiter, join } from "node:path"

const readinessTimeout = 15_000
const pollingInterval = 200

/** One prepared Client development source owned by a Project development run. */
export default class DevelopmentClient {
  public readonly url: string

  private readonly command: OwnedCommand | null
  private readonly controller: AbortController
  private readonly releaseSignal: () => void

  private constructor(url: string, command: OwnedCommand | null, controller: AbortController, releaseSignal: () => void) {
    this.url = url
    this.command = command
    this.controller = controller
    this.releaseSignal = releaseSignal
  }

  public static async prepare(identity: string, development: ClientDevelopment, directory: string, signal?: AbortSignal) {
    const base = `/program/${identity}/assets/`
    const url = development.url ?? `http://localhost:${await availablePort()}/`
    const controller = new AbortController()
    const releaseSignal = forwardAbort(signal, controller)
    let command: OwnedCommand | null = null

    try {
      if (development.startCommand) {
        await assertAvailable(url)
        command = new OwnedCommand(development.startCommand, directory, {
          PHRESHOS_CLIENT_BASE: base,
          PHRESHOS_CLIENT_PORT: String(portOf(url))
        })
      }

      const client = new DevelopmentClient(url, command, controller, releaseSignal)
      await client.waitUntilReady(new URL(base, url).href)
      return client
    } catch (error) {
      releaseSignal()
      controller.abort(error)
      await command?.stop()
      throw error
    }
  }

  public processSignal(fallback?: AbortSignal) {
    return this.command ? this.controller.signal : fallback
  }

  public supervise(lifecycle: AsyncGenerator<SystemProcessRunEvent, void, void>) {
    if (!this.command) {
      this.releaseSignal()
      return lifecycle
    }
    return this.supervisedLifecycle(lifecycle)
  }

  public async dispose(reason: unknown) {
    this.releaseSignal()
    this.controller.abort(reason)
    await this.command?.stop()
  }

  private async waitUntilReady(url: string) {
    const deadline = Date.now() + readinessTimeout

    while (Date.now() < deadline) {
      this.controller.signal.throwIfAborted()

      const exit = this.command?.exitResult()
      if (exit) throw commandFailure(exit)

      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now())))
        })
        await response.body?.cancel()
        if (response.ok) return
      } catch { /* The development server is still starting. */ }

      await pause(Math.min(pollingInterval, Math.max(0, deadline - Date.now())), this.controller.signal)
    }

    throw new Error(`Client development URL did not respond within 15 seconds: ${url}`)
  }

  private async *supervisedLifecycle(lifecycle: AsyncGenerator<SystemProcessRunEvent, void, void>) {
    const iterator = lifecycle[Symbol.asyncIterator]()
    const command = this.command!

    try {
      while (true) {
        const next = iterator.next()
        const outcome = await Promise.race([
          next.then(
            result => ({ source: "system" as const, result }),
            error => ({ source: "system-error" as const, error })
          ),
          command.exited().then(result => ({ source: "client" as const, result }))
        ])

        if (outcome.source === "client") {
          const error = commandFailure(outcome.result)
          this.controller.abort(error)
          await next.catch(() => undefined)
          throw error
        }

        if (outcome.source === "system-error") throw outcome.error
        if (outcome.result.done) return
        yield outcome.result.value
      }
    } finally {
      await this.dispose(new Error("The development lifecycle ended"))
      await iterator.return?.()
    }
  }
}

/** One operating-system command supervised as a complete process tree. */
class OwnedCommand {
  private readonly child: ChildProcess
  private readonly completion: Promise<CommandExit>
  private result: CommandExit | null = null
  private stopped = false

  public constructor(command: string, directory: string, environment: Readonly<Record<string, string>>) {
    this.child = spawn(command, {
      cwd: directory,
      env: commandEnvironment(directory, environment),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    })

    this.child.stdout?.pipe(process.stdout, { end: false })
    this.child.stderr?.pipe(process.stderr, { end: false })

    this.completion = new Promise(resolve => {
      const finish = (exit: CommandExit) => {
        if (this.result) return
        this.result = exit
        resolve(exit)
      }
      this.child.once("error", error => finish({ code: null, signal: null, error }))
      this.child.once("exit", (code, signal) => finish({ code, signal, error: null }))
    })
  }

  public exited() { return this.completion }
  public exitResult() { return this.result }

  public async stop() {
    if (this.stopped) return
    this.stopped = true
    if (!running(this.child)) return

    terminate(this.child, "SIGTERM")
    await waitUntilStopped(this.child, 1_000)
    if (running(this.child)) terminate(this.child, "SIGKILL")
    await waitUntilStopped(this.child, 1_000)
  }
}

async function availablePort() {
  const server = createServer()

  return await new Promise<number>((done, fail) => {
    server.once("error", fail)
    server.listen(0, "localhost", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        fail(new Error("An available Client development port could not be selected"))
        return
      }
      server.close(error => error ? fail(error) : done(address.port))
    })
  })
}

async function assertAvailable(url: string) {
  const location = new URL(url)
  const occupied = await new Promise<boolean>(done => {
    const socket = connect({ host: location.hostname, port: portOf(url) })
    let finished = false
    const finish = (value: boolean) => {
      if (finished) return
      finished = true
      socket.destroy()
      done(value)
    }
    socket.setTimeout(500)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("timeout", () => finish(false))
  })

  if (occupied) throw new Error(`Client development URL is already in use: ${url}`)
}

function portOf(url: string) {
  const location = new URL(url)
  return Number(location.port || (location.protocol === "https:" ? 443 : 80))
}

function commandEnvironment(directory: string, additions: Readonly<Record<string, string>>) {
  const key = Object.keys(process.env).find(name => name.toLowerCase() === "path") ?? "PATH"
  const inherited = process.env[key]
  return { ...process.env, ...additions, [key]: [join(directory, "node_modules", ".bin"), inherited].filter(Boolean).join(delimiter) }
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController) {
  if (!source) return () => undefined

  const abort = () => target.abort(source.reason)
  if (source.aborted) abort()
  else source.addEventListener("abort", abort, { once: true })

  return () => source.removeEventListener("abort", abort)
}

function commandFailure(exit: CommandExit) {
  if (exit.error) return new Error(`Client development command failed: ${exit.error.message}`)
  if (exit.signal) return new Error(`Client development command ended on ${exit.signal}`)
  return new Error(`Client development command exited with ${exit.code ?? 0}`)
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
  } catch {
    return child.exitCode === null && child.signalCode === null
  }
}

async function waitUntilStopped(child: ChildProcess, milliseconds: number) {
  const deadline = Date.now() + milliseconds
  while (running(child) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
}

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((done, fail) => {
    if (signal.aborted) {
      fail(signal.reason)
      return
    }

    const timeout = setTimeout(finish, milliseconds)
    const abort = () => finish(signal.reason)

    signal.addEventListener("abort", abort, { once: true })

    function finish(error?: unknown) {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      if (error !== undefined) fail(error)
      else done()
    }
  })
}

interface CommandExit {
  code: number | null
  signal: NodeJS.Signals | null
  error: Error | null
}
