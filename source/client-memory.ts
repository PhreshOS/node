import type { ClientMemory, JsonValue } from "@phreshos/core"
import SystemRepresentation from "./representation.js"

type Snapshot = { run: string, revision: number, value: JsonValue | undefined }
type CompareResult = { changed: boolean, snapshot: Snapshot }

/** One Process Client's memory; the gateway only transports System operations. */
export default function clientMemory(representation: SystemRepresentation, process: string): ClientMemory {
  const snapshots = new Map<string, Snapshot>()
  const ask = (operation: string, key?: string, value?: unknown, expected?: Snapshot) =>
    representation.call<unknown>("/process/client-memory", process, operation, key, value, expected)
  return {
    async get<Value extends JsonValue = JsonValue>(key: string) { const snapshot = await ask("snapshot", key) as Snapshot; snapshots.set(key, snapshot); return snapshot.value as Value | undefined },
    async set(key, value) { snapshots.set(key, await ask("set", key, value) as Snapshot) },
    async update<Value extends JsonValue>(key: string, updater: (current: Value | undefined) => Value) {
      let snapshot = snapshots.get(key) ?? await ask("snapshot", key) as Snapshot
      for (;;) {
        const next = updater(snapshot.value as Value | undefined)
        const result = await ask("compareAndSet", key, next, snapshot) as CompareResult
        snapshots.set(key, result.snapshot)
        if (result.changed) return result.snapshot.value as Value
        if (result.snapshot.run !== snapshot.run) throw new Error("The Client run changed during the update")
        snapshot = result.snapshot
      }
    },
    async delete(key) { const deleted = await ask("delete", key) as boolean; snapshots.delete(key); return deleted },
    async entries() { return await ask("entries") as readonly (readonly [string, JsonValue])[] },
    subscribe<Value extends JsonValue = JsonValue>(key: string, subscriber: (value: Value | undefined) => unknown) {
      let latest: Snapshot | undefined
      return representation.follow({ scope: "clientMemory", process, key, event: null }, (_event, value) => {
        const snapshot = value as Snapshot
        if (latest && latest.run === snapshot.run && latest.revision > snapshot.revision) return
        latest = snapshot
        snapshots.set(key, snapshot)
        subscriber(snapshot.value as Value | undefined)
      })
    }
  }
}
