import type {
  System as CoreSystem,
  SystemClientEntity,
  SystemEndpointEntity,
  SystemProgramEntity,
  SystemServerEntity,
  Service,
  ServiceKey
} from "@phreshos/core"
import type { Client, Endpoint, Program, Server, System } from "../source/main.js"

declare const connected: System
declare const canonical: CoreSystem
declare const program: Program
declare const canonicalProgram: SystemProgramEntity
declare const endpoint: Endpoint<{ change: number }, string>
declare const server: Server<{ change: number }, string>
declare const client: Client<{ change: number }, string>
declare const serviceEndpoint: ServiceKey["endpoint"]

const shared: CoreSystem = connected
const sameProgram: SystemProgramEntity = program
const nodeProgram: Program = canonicalProgram
const sameEndpoint: SystemEndpointEntity<{ change: number }, string> = endpoint
const sameServer: SystemServerEntity<{ change: number }, string> = server
const sameClient: SystemClientEntity<{ change: number }, string> = client
const service: Service = connected.service({ program: "example", process: "main", endpoint: serviceEndpoint })
const connectionCapability: Exclude<keyof System, keyof CoreSystem> = "disconnect"
const onlyConnectionCapability: "disconnect" = null as never as Exclude<keyof System, keyof CoreSystem>

program.permissions.get("files")
program.permissions.all()
program.permissions.set("files", true)
program.permissions.delete("files")

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
