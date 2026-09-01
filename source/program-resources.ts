import type { ProgramPermission, ProgramSql, ProgramStore } from "@phreshos/core"

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

/** Persistent Program permission decisions carried through the owner-local Gateway. */
export function programPermission(request: Request, handle: ProgramAddress): ProgramPermission {
  const operate = <Result>(permissionOperation: string, name?: string, value?: boolean) => request({
    capability: "program",
    operation: "permission",
    handle,
    permissionOperation,
    name,
    value
  }) as Promise<Result>

  return {
    get: name => operate<boolean | undefined>("get", name),
    getAll: () => operate("getAll"),
    set: (name, value) => operate<void>("set", name, value),
    delete: name => operate<void>("delete", name)
  }
}

function written(statement: string | TemplateStringsArray, rest: unknown[]): [string, unknown[]] {
  if (typeof statement === "string") return [statement, Array.isArray(rest[0]) ? rest[0] as unknown[] : []]
  return [statement.raw.join("?"), rest]
}
