import type {
  ClientEndpoint,
  Connection,
  Endpoint,
  ExecuteOperationSummary,
  Process,
  Program,
  ServerEndpoint,
  Session,
  System as CoreSystem,
  Service,
  ServiceAddress
} from "@phreshos/core"
import type { System } from "../source/main.js"

declare const connected: System
declare const canonical: CoreSystem
declare const program: Program
declare const canonicalProgram: Program
declare const endpoint: Endpoint<{ change: number }, string>
declare const server: ServerEndpoint<{ change: number }, string>
declare const client: ClientEndpoint<{ change: number }, string>
declare const serviceEndpoint: ServiceAddress["endpoint"]

const shared: CoreSystem = connected
const sameProgram: Program = program
const nodeProgram: Program = canonicalProgram
const sameEndpoint: Endpoint<{ change: number }, string> = endpoint
const sameServer: ServerEndpoint<{ change: number }, string> = server
const sameClient: ClientEndpoint<{ change: number }, string> = client
const service: Service = connected.service.prepare({ program: "example", process: "main", endpoint: serviceEndpoint })
const connectionCapability: Exclude<keyof System, keyof CoreSystem> = "disconnect"
const onlyConnectionCapability: "disconnect" = null as never as Exclude<keyof System, keyof CoreSystem>
const connections: Promise<Connection[]> = connected.connection.list()
const sessions: Promise<Session[]> = connected.session.list()
const execution: Promise<ExecuteOperationSummary[]> = connected.execute({ $domain: "operation", $operation: "list" })

async function authenticationDomains() {
  const connection = (await connections)[0]
  if (!connection) return
  const session = await connection.signIn()
  const sameSession: Session | null = await connection.session()
  const attached: Connection[] = await session.connections()
  await session.signOut()
  void [sameSession, attached]
}

void authenticationDomains
void sessions
void execution

program.permissions.get("all")
program.permissions.all()
program.permissions.allows("network", ["https://api.example.com"])
program.permissions.set("all", true)
program.permissions.delete("all")

declare const process: Process

// @ts-expect-error Permissions belong to the Program, never one Process.
process.permissions

// @ts-expect-error Permission names are closed by the Core catalog.
program.permissions.get("files")

void canonical
void shared
void sameProgram
void nodeProgram
void sameEndpoint
void sameServer
void sameClient
void service
void connectionCapability
void onlyConnectionCapability
