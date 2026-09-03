import {
  parsePermission,
  parsePermissionChange,
  parsePermissions,
  type PermissionInput,
  type PermissionName,
  type ProgramPermissions,
  type ProgramSql,
  type ProgramStore
} from "@phreshos/core"

type Call = <Result = unknown>(event: string, ...values: unknown[]) => Promise<Result>
type ProgramAddress = Readonly<{ identity: string, reference: string }>

/** Program-owned key-value storage carried through the owner-local Gateway. */
export function programStore(call: Call, handle: ProgramAddress): ProgramStore {
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
export function programSql(call: Call, handle: ProgramAddress, database: "database" | "logs"): ProgramSql {
  return {
    query<Row = Record<string, unknown>>(statement: string | TemplateStringsArray, ...rest: unknown[]) {
      const [text, values] = written(statement, rest)
      return call<Row[]>(`/program/${database}`, handle, text, values)
    }
  }
}

/** Program permission management carried through the owner-local Gateway. */
export function programPermissions(call: Call, handle: ProgramAddress): ProgramPermissions {
  const operate = <Name extends PermissionName>(permissionOperation: "all" | "get" | "set" | "delete", name?: Name, permission?: Exclude<PermissionInput<Name>, null>) => (
    call("/program/permissions", handle, permissionOperation, name, permission)
  )

  return {
    async get(name) { return parsePermission(name, await operate("get", name)) },
    async all() { return parsePermissions(await operate("all")) },
    async set(name, permission) { return parsePermissionChange(name, await operate("set", name, permission)) },
    async delete(name) { return parsePermissionChange(name, await operate("delete", name)) }
  }
}

function written(statement: string | TemplateStringsArray, rest: unknown[]): [string, unknown[]] {
  if (typeof statement === "string") return [statement, Array.isArray(rest[0]) ? rest[0] as unknown[] : []]
  return [statement.raw.join("?"), rest]
}
