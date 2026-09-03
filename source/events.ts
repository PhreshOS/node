import type { Capture, Cleanup, EventOptions, Subscribable } from "@phreshos/core"

type Failure = (error: Error) => void
type Register<Message> = (subscriber: (message: Message) => unknown, impossible?: Failure) => Cleanup
type Subscribe = (event: string | null, subscriber: (message: unknown) => unknown, impossible?: Failure) => Cleanup

/** Adapts one live representation source into the shared Subscribable contract. */
export default class Events<Definitions extends object, Fallback = never> {
  public constructor(private readonly names: readonly string[], private readonly register: Subscribe) {}

  public readonly subscribe = ((
    eventOrSubscriber: string | ((capture: Capture<string, unknown>) => unknown),
    subscriber?: (message: unknown) => unknown
  ): Cleanup => {
    if (typeof eventOrSubscriber === "string") return this.listen(eventOrSubscriber, subscriber as (message: unknown) => unknown)

    if (this.names.length) {
      const stops = this.names.map(event => this.listen(event, message => eventOrSubscriber({ event, message })))
      return () => stops.forEach(stop => stop())
    }

    return this.listen(null, value => {
      const capture = value as { event?: unknown, payload?: unknown }
      if (typeof capture.event === "string") eventOrSubscriber({ event: capture.event, message: capture.payload })
    })
  }) as Subscribable<Definitions, Fallback>["subscribe"]

  public readonly waitFor = ((event: string, timeout = 10_000) => new Promise((resolve, reject) => {
    let stop: Cleanup = () => undefined
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`The "${event}" event did not occur before the timeout`))
    }, timeout)
    const finish = (work: () => void) => {
      clearTimeout(timer)
      stop()
      work()
    }
    stop = this.listen(event, message => finish(() => resolve(message)), error => finish(() => reject(error)))
  })) as Subscribable<Definitions, Fallback>["waitFor"]

  public readonly events = ((eventOrOptions: string | EventOptions = {}, namedOptions: EventOptions = {}) => {
    if (typeof eventOrOptions === "string") {
      return stream((subscriber, impossible) => this.listen(eventOrOptions, subscriber, impossible), namedOptions)
    }

    return stream<Capture<string, unknown>>((subscriber, impossible) => {
      if (this.names.length) {
        const stops = this.names.map(event => this.listen(event, message => subscriber({ event, message }), impossible))
        return () => stops.forEach(stop => stop())
      }

      return this.listen(null, value => {
        const capture = value as { event?: unknown, payload?: unknown }
        if (typeof capture.event === "string") subscriber({ event: capture.event, message: capture.payload })
      }, impossible)
    }, eventOrOptions)
  }) as Subscribable<Definitions, Fallback>["events"]

  private listen(event: string | null, subscriber: (message: unknown) => unknown, impossible?: Failure): Cleanup {
    return this.register(event, subscriber, impossible)
  }
}

export function stream<Message>(register: Register<Message>, options: EventOptions = {}): AsyncIterableIterator<Message> {
  const capacity = options.capacity ?? 64
  if (capacity !== Infinity && (!Number.isInteger(capacity) || capacity < 0)) {
    throw new Error("An event queue capacity must be a non-negative integer or Infinity")
  }

  return (async function* () {
    const queue: Message[] = []
    let ended = false
    let failure: Error | null = null
    let wake: (() => void) | null = null

    const stop = register(
      message => {
        if (ended || failure) return
        if (queue.length >= capacity) failure = new Error(`Event queue exceeded its capacity of ${capacity}`)
        else queue.push(message)
        wake?.()
        wake = null
      },
      error => {
        if (ended || failure) return
        failure = error
        wake?.()
        wake = null
      }
    )

    const abort = () => {
      ended = true
      wake?.()
      wake = null
    }

    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()

    try {
      while (!ended) {
        if (queue.length) {
          yield queue.shift() as Message
          continue
        }
        if (failure) throw failure
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      ended = true
      stop()
      options.signal?.removeEventListener("abort", abort)
    }
  })()
}
