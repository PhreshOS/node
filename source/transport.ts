import { connect, type Socket } from "node:net"

export interface TransportEvent {
  event?: string
  [key: string]: unknown
}

/** Open and retain one owner-local System connection. */
export function openConnection(path: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(path)
    const failed = () => reject(unavailable(path))

    socket.once("connect", () => {
      socket.off("error", failed)
      socket.on("error", () => undefined)
      resolve(socket)
    })
    socket.once("error", failed)
  })
}

/** Execute one short authoritative System-control request. */
export function request(path: string, target: "api" | "system", request: unknown, signal?: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(path)
    let buffer = ""
    let settled = false
    const finish = (work: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", cancel)
      socket.destroy()
      work()
    }
    const cancel = () => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("The request was cancelled")))

    signal?.addEventListener("abort", cancel, { once: true })
    socket.on("connect", () => socket.write(`${JSON.stringify({ target, request })}\n`))
    socket.on("data", chunk => {
      buffer += String(chunk)
      const boundary = buffer.indexOf("\n")
      if (boundary < 0) return

      let outcome: Outcome
      try { outcome = JSON.parse(buffer.slice(0, boundary)) as Outcome }
      catch { return finish(() => reject(new Error("The System returned an invalid response"))) }

      if (outcome.success) finish(() => resolve(outcome.result))
      else finish(() => reject(new Error(outcome.error)))
    })
    socket.on("error", () => finish(() => reject(unavailable(path))))
    socket.on("close", () => finish(() => reject(new Error("The System closed the request without an answer"))))

    if (signal?.aborted) cancel()
  })
}

/** Stream one Program lifecycle operation until the System completes it. */
export function streamProgram(path: string, request: unknown, signal?: AbortSignal) {
  const events: TransportEvent[] = []
  let wake: (() => void) | null = null
  let ended = false
  let failure: Error | null = null
  const socket = connect(path)
  const cancel = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : undefined)

  if (signal?.aborted) cancel()
  else signal?.addEventListener("abort", cancel, { once: true })

  let buffer = ""

  socket.on("connect", () => socket.write(`${JSON.stringify({ target: "program", request })}\n`))
  socket.on("data", chunk => {
    buffer += String(chunk)
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) if (line.trim()) {
      const event = JSON.parse(line) as TransportEvent
      if (event.event === "error") failure = new Error(String(event.message))
      else events.push(event)
    }
    wake?.()
    wake = null
  })
  socket.on("error", error => {
    failure = signal?.aborted
      ? signal.reason instanceof Error ? signal.reason : new Error("The operation was cancelled")
      : error
    wake?.()
    wake = null
  })
  socket.on("close", () => {
    ended = true
    signal?.removeEventListener("abort", cancel)
    wake?.()
    wake = null
  })

  return (async function* () {
    try {
      while (true) {
        if (events.length) {
          yield events.shift()!
          continue
        }
        if (failure) throw failure
        if (ended) return
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      signal?.removeEventListener("abort", cancel)
      socket.destroy()
    }
  })()
}

function unavailable(path: string) {
  return new Error(`No System is listening at ${path} — start PhreshOS first`)
}

type Outcome = Readonly<{ success: true, result: unknown }> | Readonly<{ success: false, error: string }>
