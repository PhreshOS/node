# @phreshos/gateway

Programmatic owner-local access to a running PhreshOS System and to local
Program projects.

```ts
import { Gateway, Project } from "@phreshos/gateway"

const project = await Project.open()
const gateway = await Gateway.open()

for await (const event of gateway.install(project)) {
  // installation progress
}

// The complete transport-neutral System contract used by Server Programs.
const programs = await gateway.system.program.list()

await gateway.close()
```

`Project.open()` discovers `phresh.config.ts` from the current working
directory by default. `Gateway.open()` resolves its home from an explicit
argument, then `PHRESHOS_HOME`, then the current user's `.phreshos` directory.

Project operations remain available without duplicating CLI logic:

```ts
const project = await Project.open() // process.cwd()
const gateway = await Gateway.open()

await project.pack()
for await (const event of gateway.start(project)) { /* production run */ }
for await (const event of gateway.dev(project)) { /* development run */ }
for await (const event of gateway.install(project)) { /* installation */ }
```

`start`, `dev`, and `install` expose ordered asynchronous event streams. The
CLI only interprets arguments and presents those events; it does not implement
a second Project or Gateway lifecycle.
