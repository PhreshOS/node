import type {
  ClientEndpoint,
  Connection,
  AuthenticationState,
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
const authenticationState: Promise<AuthenticationState> = connected.authentication.state()
const connections: Promise<Connection[]> = connected.authentication.connections()
const sessions: Promise<Session[]> = connected.authentication.sessions()
const execution: Promise<ExecuteOperationSummary[]> = connected.execute({ $domain: "operation", $operation: "list" })
const appearanceUpdate: Promise<void> = connected.appearance.update({ colors: { dark: { danger: "#ff0000" } } })
const programDefinition = program.definition()
const serviceIcon = service.programIcon("small")
const systemLogs = connected.logs.query("select * from logs where level = ?", ["error"])
const systemLogStop = connected.logs.subscribe("log", record => void record.level)
const programLogs = program.logs.query("select * from logs where process = ?", ["main"])
const programLogStop = program.logs.subscribe("log", record => void record.source)

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
void authenticationState
void sessions
void execution
void appearanceUpdate
void programDefinition
void serviceIcon
void systemLogs
void systemLogStop
void programLogs
void programLogStop

program.permissions.get("all")
program.permissions.all()
program.permissions.allows("network", ["https://api.example.com"])
program.permissions.allow("all")
program.permissions.deny("network")
connected.permissions.requests()
// @ts-expect-error owner decisions and Endpoint requests are separate contracts.
program.permissions.request("all")
// @ts-expect-error Permission assignments are replaced or denied; they are never deleted.
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
