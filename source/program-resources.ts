import {
  parsePermission,
  parsePermissions,
  type PermissionName,
  type PermissionRequest,
  type ProgramPermissions,
  type ProgramSql,
  type ProgramStore,
  type TimedProgramPermissions
} from "@phreshos/core"
import { randomUUID } from "node:crypto"

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
  const operate = <Name extends PermissionName>(permissionOperation: "all" | "get" | "allows" | "allow" | "deny", name?: Name, permission?: PermissionRequest<Name>) => (
    call("/program/permissions", handle, permissionOperation, name, permission)
  )
  const timed = (timeout: number): TimedProgramPermissions => ({
    async request<Name extends PermissionName>(name: Name, permission: PermissionRequest<Name> = true) {
      const identity = randomUUID()
      let timer: ReturnType<typeof setTimeout> | undefined
      // Node has no Endpoint boundary to forget a timed-out request, so its
      // authenticated connection must cancel the matching System dialog.
      const expired = new Promise<null>(resolve => {
        timer = setTimeout(() => {
          void call("/program/permissions", handle, "cancel-request", identity).catch(() => undefined)
          resolve(null)
        }, timeout)
      })

      try {
        const result = await Promise.race([
          call<unknown>("/program/permissions", handle, "request", identity, name, permission),
          expired
        ])
        return parsePermission(name, result)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  })

  return {
    async get(name) { return parsePermission(name, await operate("get", name)) },
    async all() { return parsePermissions(await operate("all")) },
    async allows(name, permission = true) { return await operate("allows", name, permission) === true },
    async allow(name, permission = true) { await operate("allow", name, permission) },
    async deny(name) { await operate("deny", name) },
    request: timed(defaultPermissionTimeout).request,
    timeout(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("A permission timeout must be a non-negative finite number")
      return timed(milliseconds)
    }
  }
}

const defaultPermissionTimeout = 120_000

function written(statement: string | TemplateStringsArray, rest: unknown[]): [string, unknown[]] {
  if (typeof statement === "string") return [statement, Array.isArray(rest[0]) ? rest[0] as unknown[] : []]
  return [statement.raw.join("?"), rest]
}
