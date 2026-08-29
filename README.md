# @phreshos/node

The Node.js interface for a running PhreshOS System and local Program projects.

```ts
import { Project, System } from "@phreshos/node"

const project = await Project.open()
const system = await System.connect()

for await (const chunk of await project.install(system)) {
  process[chunk.stream].write(chunk.text)
}

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
for await (const event of await project.start(system, { signal })) {
  // started, output, exited
}

for await (const event of await project.dev(system, { signal })) {
  // started, output, exited
}

for await (const chunk of await project.install(system)) {
  // stdout or stderr
}

await system.disconnect()
```

These shortcuts return the original `program.install()` or
`program.process.run()` generator; they do not consume or mirror its events.
The CLI owns presentation and its additional development Client server.

For custom composition, resolve either Program definition explicitly:

```ts
const definition = project.productionDefinition()
// const definition = project.developmentDefinition()

const program = await system.forceCreateProgram(definition)
const lifecycle = program.process.run({}, { signal })
```

The lower-level System API stays composable: use
`system.forceCreateProgram(definition)` to replace one runtime Program, and
`program.process.run(launch, { signal })` when one Process should live exactly
as long as its asynchronous iterator. Node also exports the runtime `Program`,
`Process`, `Endpoint`, `Server`, and `Client` constructors; handles are
canonical within one connected `System` and support `instanceof`.
