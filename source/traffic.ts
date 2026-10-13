import {
  parseEndpointMetadata,
  type AnswerCapture,
  type AnswerSubscriber,
  type AskCapture,
  type AskSubscriber,
  type Cleanup,
  type EventOptions,
  type ServerTraffic,
  type TrafficEvents
} from "@phreshos/core"
import Events, { stream } from "./events.js"
import type SystemRepresentation from "./representation.js"

type Kind = "publish" | "ask" | "answer"

/** Directed traffic originating from one canonical Endpoint. */
export class EndpointTrafficHandle<Definitions extends object = {}> extends Events<
  TrafficEvents<Definitions>,
  never
> {
  public constructor(
    private readonly representation: SystemRepresentation,
    private readonly process: string,
    private readonly endpoint: "server" | "client"
  ) {
    super([], (event, subscriber, impossible) => representation.follow({
      scope: "traffic",
      process,
      endpoint,
      kind: "publish",
      event
    }, (received, values) => subscriber(publication({ event: received, values }, event === null)), impossible))
  }

  public subscribeAsks<Payload = unknown>(subscriber: AskSubscriber<Payload>): Cleanup {
    return this.follow<AskCapture<Payload>>("ask", value => question(value), subscriber)
  }

  public asks<Payload = unknown>(options?: EventOptions) {
    return stream<AskCapture<Payload>>(
      (subscriber, impossible) => this.follow("ask", value => question(value), subscriber, impossible),
      options
    )
  }

  protected follow<Capture>(
    kind: Kind,
    convert: (value: unknown) => Capture,
    subscriber: (capture: Capture) => unknown,
    impossible?: (error: Error) => void
  ): Cleanup {
    return this.representation.follow({
      scope: "traffic",
      process: this.process,
      endpoint: this.endpoint,
      kind,
      event: null
    }, (event, values) => subscriber(convert({ event, values })), impossible)
  }
}

/** Directed traffic originating from one canonical Server Endpoint. */
export class ServerTrafficHandle<Definitions extends object = {}>
  extends EndpointTrafficHandle<Definitions>
  implements ServerTraffic<Definitions> {
  public subscribeAnswers<Result = unknown>(subscriber: AnswerSubscriber<Result>): Cleanup {
    return this.follow<AnswerCapture<Result>>("answer", value => answer(value), subscriber)
  }

  public answers<Result = unknown>(options?: EventOptions) {
    return stream<AnswerCapture<Result>>(
      (subscriber, impossible) => this.follow("answer", value => answer(value), subscriber, impossible),
      options
    )
  }
}

function publication(value: unknown, captured: boolean) {
  const received = traffic(value)
  const message = directed(received.values[0])
  return captured ? { event: received.event, payload: message } : message
}

function question<Payload>(value: unknown): AskCapture<Payload> {
  const received = traffic(value)
  if (typeof received.values[0] !== "string") throw new Error("The System returned invalid question traffic")
  return {
    event: received.event,
    questionId: received.values[0],
    message: directed(received.values[1]) as AskCapture<Payload>["message"]
  }
}

function answer<Result>(value: unknown): AnswerCapture<Result> {
  const received = traffic(value)
  const raw = received.values[1] as { to?: unknown, outcome?: unknown } | null
  if (typeof received.values[0] !== "string" || !raw || typeof raw !== "object") throw new Error("The System returned invalid answer traffic")
  return {
    event: received.event,
    questionId: received.values[0],
    message: { to: parseEndpointMetadata(raw.to ?? null), outcome: raw.outcome as AnswerCapture<Result>["message"]["outcome"] }
  }
}

function directed(value: unknown) {
  const raw = value as { to?: unknown, payload?: unknown } | null
  if (!raw || typeof raw !== "object") throw new Error("The System returned invalid Endpoint traffic")
  return { to: parseEndpointMetadata(raw.to ?? null), payload: raw.payload }
}

function traffic(value: unknown) {
  const received = value as { event?: unknown, values?: unknown } | null
  if (!received || typeof received.event !== "string" || !Array.isArray(received.values)) throw new Error("The System returned invalid traffic")
  return { event: received.event, values: received.values }
}
