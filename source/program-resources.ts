import { parsePermission, parsePermissionChange, parsePermissions, type PermissionInput, type ProgramPermissions, type ProgramSql, type ProgramStore } from "@phreshos/core"

type Request = (value: object) => Promise<unknown>
type ProgramAddress = Readonly<{ identity: string, reference: string }>

/** Program-owned key-value storage carried through the owner-local Gateway. */
export function programStore(request: Request, handle: ProgramAddress): ProgramStore {
  const operate = <Result>(storeOperation: string, key?: string | string[], value?: unknown, ttl?: number) => request({
    capability: "program",
    operation: "store",
    handle,
    storeOperation,
    key,
    value,
    ttl
  }) as Promise<Result>

  return {
    get: <Value>(key: string) => operate<Value | undefined>("get", key),
    set: <Value>(key: string, value: Value, ttl?: number) => operate<boolean>("set", key, value, ttl),
    delete: (key: string | string[]) => operate<boolean>("delete", key),
    has: (key: string) => operate<boolean>("has", key),
    clear: () => operate<void>("clear")
  }
}

/** Program-owned SQL capability carried through the owner-local Gateway. */
export function programSql(request: Request, handle: ProgramAddress, database: "database" | "logs"): ProgramSql {
  return {
    query<Row = Record<string, unknown>>(statement: string | TemplateStringsArray, ...rest: unknown[]) {
      const [text, values] = written(statement, rest)
      return request({ capability: "program", operation: "query", handle, database, statement: text, values }) as Promise<Row[]>
    }
  }
}

/** Program permission management carried through the owner-local Gateway. */
export function programPermissions(request: Request, handle: ProgramAddress): ProgramPermissions {
  const operate = (permissionOperation: "all" | "get" | "set" | "delete", name?: string, permission?: Exclude<PermissionInput, null>) => request({
    capability: "program",
    operation: "permissions",
    handle,
    permissionOperation,
    name,
    permission
  })

  return {
    async get(name) { return parsePermission(await operate("get", name)) },
    async all() { return parsePermissions(await operate("all")) },
    async set(name, permission) { return parsePermissionChange(await operate("set", name, permission)) },
    async delete(name) { return parsePermissionChange(await operate("delete", name)) }
  }
}

function written(statement: string | TemplateStringsArray, rest: unknown[]): [string, unknown[]] {
  if (typeof statement === "string") return [statement, Array.isArray(rest[0]) ? rest[0] as unknown[] : []]
  return [statement.raw.join("?"), rest]
}
