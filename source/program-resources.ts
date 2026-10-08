import {
  parsePermission,
  parsePermissions,
  type PermissionName,
  type PermissionRequestInput,
  type ProgramPermissions,
  type ProgramPermissionsEvents,
  type ProgramSql,
  type ProgramStore,
  type Subscribable
} from "@phreshos/core"

type Call = <Result = unknown>(event: string, ...values: unknown[]) => Promise<Result>
type HandleAddress = Readonly<{ identity: string, reference: string }>

/** Program-owned key-value storage carried through the owner-local Gateway. */
export function programStore(call: Call, handle: HandleAddress, onChange: (subscriber: (key: string, snapshot: StoreSnapshot) => void) => () => void): ProgramStore {
  const snapshots = new Map<string, StoreSnapshot>()
  const local = new Set<(key: string, snapshot: StoreSnapshot) => void>()
  const notify = (key: string, snapshot: StoreSnapshot) => { for (const listener of local) listener(key, snapshot) }
  const operate = <Result>(storeOperation: string, key?: string | string[], value?: unknown, ttl?: unknown) => (
    call<Result>("/program/store", handle, storeOperation, key, value, ttl)
  )

  return {
    get: <Value>(key: string) => operate<Value | undefined>("get", key),
    async set<Value>(key: string, value: Value, ttl?: number) {
      const result = await operate<boolean>("set", key, value, ttl)
      snapshots.delete(key)
      return result
    },
    async getOrSet<Value>(key: string, initial: Value) {
      const snapshot = await operate<StoreSnapshot>("getOrSet", key, initial)
      notify(key, snapshot)
      return snapshot.value as Value
    },
    async update<Value>(key: string, updater: (current: Value | undefined) => Value) {
      let snapshot = snapshots.get(key) ?? await operate<StoreSnapshot>("snapshot", key)
      for (;;) {
        const next = updater(snapshot.value as Value | undefined)
        const result = await operate<StoreComparison>("compareAndSet", key, next, snapshot)
        snapshots.set(key, result.snapshot)
        notify(key, result.snapshot)
        if (result.changed) return result.snapshot.value as Value
        snapshot = result.snapshot
      }
    },
    async delete(key: string | string[]) {
      const result = await operate<boolean>("delete", key)
      for (const name of Array.isArray(key) ? key : [key]) snapshots.delete(name)
      return result
    },
    has: (key: string) => operate<boolean>("has", key),
    async clear() { await operate<void>("clear"); snapshots.clear() },
    subscribe<Value>(key: string, subscriber: (value: Value | undefined) => unknown) {
      let active = true
      let latest: StoreSnapshot | undefined
      const deliver = (snapshot: StoreSnapshot) => {
        if (!active || (latest?.run === snapshot.run && latest.revision >= snapshot.revision)) return
        latest = snapshot
        snapshots.set(key, snapshot)
        subscriber(snapshot.value as Value | undefined)
      }
      const stop = onChange((changedKey, snapshot) => { if (changedKey === key) deliver(snapshot) })
      const localListener = (changedKey: string, snapshot: StoreSnapshot) => { if (changedKey === key) deliver(snapshot) }
      local.add(localListener)
      void operate<StoreSnapshot>("snapshot", key).then(deliver).catch(() => undefined)
      return () => { active = false; local.delete(localListener); stop() }
    }
  }
}

type StoreSnapshot = { run: string, revision: number, value: unknown }
type StoreComparison = { changed: boolean, snapshot: StoreSnapshot }

/** Program-owned SQL capability carried through the owner-local Gateway. */
export function programSql(call: Call, handle: HandleAddress, database: "database" | "logs"): ProgramSql {
  return {
    query<Row = Record<string, unknown>>(statement: string | TemplateStringsArray, ...rest: unknown[]) {
      const [text, values] = written(statement, rest)
      return call<Row[]>(`/program/${database}`, handle, text, values)
    }
  }
}

/** Program permission management carried through the owner-local Gateway. */
export function programPermissions(call: Call, handle: HandleAddress, changes: Subscribable<ProgramPermissionsEvents, never>): ProgramPermissions {
  const operate = <Name extends PermissionName>(permissionOperation: "all" | "get" | "allows" | "allow" | "deny", name?: Name, permission?: PermissionRequestInput<Name>) => (
    call("/program/permissions", handle, permissionOperation, name, permission)
  )

  return {
    subscribe: changes.subscribe,
    wait: changes.wait,
    events: changes.events,
    async get(name) { return parsePermission(name, await operate("get", name)) },
    async all() { return parsePermissions(await operate("all")) },
    async allows(name, permission = true) { return await operate("allows", name, permission) === true },
    async allow(name, permission = true) { await operate("allow", name, permission) },
    async deny(name) { await operate("deny", name) }
  }
}

function written(statement: string | TemplateStringsArray, rest: unknown[]): [string, unknown[]] {
  if (typeof statement === "string") return [statement, Array.isArray(rest[0]) ? rest[0] as unknown[] : []]
  return [statement.raw.join("?"), rest]
}
