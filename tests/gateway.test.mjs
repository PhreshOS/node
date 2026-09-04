import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { ClientEndpoint, ClientService, Endpoint, Process, Program, Project, ServerEndpoint, ServerService, Service, System, gatewayAddress, resolveHome } from "../dist/main.js"
import { createGateway } from "./gateway-fixture.mjs"

test("Project.open discovers phresh.config.ts from cwd by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phresh-project-"))
  const previous = process.cwd()

  try {
    await writeFile(join(directory, "phresh.config.ts"), [
      "export default {",
      "  identity: 'example',",
      "  client: { location: 'client' }",
      "}"
    ].join("\n"))
    process.chdir(directory)

    const project = await Project.open()

    assert.equal(project.directory, await realpath(directory))
    assert.equal(project.config.identity, "example")
  } finally {
    process.chdir(previous)
    await rm(directory, { recursive: true, force: true })
  }
})

test("resolveHome follows argument, environment, then owner default", () => {
  assert.equal(resolveHome("/explicit", { PHRESHOS_HOME: "/environment" }, "/owner"), "/explicit")
  assert.equal(resolveHome(undefined, { PHRESHOS_HOME: "/environment" }, "/owner"), "/environment")
  assert.equal(resolveHome(undefined, {}, "/owner"), "/owner/.phreshos")
})

test("Project derives one Server Endpoint execution mode without retaining the other", () => {
  const directory = join(process.cwd(), "project")
  const project = Project.define({
    identity: "worker-program",
    server: {
      location: "dist/server",
      entryFile: "main.js",
      development: { startCommand: "tsx source/server/main.ts" }
    }
  }, { directory })

  assert.deepEqual(project.productionDefinition().server, {
    location: join(directory, "dist", "server"),
    start: undefined,
    service: undefined,
    installCommand: undefined,
    uninstallCommand: undefined,
    entryFile: "main.js"
  })
  assert.deepEqual(project.developmentDefinition().server, {
    location: directory,
    start: undefined,
    service: undefined,
    installCommand: undefined,
    uninstallCommand: undefined,
    startCommand: "tsx source/server/main.ts"
  })
})

test("Project returns the original production Process generator without consuming it", async () => {
  const directory = join(process.cwd(), "project")
  const project = Project.define({
    identity: "example",
    client: { location: "client" }
  }, { directory })
  const calls = []
  const lifecycle = (async function* () {
    yield { event: "started", process: { identity: "process-identity" } }
  })()
  const system = {
    async forceCreateProgram(definition) {
      calls.push({ operation: "forceCreateProgram", definition })
      return {
        process: {
          run(launch, options) {
            calls.push({ operation: "run", launch, signal: options.signal })
            return lifecycle
          }
        }
      }
    }
  }

  const signal = new AbortController().signal
  const result = await project.start(system, { options: { mode: "test" }, signal })

  assert.equal(result, lifecycle)
  assert.equal(calls[0].operation, "forceCreateProgram")
  assert.equal(calls[0].definition.client.location, join(directory, "client"))
  assert.deepEqual(calls[1].launch, { options: { mode: "test" } })
  assert.equal(calls[1].signal, signal)
})

test("Project returns the original development and installation generators", async () => {
  const client = createHttpServer((_request, response) => response.end())
  await new Promise((resolve, reject) => {
    client.once("error", reject)
    client.listen(0, "localhost", resolve)
  })
  const address = client.address()
  assert.equal(typeof address, "object")

  const project = Project.define({
    identity: "example",
    client: {
      location: "dist/client",
      permissions: { all: true },
      development: { url: `http://localhost:${address.port}/` }
    }
  })
  const development = (async function* () {})()
  const installation = (async function* () {})()
  const definitions = []
  const system = {
    async forceCreateProgram(definition) {
      definitions.push(definition)
      return {
        assetId: "00000000-0000-4000-8000-000000000000",
        process: { run: () => development },
        install: () => installation
      }
    }
  }

  try {
    assert.equal(await project.dev(system), development)
    assert.equal(await project.install(system), installation)
    assert.equal(definitions[0].client.location, `http://localhost:${address.port}/`)
    assert.deepEqual(definitions[0].client.permissions, { all: true })
    assert.deepEqual(definitions[1].client.permissions, { all: true })
    assert.equal(definitions[1].client.location.endsWith("/dist/client"), true)
  } finally {
    await new Promise((resolve, reject) => client.close(error => error ? reject(error) : resolve()))
  }
})

test("Project keeps an HTTP development Client Endpoint location as a runtime location", () => {
  const project = Project.define({
    identity: "web-client",
    client: {
      location: "dist/client",
      development: { url: "https://localhost.example/client/" }
    }
  })

  assert.equal(project.developmentDefinition().client.location, "https://localhost.example/client/")
})

