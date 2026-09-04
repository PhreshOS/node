import type {
  ClientEndpoint as CoreClientEndpoint,
  Endpoint as CoreEndpoint,
  Program as CoreProgram,
  ServerEndpoint as CoreServerEndpoint,
  System as CoreSystem,
  Service,
  ServiceKey
} from "@phreshos/core"
import type { ClientEndpoint, Endpoint, Program, ServerEndpoint, System } from "../source/main.js"

declare const connected: System
declare const canonical: CoreSystem
declare const program: Program
declare const canonicalProgram: CoreProgram
declare const endpoint: Endpoint<{ change: number }, string>
declare const server: ServerEndpoint<{ change: number }, string>
declare const client: ClientEndpoint<{ change: number }, string>
declare const serviceEndpoint: ServiceKey["endpoint"]

const shared: CoreSystem = connected
const sameProgram: CoreProgram = program
const nodeProgram: Program = canonicalProgram
const sameEndpoint: CoreEndpoint<{ change: number }, string> = endpoint
const sameServer: CoreServerEndpoint<{ change: number }, string> = server
const sameClient: CoreClientEndpoint<{ change: number }, string> = client
const service: Service = connected.service({ program: "example", process: "main", endpoint: serviceEndpoint })
const connectionCapability: Exclude<keyof System, keyof CoreSystem> = "disconnect"
const onlyConnectionCapability: "disconnect" = null as never as Exclude<keyof System, keyof CoreSystem>

program.permissions.get("all")
program.permissions.all()
program.permissions.allows("network", ["https://api.example.com"])
program.permissions.set("all", true)
program.permissions.delete("all")

declare const process: import("../source/main.js").Process

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
