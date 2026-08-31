import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client, ClientService, Endpoint, Process, Program, Project, Server, ServerService, Service, System, gatewayAddress, resolveHome } from "../dist/main.js"

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

test("Project derives one Server execution mode without retaining the other", () => {
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
    installCommand: undefined,
    uninstallCommand: undefined,
    entryFile: "main.js"
  })
  assert.deepEqual(project.developmentDefinition().server, {
    location: directory,
    start: undefined,
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
  const project = Project.define({
    identity: "example",
    client: {
      location: "dist/client",
      development: { url: "https://localhost.example/client/" }
    }
  })
  const development = (async function* () {})()
  const installation = (async function* () {})()
  const definitions = []
  const system = {
    async forceCreateProgram(definition) {
      definitions.push(definition)
      return {
        process: { run: () => development },
        install: () => installation
      }
    }
  }

  assert.equal(await project.dev(system), development)
  assert.equal(await project.install(system), installation)
  assert.equal(definitions[0].client.location, "https://localhost.example/client/")
  assert.equal(definitions[1].client.location.endsWith("/dist/client"), true)
})

test("Project keeps an HTTP development Client location as a runtime location", () => {
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
  const server = createServer(socket => {
    let buffer = ""
    socket.on("data", chunk => {
      buffer += String(chunk)
      const boundary = buffer.indexOf("\n")
      if (boundary < 0) return
      const envelope = JSON.parse(buffer.slice(0, boundary))
      if (envelope.target === "api" && envelope.request.capability === "appearance") {
        socket.end(`${JSON.stringify({ success: true, result: { background: { light: "#fff" } } })}\n`)
      }
    })
  })

  await mkdir(home, { recursive: true })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(address, resolve)
  })

  const system = await System.connect(home)
  try {
    assert.equal("home" in system, false)
    assert.equal("address" in system, false)
    assert.equal("transport" in system, false)
    assert.equal("programHandle" in system, false)
    assert.equal("processHandle" in system, false)
    assert.deepEqual(await system.appearance.snapshot(), { background: { light: "#fff" } })

    const serverService = system.service({ program: "example", endpoint: "server", name: "state" })
    const sameServerService = system.service({ program: "example", endpoint: "server", name: "state" })
    const clientService = system.service({ program: "example", endpoint: "client", name: "state" })

    assert.equal(serverService, sameServerService)
    assert(serverService instanceof Service)
    assert(serverService instanceof ServerService)
    assert.equal("channel" in serverService, false)
    assert.equal(typeof serverService.lifecycle.subscribe, "function")
    assert(clientService instanceof Service)
    assert(clientService instanceof ClientService)
  } finally {
    await system.disconnect()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})

test("a Process run is addressed to the exact Program and follows its signal", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-system-run-"))
  const address = gatewayAddress(home)
  const requests = []
  let closeRun
  const runClosed = new Promise(resolve => { closeRun = resolve })
  const program = {
    reference: "program-reference",
    identity: "example",
    name: "Example",
    version: null,
    description: null,
    hasAgent: false,
    server: { start: true },
    client: null
  }
  const replacement = { ...program, reference: "replacement-reference" }
  const process = {
    reference: "process-reference",
    identity: "process-identity",
    name: null,
    program: program.identity,
    programSnapshot: program,
    startedAt: new Date().toISOString(),
    server: { declared: true, running: true },
    client: { declared: false, running: false }
  }

  let creations = 0
  const server = createServer(socket => {
    let buffer = ""
    let running = false
    socket.on("data", chunk => {
      buffer += String(chunk)
      const boundary = buffer.indexOf("\n")
      if (boundary < 0) return
      const envelope = JSON.parse(buffer.slice(0, boundary))
      requests.push(envelope)

      if (envelope.request.word === "force-create") {
        socket.end(`${JSON.stringify({ event: "created", program: creations++ === 0 ? program : replacement })}\n`)
      } else if (envelope.request.word === "run-process") {
        running = true
        socket.write(`${JSON.stringify({ event: "started", process })}\n`)
      } else if (envelope.request.capability === "program" && envelope.request.operation === "inspect") {
        socket.end(`${JSON.stringify({ success: true, result: program })}\n`)
      } else if (envelope.request.capability === "program" && envelope.request.operation === "list") {
        socket.end(`${JSON.stringify({ success: true, result: { data: [program], total: 1, truncated: false } })}\n`)
      } else if (envelope.request.capability === "program" && envelope.request.operation === "wait") {
        socket.end(`${JSON.stringify({ success: true, result: { event: envelope.request.input.event, payload: program } })}\n`)
      } else if (envelope.request.capability === "process" && envelope.request.operation === "inspect") {
        socket.end(`${JSON.stringify({ success: true, result: process })}\n`)
      } else if (envelope.request.capability === "process" && envelope.request.operation === "list") {
        socket.end(`${JSON.stringify({ success: true, result: { data: [process], total: 1, truncated: false } })}\n`)
      } else if (envelope.request.capability === "process" && envelope.request.operation === "wait") {
        const payload = process
        socket.end(`${JSON.stringify({ success: true, result: { event: envelope.request.input.event, payload } })}\n`)
      } else if (envelope.request.capability === "endpoint" && envelope.request.operation === "waitLifecycle") {
        socket.end(`${JSON.stringify({ success: true, result: {
          scope: "endpoint.lifecycle",
          event: envelope.request.input.event,
          payload: null
        } })}\n`)
      }
    })
    socket.on("close", () => { if (running) closeRun() })
  })

  await mkdir(home, { recursive: true })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(address, resolve)
  })

  const system = await System.connect(home)
  try {
    const created = await system.forceCreateProgram({
      identity: "example",
      storage: join(home, "storage"),
      server: { location: join(home, "server"), entryFile: "main.js" }
    })

    assert.equal(created instanceof Program, true)

    const controller = new AbortController()
    const iterator = created.process.run({ options: { mode: "test" } }, { signal: controller.signal })
    const started = await iterator.next()

    assert.equal(started.value.event, "started")
    assert.equal(started.value.process.identity, process.identity)
    assert.equal(started.value.process instanceof Process, true)
    assert.equal(started.value.process.program(), created)
    assert.equal(started.value.process.server instanceof Server, true)
    assert.equal(started.value.process.server instanceof Endpoint, true)
    assert.equal(started.value.process.client instanceof Client, true)
    assert.equal(started.value.process.client instanceof Endpoint, true)
    assert.equal(await started.value.process.server.process(), started.value.process)
    assert.equal(await system.program.find(program.identity), created)
    assert.equal((await system.program.list())[0], created)
    assert.equal(await system.program.waitFor("create"), created)
    assert.equal(await system.process.find(process.identity), started.value.process)
    assert.equal((await system.process.list())[0], started.value.process)
    assert.equal(await system.process.waitFor("create"), started.value.process)
    assert.equal(await started.value.process.server.lifecycle.waitFor("start"), undefined)

    controller.abort(new Error("cancelled by test"))
    await assert.rejects(iterator.next(), /cancelled by test/)
    await runClosed

    const run = requests.find(value => value.request.word === "run-process").request
    assert.deepEqual(run.handle, { identity: "example", reference: "program-reference" })
    assert.deepEqual(run.launch, { options: { mode: "test" } })

    const replaced = await system.forceCreateProgram({
      identity: "example",
      storage: join(home, "storage"),
      server: { location: join(home, "server"), entryFile: "main.js" }
    })

    assert.notEqual(replaced, created)
    assert.equal(replaced instanceof Program, true)
  } finally {
    await system.disconnect()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})
