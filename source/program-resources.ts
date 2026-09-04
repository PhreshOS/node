import {
  parsePermission,
  parsePermissions,
  type PermissionAssignments,
  type PermissionInput,
  type PermissionName,
  type ProcessPermissions,
  type ProgramPermissions,
  type ProgramSql,
  type ProgramStore
} from "@phreshos/core"

type Call = <Result = unknown>(event: string, ...values: unknown[]) => Promise<Result>
type HandleAddress = Readonly<{ identity: string, reference: string }>

/** Program-owned key-value storage carried through the owner-local Gateway. */
export function programStore(call: Call, handle: HandleAddress): ProgramStore {
  const operate = <Result>(storeOperation: string, key?: string | string[], value?: unknown, ttl?: number) => (
    call<Result>("/program/store", handle, storeOperation, key, value, ttl)
  )

  return {
    get: <Value>(key: string) => operate<Value | undefined>("get", key),
    set: <Value>(key: string, value: Value, ttl?: number) => operate<boolean>("set", key, value, ttl),
    delete: (key: string | string[]) => operate<boolean>("delete", key),
    has: (key: string) => operate<boolean>("has", key),
    clear: () => operate<void>("clear")
  }
}

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
export function programPermissions(call: Call, handle: HandleAddress): ProgramPermissions {
  return assignedPermissions(call, "/program/permissions", handle)
}

/** Process permission management carried through the owner-local Gateway. */
export function processPermissions(call: Call, handle: HandleAddress): ProcessPermissions {
  return assignedPermissions(call, "/process/permissions", handle)
}

function assignedPermissions(call: Call, event: "/program/permissions" | "/process/permissions", handle: HandleAddress): PermissionAssignments {
  const operate = <Name extends PermissionName>(permissionOperation: "all" | "get" | "allows" | "set" | "delete", name?: Name, permission?: PermissionInput<Name>) => (
    call(event, handle, permissionOperation, name, permission)
  )

  return {
    async get(name) { return parsePermission(name, await operate("get", name)) },
    async all() { return parsePermissions(await operate("all")) },
    async allows(name, permission = true) { return await operate("allows", name, permission) === true },
    async set(name, permission) { await operate("set", name, permission) },
    async delete(name) { await operate("delete", name) }
  }
}

function written(statement: string | TemplateStringsArray, rest: unknown[]): [string, unknown[]] {
  if (typeof statement === "string") return [statement, Array.isArray(rest[0]) ? rest[0] as unknown[] : []]
  return [statement.raw.join("?"), rest]
}
