# @phreshos/node

The Node.js interface for a running PhreshOS System and local Program projects.

```ts
import { Project, System } from "@phreshos/node"

const project = await Project.open()
const system = await System.connect()

await project.install(system)

// This is the same transport-neutral System contract used by Server Programs.
const programs = await system.program.list()

await system.disconnect()
```

`Project.open()` discovers `phresh.config.ts` from the current working
directory by default. `System.connect()` resolves its home from an explicit
argument, then `PHRESHOS_HOME`, then the current user's `.phreshos` directory.

Project operations remain available without duplicating CLI logic:

```ts
const project = await Project.open() // process.cwd()
const system = await System.connect()

await project.pack()
await project.start(system, { signal })
await project.dev(system, { signal })
await project.install(system)

await system.disconnect()
```

`Project` owns authoring concepts such as production builds and development
Client servers. The lower-level System API stays composable: use
`system.forceCreateProgram(description)` to replace one runtime Program, and
`program.process.run(launch, { signal })` when one Process should live exactly
as long as its asynchronous iterator.
