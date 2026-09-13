# `@phreshos/node`

Node.js access to a PhreshOS System and local Program projects.

[Documentation](https://docs.phreshos.com/sdks/node) ·
[System](https://docs.phreshos.com/system) ·
[First Program](https://docs.phreshos.com/first-program) ·
[Source](https://github.com/PhreshOS/node)

## Role

The Node SDK exposes the same complete System contract available inside Server
Endpoints. It adds only the lifecycle of an externally owned connection and the
`Project` authoring API for building, running, installing, and packaging local
Program projects.

The connection transport is not public API. Core owns the domain model, and the
System remains authoritative whether an operation can execute locally or must
cross the connection boundary.

## Installation

| Package manager | Command |
| --- | --- |
| npm | `npm install @phreshos/node` |
| pnpm | `pnpm add @phreshos/node` |
| Bun | `bun add @phreshos/node` |
| Yarn | `yarn add @phreshos/node` |

`@phreshos/core` is a peer dependency and the single import path for shared
System and runtime contracts.

```ts
import { Project, System } from "@phreshos/node"

const system = await System.connect()
const project = await Project.open()

for await (const event of await project.start(system)) {
  console.log(event)
}

await system.disconnect()
```

See [Node SDK](https://docs.phreshos.com/sdks/node) for System connection and
Project lifecycle details.

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

`verify` checks the types, builds the package, runs the connection and Project
tests, and validates the published package shape independently.

`check` performs static checks, `build` creates distributable output, and `test`
runs Vitest assertions from `tests/`. Run `build` before testing built artifacts.
`verify` runs `check`, `build`, and `test` in order. Operational tooling belongs
in `scripts/`; tests and their fixtures belong in `tests/`. Verification uses
the committed dependency graph without local package substitutions.

## Related repositories

- [`@phreshos/core`](https://github.com/PhreshOS/core) owns the shared System
  and runtime contracts.
- [`@phreshos/server`](https://github.com/PhreshOS/server) exposes the same
  System contract inside Server Endpoints.
- [`@phreshos/cli`](https://github.com/PhreshOS/cli) presents Project and System
  operations as terminal commands.
- [PhreshOS System](https://github.com/PhreshOS/system) owns the connected
  runtime.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 Zohayr SLILEH.
