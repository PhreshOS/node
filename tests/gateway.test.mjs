import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "vitest"
import { ClientEndpoint, ClientService, Endpoint, Process, Program, ServerEndpoint, ServerService, Service, defaultAppearance } from "@phreshos/core"
import { Project, System, gatewayAddress, resolveHome } from "../dist/main.js"
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
      worker: "main.js",
      devCommand: "tsx source/server/main.ts"
    }
  }, { directory })

  assert.deepEqual(project.productionDefinition().server, {
    location: join(directory, "dist", "server"),
    start: undefined,
    service: undefined,
    installCommand: undefined,
    uninstallCommand: undefined,
    worker: "main.js"
  })
  assert.deepEqual(project.developmentDefinition().server, {
    location: directory,
    start: undefined,
    service: undefined,
    installCommand: undefined,
    uninstallCommand: undefined,
    command: "tsx source/server/main.ts"
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
    program: {
      async forceCreate(definition) {
        calls.push({ operation: "forceCreate", definition })
        return {
          runProcess(launch, options) {
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
  assert.equal(calls[0].operation, "forceCreate")
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
    permissions: { all: true },
    client: {
      location: "dist/client",
      devUrl: `http://localhost:${address.port}/`
    }
  })
  const development = (async function* () {})()
  const installation = (async function* () {})()
  const definitions = []
  const system = {
    program: {
      async forceCreate(definition) {
        definitions.push(definition)
        return {
          assetId: "00000000-0000-4000-8000-000000000000",
          runProcess: () => development,
          forget: async () => undefined,
          install: () => installation
        }
      }
    }
  }

  try {
    assert.equal(await project.dev(system), development)
    assert.equal(await project.install(system), installation)
    assert.equal(definitions[0].client.location, `http://localhost:${address.port}/`)
    assert.deepEqual(definitions[0].permissions, { all: true })
    assert.deepEqual(definitions[1].permissions, { all: true })
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
      devUrl: "https://localhost.example/client/"
    }
  })

  assert.equal(project.developmentDefinition().client.location, "https://localhost.example/client/")
})