test("System.connect exposes the shared System contract over one owner-local address", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-gateway-"))
  const address = gatewayAddress(home)
  const server = createGateway(address, {
    session: {
      authorization: "owner",
      linkManager: { appearance: { key: "appearance", value: { background: { light: "#fff" } } } },
      authManager: {
        programManager: { programs: [] },
        processManager: { processes: [] }
      }
    },
    route({ event }) {
      if (event === "/auth/uploads/access") return { path: join(home, "uploads"), limit: 1024 }
    }
  })

  await mkdir(home, { recursive: true })
  await server.listen()

  const system = await System.connect(home)
  try {
    const userHome = await realpath(homedir())

    assert.equal("home" in system, false)
    assert.equal("address" in system, false)
    assert.equal("transport" in system, false)
    assert.equal("programHandle" in system, false)
    assert.equal("processHandle" in system, false)
    assert.equal(await system.storage.path(), userHome)
    assert.equal(await system.storage.resolve(".."), dirname(userHome))
    assert.equal(await system.uploads.path(), join(home, "uploads"))
    assert.deepEqual(await system.appearance.snapshot(), { background: { light: "#fff" } })

    const serverService = system.service({ program: "example", process: "main", endpoint: "server" })
    const sameServerService = system.service({ program: "example", process: "main", endpoint: "server" })
    const clientService = system.service({ program: "example", process: "main", endpoint: "client" })
    const exactService = system.service({ process: "1f4b222c-25d7-4ba8-85e5-d5e59cfe0928", endpoint: "server" })

    assert.equal(serverService, sameServerService)
    assert.equal(exactService, system.service({ process: "1f4b222c-25d7-4ba8-85e5-d5e59cfe0928", endpoint: "server" }))
    assert.throws(() => system.service({ process: "main", endpoint: "server" }), /complete service key/)
    assert(serverService instanceof Service)
    assert(serverService instanceof ServerService)
    assert.equal("channel" in serverService, false)
    assert.equal("name" in serverService, false)
    assert.equal(typeof serverService.exists, "function")
    assert.equal(typeof serverService.publish, "function")
    assert.equal(typeof serverService.waitReady, "function")
    assert.equal(typeof serverService.lifecycle.subscribe, "function")
    assert(clientService instanceof Service)
    assert(clientService instanceof ClientService)
    assert.equal(typeof clientService.exists, "function")
    assert.equal(typeof clientService.publish, "function")
    assert.equal(typeof clientService.waitReady, "function")
  } finally {
    await system.disconnect()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("System reconstructs and follows the authoritative LinkManager model", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-system-model-"))
  const address = gatewayAddress(home)
  const calls = []
  const commands = new Map()
  const program = {
    reference: "program-reference",
    identity: "example",
    assetId: "00000000-0000-4000-8000-000000000001",
    installed: false,
    name: "Example",
    version: null,
    description: null,
    hasAgent: true,
    server: { start: true, service: false },
    client: null
  }
  const replacement = { ...program, reference: "replacement-reference", assetId: "00000000-0000-4000-8000-000000000002" }
  const parentRecord = {
    reference: "parent-reference",
    identity: "parent-identity",
    name: "manager",
    program: program.identity,
    parent: null,
    options: {},
    startedAt: new Date(),
    server: null,
    client: null
  }
  const processRecord = {
    reference: "process-reference",
    identity: "process-identity",
    name: null,
    program: program.identity,
    parent: parentRecord,
    options: { mode: "test" },
    startedAt: new Date(),
    server: { ready: true, service: false },
    client: null
  }
  let creations = 0
  const server = createGateway(address, {
    session: {
      authorization: "owner",
      linkManager: { appearance: { key: "appearance", value: {} } },
      authManager: {
        programManager: { programs: [[program.identity, program]] },
        processManager: { processes: [[parentRecord.identity, parentRecord]] }
      }
    },
    async route({ event, values, publish }) {
      calls.push({ event, values })
      const [, ...input] = values

      if (event === "/auth/program/force-create-program") {
        const created = creations++ === 0 ? program : replacement
        await publish("/auth/program/create", created)
        return created.identity
      }

      if (event === "/auth/program/area") return join(home, String(input[1]))
      if (event === "/auth/program/icon") return [137, 80, 78, 71]
      if (event === "/auth/program/agent") return "Program agent"
      if (event === "/auth/program/store") return "stored"
      if (event === "/auth/program/logs") return [{ value: 1 }]
      if (event === "/auth/program/permissions") {
        if (input[1] === "all") return { all: [] }
        if (input[1] === "allows") return true
        if (input[1] === "set" || input[1] === "delete") return
        return []
      }

      if (event === "/auth/program/command") {
        const [stream, operation] = input
        assert.equal(operation, "run")
        let cancel
        const cancelled = new Promise(resolve => { cancel = resolve })
        commands.set(stream, cancel)
        await publish("/auth/process/created", processRecord)
        await publish("/auth/process/exited", parentRecord, 0, null)
        await publish("/auth/program/command-output", stream, { event: "started", process: processRecord })
        await cancelled
        await publish("/auth/process/exited", processRecord, null, "SIGTERM")
        return
      }

      if (event === "/auth/program/command-cancel") {
        commands.get(input[0])?.()
        commands.delete(input[0])
      }

      if (event === "/auth/process/parent") {
        assert.deepEqual(input[0], { identity: processRecord.identity, reference: processRecord.reference })
        return { ...parentRecord, program }
      }
    }
  })

  await mkdir(home, { recursive: true })
  await server.listen()

  const system = await System.connect(home)
  try {
    const createdEvent = system.program.waitFor("create")
    const created = await system.forceCreateProgram({
      identity: "example",
      storage: join(home, "storage"),
      server: { location: join(home, "server"), entryFile: "main.js" }
    })

    assert.equal(await createdEvent, created)
    assert(created instanceof Program)
    assert.equal(created.assetId, program.assetId)
    assert.equal(await system.program.find("example"), created)
    assert.equal((await system.program.list())[0], created)
    assert.equal(await created.data.path(), join(home, "data"))
    assert.equal(await created.store.get("state"), "stored")
    assert.deepEqual(await created.logs.query("select 1"), [{ value: 1 }])
    assert.deepEqual(await created.permissions.get("all"), [])
    assert.equal((await created.icon()).type, "image/png")
    assert.equal(await created.agent(), "Program agent")

    const controller = new AbortController()
    const processCreated = system.process.waitFor("create")
    const run = created.process.run({ options: { mode: "test" } }, { signal: controller.signal })
    const started = await run.next()

    assert.equal(started.value.event, "started")
    assert(started.value.process instanceof Process)
    assert(started.value.process.server instanceof ServerEndpoint)
    assert(started.value.process.server instanceof Endpoint)
    assert(started.value.process.client instanceof ClientEndpoint)
    assert.equal("permissions" in started.value.process, false)
    assert(started.value.process.client instanceof Endpoint)
    assert.equal(await processCreated, started.value.process)
    assert.equal(await system.process.find(processRecord.identity), started.value.process)
    assert.equal((await created.process.list())[0], started.value.process)
    assert.equal(await started.value.process.option("mode"), "test")
    const retainedParent = await started.value.process.parent()
    assert(retainedParent instanceof Process)
    assert.equal(retainedParent.identity, parentRecord.identity)
    assert.equal(await retainedParent.exited(), true)

    controller.abort(new Error("cancelled by test"))
    await assert.rejects(run.next(), /cancelled by test/)

    const replaced = await system.forceCreateProgram({
      identity: "example",
      storage: join(home, "storage"),
      server: { location: join(home, "server"), entryFile: "main.js" }
    })

    assert(replaced instanceof Program)
    assert.notEqual(replaced, created)
    assert(calls.every(call => !call.event.startsWith("/gateway/")))
    assert(calls.every(call => call.values[0] === "owner"))
  } finally {
    await system.disconnect()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("Endpoint observations remain live across the owner LinkManager connection", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-system-events-"))
  const address = gatewayAddress(home)
  const program = {
    reference: "program-reference",
    identity: "example",
    assetId: "00000000-0000-4000-8000-000000000001",
    installed: true,
    name: "Example",
    version: null,
    description: null,
    hasAgent: false,
    server: { start: true, service: false },
    client: null
  }
  const processRecord = {
    reference: "process-reference",
    identity: "process-identity",
    name: "main",
    program: program.identity,
    parent: null,
    options: {},
    startedAt: new Date(),
    server: { ready: true, service: false },
    client: null
  }
  let followed
  let confirmUnfollow
  const unfollowed = new Promise(resolve => { confirmUnfollow = resolve })
  const server = createGateway(address, {
    session: {
      authorization: "owner",
      linkManager: { appearance: { key: "appearance", value: {} } },
      authManager: {
        programManager: { programs: [[program.identity, program]] },
        processManager: { processes: [[processRecord.identity, processRecord]] }
      }
    },
    async route({ event, values, publish }) {
      const [, subscription, observation] = values
      if (event === "/auth/process/follow") {
        followed = observation
        await publish("/auth/process/followed", subscription, "changed", new Uint8Array([1, 2, 3]))
      }
      if (event === "/auth/process/unfollow") confirmUnfollow(subscription)
    }
  })

  await mkdir(home, { recursive: true })
  await server.listen()

  const system = await System.connect(home)
  try {
    const process = await system.process.find(processRecord.identity)
    assert(process)

    const message = new Promise(resolve => {
      const stop = process.server.subscribe("changed", value => {
        stop()
        resolve(value)
      })
    })

    assert.deepEqual(await message, new Uint8Array([1, 2, 3]))
    assert.deepEqual(followed, {
      scope: "endpoint",
      process: processRecord.identity,
      endpoint: "server",
      event: "changed"
    })
    assert.equal(typeof await unfollowed, "string")
  } finally {
    await system.disconnect()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})
