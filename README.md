# `@phreshos/node`

Node.js access to a running PhreshOS System and local Program projects.

The Node SDK exposes the same System model used inside Server Endpoints and adds
only connection lifecycle and project tooling.

## Installation

| Package manager | Command |
| --- | --- |
| npm | `npm install @phreshos/node` |
| pnpm | `pnpm add @phreshos/node` |
| Bun | `bun add @phreshos/node` |
| Yarn | `yarn add @phreshos/node` |

## System

```ts
import { System } from "@phreshos/node"

const system = await System.connect()
const programs = await system.program.list()

await system.disconnect()
```

The transport is not public API. Code receives the same System, Program,
Process, Endpoint, Service, Window, storage, and upload handles used by the
Server SDK. `disconnect()` exists because external Node code owns the
connection.

## Project

```ts
import { Project, System } from "@phreshos/node"

const project = await Project.open()
const system = await System.connect()

for await (const event of await project.start(system, { signal })) {
  console.log(event)
}

await system.disconnect()
```

`Project` owns authoring concerns: builds, development and production
definitions, installation, execution shortcuts, and packaging. The System
receives only the resulting Program definition.

`Project.dev()` starts and supervises a declared Client development command. It
assigns an available port when no URL is declared and provides the port and
public Program asset base through `PHRESHOS_CLIENT_PORT` and
`PHRESHOS_CLIENT_BASE`.

`Project.open()` starts from the current working directory by default.
`System.connect()` resolves an explicit System home, then `PHRESHOS_HOME`,
then the current owner's default System home.

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

See the [Node SDK documentation](https://github.com/PhreshOS/docs/blob/main/content/docs/sdks/node.mdx)
for the public model.

## Repository boundary

This repository owns the external Node connection and local-project API. Core
owns the domain model, Server owns the Endpoint runtime adapter, and CLI owns
terminal presentation and native service management.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 Zohayr SLILEH.