test("System.connect exposes the shared System contract over one owner-local address", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-gateway-"))
  const address = gatewayAddress(home)
  const requestedServiceIconSizes = []
  const server = createGateway(address, {
    snapshot: {
      linkManager: { appearance: { key: "appearance", value: defaultAppearance } },
      authManager: {
        programManager: { programs: [] },
        processManager: { processes: [] }
      }
    },
    route({ event, values }) {
      if (event === "/auth/uploads/access") return { path: join(home, "uploads"), limit: 1024 }
      if (event === "/auth/process/service/list" || event === "/auth/process/service/search") {
        return [{ program: "example", process: "main", endpoint: "server" }]
      }
      if (event === "/auth/process/service/available") return true
      if (event === "/auth/process/service/program-metadata") return { name: "Example", version: "0.0.0" }
      if (event === "/auth/process/service/program-icon") {
        requestedServiceIconSizes.push(values[1])
        return [137, 80, 78, 71]
      }
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
    assert.equal(await system.storage.navigate("..").path(), dirname(userHome))
    assert.equal(await system.uploads.path(), join(home, "uploads"))
    assert.deepEqual(await system.appearance.snapshot(), defaultAppearance)

    const serverService = system.service.prepare({ program: "example", process: "main", endpoint: "server" })
    const sameServerService = system.service.prepare({ program: "example", process: "main", endpoint: "server" })
    const clientService = system.service.prepare({ program: "example", process: "main", endpoint: "client" })

    assert.equal(serverService, sameServerService)
    assert.throws(() => system.service.prepare({ process: "main", endpoint: "server" }), /complete Service address/)
    assert(serverService instanceof Service)
    assert(serverService instanceof ServerService)
    assert.equal("channel" in serverService, false)
    assert.equal("name" in serverService, false)
    assert.equal(typeof serverService.available, "function")
    assert.equal(typeof serverService.programMetadata, "function")
    assert.equal(typeof serverService.programIcon, "function")
    assert.equal(typeof serverService.publish, "function")
    assert.equal(typeof serverService.waitReady, "function")
    assert.equal(typeof serverService.lifecycle.subscribe, "function")
    assert(clientService instanceof Service)
    assert(clientService instanceof ClientService)
    assert.equal(typeof clientService.available, "function")
    assert.equal(typeof clientService.publish, "function")
    assert.equal(typeof clientService.waitReady, "function")
    assert.deepEqual((await system.service.list()).map(service => service.address()), [serverService.address()])
    assert.deepEqual((await system.service.search("main")).map(service => service.address()), [serverService.address()])
    assert.equal(await serverService.available(), true)
    const metadata = await serverService.programMetadata()
    await serverService.programIcon()
    const icon = await serverService.programIcon("small")
    assert.deepEqual(requestedServiceIconSizes, ["medium", "small"])
    assert.equal(metadata.name, "Example")
    assert.equal(metadata.version, "0.0.0")
    assert.equal(icon.type, "image/png")
    assert.deepEqual([...new Uint8Array(await icon.arrayBuffer())], [137, 80, 78, 71])
  } finally {
    await system.disconnect()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("System.connect closes the Gateway when its System snapshot cannot be represented", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-invalid-gateway-"))
  const address = gatewayAddress(home)
  let peer
  let confirmDisconnect
  const disconnected = new Promise(resolve => { confirmDisconnect = resolve })
  const server = createGateway(address, {
    snapshot: [],
    connected(connection) {
      peer = connection
      connection.$internal.subscribeOnce("disconnect", confirmDisconnect)
    }
  })

  await mkdir(home, { recursive: true })
  await server.listen()

  try {
    await assert.rejects(System.connect(home), /invalid System snapshot/)
    await Promise.race([
      disconnected,
      new Promise((_, reject) => setTimeout(() => reject(new Error("The rejected System connection remained open")), 500))
    ])
  } finally {
    await peer?.disconnect()
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
    version: "0.0.0",
    description: null,
    hasAgent: true,
    permissions: {},
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
    serverEndpoint: true,
    server: null,
    client: null,
    clientEndpoint: null
  }
  const processRecord = {
    reference: "process-reference",
    identity: "process-identity",
    name: null,
    program: program.identity,
    parent: parentRecord,
    options: { mode: "test" },
    startedAt: new Date(),
    serverEndpoint: true,
    server: { ready: true, service: false },
    client: null,
    clientEndpoint: null
  }
  let creations = 0
  const server = createGateway(address, {
    snapshot: {
      linkManager: { appearance: { key: "appearance", value: defaultAppearance } },
      authManager: {
        programManager: { programs: [[program.identity, program]] },
        processManager: { processes: [[parentRecord.identity, parentRecord]] }
      }
    },
    async route({ event, values, publish }) {
      calls.push({ event, values })
      const input = values

      if (event === "/auth/program/force-create-program") {
        const created = creations++ === 0 ? program : replacement
        await publish("/auth/program/create", created)
        return created.identity
      }

      if (event === "/auth/program/area") return join(home, String(input[1]))
      if (event === "/auth/program/icon") return [137, 80, 78, 71]
      if (event === "/auth/program/agent") return "Program agent"
      if (event === "/auth/program/definition") return {
        identity: "example",
        storage: join(home, "storage"),
        server: { location: join(home, "server"), worker: "main.js" }
      }
      if (event === "/auth/program/store") return "stored"
      if (event === "/auth/program/logs") return [{ value: 1 }]
      if (event === "/auth/program/permissions") {
        if (input[1] === "all") return { all: [] }
        if (input[1] === "allows") return true
        if (input[1] === "allow") {
          await publish("/auth/program/permissions-change", {
            ...program,
            permissions: { network: ["https://api.example.com"] }
          })
          return
        }
        if (input[1] === "deny" || input[1] === "cancel-request") return
        if (input[1] === "request") return []
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
    const createdEvent = system.program.wait("create")
    const created = await system.program.forceCreate({
      identity: "example",
      storage: join(home, "storage"),
      server: { location: join(home, "server"), worker: "main.js" }
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
    const programPermissions = created.wait("permissions")
    const systemPermissions = system.program.wait("permissions")
    await created.permissions.allow("network", ["https://api.example.com"])
    assert.deepEqual(await programPermissions, { network: ["https://api.example.com"] })
    assert.deepEqual(await systemPermissions, {
      program: created,
      permissions: { network: ["https://api.example.com"] }
    })
    await created.permissions.deny("network")
    assert.deepEqual(await created.permissions.request("uploads"), [])
    assert.equal((await created.icon()).type, "image/png")
    assert.equal(await created.agent(), "Program agent")
    assert.deepEqual(await created.definition(), {
      identity: "example",
      version: "0.0.0",
      storage: join(home, "storage"),
      server: { location: join(home, "server"), worker: "main.js" }
    })

    const controller = new AbortController()
    const processCreated = system.process.wait("create")
    const run = created.runProcess({ options: { mode: "test" } }, { signal: controller.signal })
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
    assert.equal((await created.processes())[0], started.value.process)
    assert.equal(await started.value.process.options("mode"), "test")
    const retainedParent = await started.value.process.parent()
    assert(retainedParent instanceof Process)
    assert.equal(retainedParent.identity, parentRecord.identity)
    assert.equal(await retainedParent.exited(), true)
    await assert.rejects(retainedParent.server.running(), /no longer exists/)
    await assert.rejects(retainedParent.client.running(), /no longer exists/)

    controller.abort(new Error("cancelled by test"))
    await assert.rejects(run.next(), /cancelled by test/)

    const replaced = await system.program.forceCreate({
      identity: "example",
      storage: join(home, "storage"),
      server: { location: join(home, "server"), worker: "main.js" }
    })

    assert(replaced instanceof Program)
    assert.notEqual(replaced, created)
    assert(calls.every(call => !call.event.startsWith("/gateway/")))
    assert(calls.every(call => !call.values.includes("owner")))
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
    version: "0.0.0",
    description: null,
    hasAgent: false,
    permissions: {},
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
    serverEndpoint: true,
    server: { ready: true, service: false },
    client: null,
    clientEndpoint: null
  }
  let followed
  let confirmUnfollow
  const unfollowed = new Promise(resolve => { confirmUnfollow = resolve })
  const server = createGateway(address, {
    snapshot: {
      linkManager: { appearance: { key: "appearance", value: defaultAppearance } },
      authManager: {
        programManager: { programs: [[program.identity, program]] },
        processManager: { processes: [[processRecord.identity, processRecord]] }
      }
    },
    async route({ event, values, publish }) {
      const [subscription, observation] = values
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
    assert.equal(await process.server.running(), true)
    assert.equal(await process.server.process(), process)
    await assert.rejects(process.client.running(), /declared no Client Endpoint/)
    await assert.rejects(process.client.process(), /declared no Client Endpoint/)
    const stopUnavailableLifecycle = process.client.lifecycle.subscribe("start", () => undefined)
    stopUnavailableLifecycle()
    await assert.rejects(process.client.lifecycle.wait("start", 100), /declared no Client Endpoint/)

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
