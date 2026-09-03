import { SocketClient } from "@the-link/ipc/socket-client"
import messagepack from "@the-link/messagepack"

const events = {
  ready: "/gateway/ready"
} as const

/** One persistent owner-local IPC connection to the System Link Manager. */
export class GatewayConnection {
  public session: unknown = null

  private active = false
  private readonly queued: { event: string, values: unknown[] }[] = []
  private readonly subscribers = new Map<string, Set<(...values: unknown[]) => unknown>>()

  private constructor(private readonly link: SocketClient) {
    link.$inbound.forwardTo((event, ...values) => {
      if (event === events.ready) return
      if (!this.active) this.queued.push({ event, values })
      else this.deliver(event, values)
    })
  }

  public static async open(path: string) {
    const link = new SocketClient(path)
    const connection = new GatewayConnection(link)

    link.setSerialize(messagepack.serialize)
    link.setDeserialize(messagepack.deserialize)

    const readiness = ready(link)

    try {
      await link.connect()
    } catch (error) {
      readiness.cancel()
      await link.disconnect()
      throw unavailable(path, error)
    }

    try {
      connection.session = await readiness.promise
      return connection
    } catch (error) {
      await link.disconnect()
      throw new Error("The System Gateway did not establish an owner session", { cause: error })
    }
  }

  public onDisconnect(subscriber: (error: Error) => void) {
    return this.link.$internal.subscribe("disconnect", subscriber)
  }

  public disconnect() {
    return this.link.disconnect()
  }

  /** Invoke one operation exposed by the connected System Link Manager. */
  public call<Result = unknown>(event: string, ...values: unknown[]) {
    return this.link.$outbound.publishFirst<Result>(event, ...values)
  }

  /** Observe one live event emitted by the connected System Link Manager. */
  public subscribe(event: string, subscriber: (...values: unknown[]) => unknown) {
    const subscribers = this.subscribers.get(event) ?? new Set()

    subscribers.add(subscriber)
    this.subscribers.set(event, subscribers)

    return () => {
      subscribers.delete(subscriber)
      if (!subscribers.size) this.subscribers.delete(event)
    }
  }

  /** Begin delivery after the connected representation has installed its listeners. */
  public activate() {
    if (this.active) return
    this.active = true

    for (const { event, values } of this.queued.splice(0)) this.deliver(event, values)
  }

  private deliver(event: string, values: unknown[]) {
    for (const subscriber of this.subscribers.get(event) ?? []) {
      try { subscriber(...values) }
      catch { /* One local observer cannot break boundary delivery. */ }
    }
  }
}

function ready(link: SocketClient) {
  let received: () => void = () => undefined
  let disconnected: () => void = () => undefined
  const promise = new Promise<unknown>((resolve, reject) => {
    received = link.$inbound.subscribeOnce(events.ready, value => {
      disconnected()
      resolve(value)
    })
    disconnected = link.$internal.subscribeOnce("disconnect", error => {
      received()
      reject(exception(error))
    })
  })

  return {
    promise,
    cancel() {
      received()
      disconnected()
    }
  }
}

function exception(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function unavailable(path: string, cause: unknown) {
  return new Error(`No System is listening at ${path} — start PhreshOS first`, { cause })
}

/** Open and authenticate one owner-local System connection. */
export function openConnection(path: string) {
  return GatewayConnection.open(path)
}
