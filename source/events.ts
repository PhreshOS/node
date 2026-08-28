import type { Capture, Cleanup, EventOptions, Subscribable } from "@phreshos/core"

type Wait = (event: string | null, signal: AbortSignal, timeout?: number) => Promise<unknown>

/** Adapt authoritative one-event waits into the shared Subscribable contract. */
export default class Events<Definitions extends object, Fallback = never> {
  public constructor(private readonly names: readonly string[], private readonly wait: Wait) {}

  public readonly subscribe = ((event: string, subscriber: (message: unknown) => unknown): Cleanup => {
    const controller = new AbortController()

    void (async () => {
      while (!controller.signal.aborted) {
        try { subscriber(await this.wait(event, controller.signal, 86_400_000)) }
        catch (error) {
          if (!controller.signal.aborted && timeout(error)) continue
          if (!controller.signal.aborted) controller.abort()
        }
      }
    })()

    return () => controller.abort()
  }) as Subscribable<Definitions, Fallback>["subscribe"]

  public readonly waitFor = ((event: string, timeout?: number) => {
    return this.wait(event, new AbortController().signal, timeout)
  }) as Subscribable<Definitions, Fallback>["waitFor"]

  public readonly events = ((event: string, options: EventOptions = {}) => {
    const wait = this.wait
    return (async function* () {
      const controller = new AbortController()
      const abort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener("abort", abort, { once: true })

      try {
        while (!controller.signal.aborted) {
          try { yield await wait(event, controller.signal, 86_400_000) }
          catch (error) {
            if (!controller.signal.aborted && timeout(error)) continue
            throw error
          }
        }
      } finally {
        options.signal?.removeEventListener("abort", abort)
        controller.abort()
      }
    })()
  }) as Subscribable<Definitions, Fallback>["events"]

  public readonly observe = ((observer: (capture: Capture<string, unknown>) => unknown): Cleanup => {
    if (this.names.length) {
      const stops = this.names.map(event => this.subscribe(event as never, message => observer({ event, message })))
      return () => stops.forEach(stop => stop())
    }

    const controller = new AbortController()
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const capture = await this.wait(null, controller.signal, 86_400_000) as { event: string, payload: unknown }
          observer({ event: capture.event, message: capture.payload })
        } catch (error) {
          if (!controller.signal.aborted && timeout(error)) continue
          if (!controller.signal.aborted) controller.abort()
        }
      }
    })()
    return () => controller.abort()
  }) as Subscribable<Definitions, Fallback>["observe"]
}

function timeout(error: unknown) {
  return error instanceof Error && /timeout|timed out/i.test(error.message)
}
