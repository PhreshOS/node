import type {
  AnswerCapture,
  AnswerSubscriber,
  AskCapture,
  AskSubscriber,
  Cleanup,
  Endpoint,
  EventOptions,
  ServerTraffic,
  TrafficEvents
} from "@phreshos/core"
import Events, { stream } from "./events.js"

type Kind = "publish" | "ask" | "answer"
type Request = (value: object, signal?: AbortSignal) => Promise<unknown>
type ResolveEndpoint = (value: unknown) => Endpoint

/** Directed traffic originating from one canonical Endpoint. */
export class EndpointTrafficHandle<Definitions extends object = {}> extends Events<
  TrafficEvents<Definitions>,
  never
> {
  public constructor(
    private readonly request: Request,
    private readonly process: string,
    private readonly endpoint: "server" | "client",
    protected readonly resolveEndpoint: ResolveEndpoint
  ) {
    super([], (event, signal, timeout) => request({
      capability: "traffic",
      operation: "wait",
      process,
      endpoint,
      kind: "publish",
      event,
      timeout
    }, signal).then(value => publication(value, resolveEndpoint, event === null)))
  }

  public subscribeAsks<Payload = unknown>(subscriber: AskSubscriber<Payload>): Cleanup {
    return this.follow<AskCapture<Payload>>("ask", value => question(value, this.resolveEndpoint), subscriber)
  }

  public asks<Payload = unknown>(options?: EventOptions) {
    return stream<AskCapture<Payload>>(
      (subscriber, impossible) => this.follow("ask", value => question(value, this.resolveEndpoint), subscriber, impossible),
      options
    )
  }

  protected follow<Capture>(
    kind: Kind,
    convert: (value: unknown) => Capture,
    subscriber: (capture: Capture) => unknown,
    impossible?: (error: Error) => void
  ): Cleanup {
    const controller = new AbortController()

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const value = await this.request({
            capability: "traffic",
            operation: "wait",
            process: this.process,
            endpoint: this.endpoint,
            kind,
            event: null,
            timeout: 86_400_000
          }, controller.signal)
          subscriber(convert(value))
        } catch (error) {
          if (!controller.signal.aborted) impossible?.(error instanceof Error ? error : new Error(String(error)))
          controller.abort()
        }
      }
    })()

    return () => controller.abort()
  }
}

/** Directed traffic originating from one canonical Server. */
export class ServerTrafficHandle<Definitions extends object = {}>
  extends EndpointTrafficHandle<Definitions>
  implements ServerTraffic<Definitions> {
  public subscribeAnswers<Result = unknown>(subscriber: AnswerSubscriber<Result>): Cleanup {
    return this.follow<AnswerCapture<Result>>("answer", value => answer(value, this.resolveEndpoint), subscriber)
  }

  public answers<Result = unknown>(options?: EventOptions) {
    return stream<AnswerCapture<Result>>(
      (subscriber, impossible) => this.follow("answer", value => answer(value, this.resolveEndpoint), subscriber, impossible),
      options
    )
  }
}

function publication(value: unknown, resolve: ResolveEndpoint, captured: boolean) {
  const received = traffic(value)
  const message = directed(received.values[0], resolve)
  return captured ? { event: received.event, payload: message } : message
}

function question<Payload>(value: unknown, resolve: ResolveEndpoint): AskCapture<Payload> {
  const received = traffic(value)
  if (typeof received.values[0] !== "string") throw new Error("The System returned invalid question traffic")
  return {
    event: received.event,
    questionId: received.values[0],
    message: directed(received.values[1], resolve) as AskCapture<Payload>["message"]
  }
}

function answer<Result>(value: unknown, resolve: ResolveEndpoint): AnswerCapture<Result> {
  const received = traffic(value)
  const raw = received.values[1] as { to?: unknown, outcome?: unknown } | null
  if (typeof received.values[0] !== "string" || !raw || typeof raw !== "object") throw new Error("The System returned invalid answer traffic")
  return {
    event: received.event,
    questionId: received.values[0],
    message: { to: resolve(raw.to), outcome: raw.outcome as AnswerCapture<Result>["message"]["outcome"] }
  }
}

function directed(value: unknown, resolve: ResolveEndpoint) {
  const raw = value as { to?: unknown, payload?: unknown } | null
  if (!raw || typeof raw !== "object") throw new Error("The System returned invalid Endpoint traffic")
  return { to: resolve(raw.to), payload: raw.payload }
}

function traffic(value: unknown) {
  const received = value as { event?: unknown, values?: unknown } | null
  if (!received || typeof received.event !== "string" || !Array.isArray(received.values)) throw new Error("The System returned invalid traffic")
  return { event: received.event, values: received.values }
}
