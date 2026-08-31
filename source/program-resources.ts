import type { ProgramSql, ProgramStore } from "@phreshos/core"

type Request = (value: object) => Promise<unknown>

/** Program-owned key-value storage carried through the owner-local Gateway. */
export function programStore(request: Request, program: string): ProgramStore {
  const operate = <Result>(storeOperation: string, key?: string | string[], value?: unknown, ttl?: number) => request({
    capability: "program",
    operation: "store",
    program,
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
export function programSql(request: Request, program: string, database: "database" | "logs"): ProgramSql {
  return {
    query<Row = Record<string, unknown>>(statement: string | TemplateStringsArray, ...rest: unknown[]) {
      const [text, values] = written(statement, rest)
      return request({ capability: "program", operation: "query", program, database, statement: text, values }) as Promise<Row[]>
    }
  }
}

function written(statement: string | TemplateStringsArray, rest: unknown[]): [string, unknown[]] {
  if (typeof statement === "string") return [statement, Array.isArray(rest[0]) ? rest[0] as unknown[] : []]
  return [statement.raw.join("?"), rest]
}
