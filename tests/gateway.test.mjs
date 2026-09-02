import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
      permissions: { files: true },
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
        process: { run: () => development },
        install: () => installation
      }
    }
  }

  try {
    assert.equal(await project.dev(system), development)
    assert.equal(await project.install(system), installation)
    assert.equal(definitions[0].client.location, `http://localhost:${address.port}/`)
    assert.deepEqual(definitions[0].client.permissions, { files: true })
    assert.deepEqual(definitions[1].client.permissions, { files: true })
    assert.equal(definitions[1].client.location.endsWith("/dist/client"), true)
  } finally {
    await new Promise((resolve, reject) => client.close(error => error ? reject(error) : resolve()))
  }
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
    const userHome = await realpath(homedir())

    assert.equal("home" in system, false)
    assert.equal("address" in system, false)
    assert.equal("transport" in system, false)
    assert.equal("programHandle" in system, false)
    assert.equal("processHandle" in system, false)
    assert.equal(await system.storage.path(), userHome)
    assert.equal(await system.storage.resolve(".."), dirname(userHome))
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
    hasAgent: true,
    server: { start: true, service: false },
    client: null
  }
  const replacement = { ...program, reference: "replacement-reference" }
  const forkedProgram = { ...program, reference: "forked-reference", identity: "forked" }
  const process = {
    reference: "process-reference",
    identity: "process-identity",
    name: null,
    program: program.identity,
    programSnapshot: program,
    parent: null,
    options: { mode: "test" },
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
      } else if (envelope.request.word === "fork") {
        socket.end(`${JSON.stringify({ event: "created", program: forkedProgram })}\n`)
      } else if (envelope.request.word === "run-process") {
        running = true
        socket.write(`${JSON.stringify({ event: "started", process })}\n`)
      } else if (envelope.target === "system" && envelope.request.capability === "program" && envelope.request.operation === "inspect") {
        socket.end(`${JSON.stringify({ success: true, result: program })}\n`)
      } else if (envelope.target === "system" && envelope.request.capability === "program" && envelope.request.operation === "list") {
        socket.end(`${JSON.stringify({ success: true, result: { data: [program], total: 1, truncated: false } })}\n`)
      } else if (envelope.target === "system" && envelope.request.capability === "program" && envelope.request.operation === "wait") {
        socket.end(`${JSON.stringify({ success: true, result: { event: envelope.request.input.event, payload: program } })}\n`)
      } else if (envelope.target === "system" && envelope.request.capability === "process" && envelope.request.operation === "inspect") {
        socket.end(`${JSON.stringify({ success: true, result: process })}\n`)
      } else if (envelope.target === "system" && envelope.request.capability === "process" && envelope.request.operation === "list") {
        socket.end(`${JSON.stringify({ success: true, result: { data: [process], total: 1, truncated: false } })}\n`)
      } else if (envelope.target === "system" && envelope.request.capability === "process" && envelope.request.operation === "wait") {
        const payload = process
        socket.end(`${JSON.stringify({ success: true, result: { event: envelope.request.input.event, payload } })}\n`)
      } else if (envelope.target === "system" && envelope.request.capability === "endpoint" && envelope.request.operation === "waitLifecycle") {
        socket.end(`${JSON.stringify({ success: true, result: {
          scope: "endpoint.lifecycle",
          event: envelope.request.input.event,
          payload: null
        } })}\n`)
      } else if (envelope.target === "api" && envelope.request.capability === "program") {
        const request = envelope.request
        socket.end(`${JSON.stringify({ success: true, result: programApiResult(request, home) })}\n`)
      } else if (envelope.target === "api" && envelope.request.capability === "programProcess") {
        const request = envelope.request
        const result = request.operation === "list"
          ? [process]
          : request.event === "create"
            ? process
            : { process, status: "exited", code: 0, signal: null }
        socket.end(`${JSON.stringify({ success: true, result })}\n`)
      } else if (envelope.target === "api" && envelope.request.capability === "traffic") {
        const request = envelope.request
        const endpoint = request.kind === "ask" ? "server" : "client"
        const reference = {
          kind: endpoint,
          process: {
            reference: process.reference,
            identity: process.identity,
            name: process.name,
            program,
            options: process.options,
            startedAt: process.startedAt,
            server: { service: false },
            client: { service: false }
          }
        }
        const values = request.kind === "publish"
          ? [{ to: reference, payload: { value: 1 } }]
          : request.kind === "ask"
            ? ["question-identity", { to: reference, payload: { value: 2 } }]
            : ["question-identity", { to: reference, outcome: { success: true, value: 3 } }]
        socket.end(`${JSON.stringify({ success: true, result: { event: request.event ?? "trace", values } })}\n`)
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
    assert.equal(typeof created.data.text, "function")
    assert.equal(await created.data.path(), join(home, "data"))
    assert.equal(await created.data.resolve("state.txt"), join(home, "data", "state.txt"))
    assert.equal(typeof created.cache.clear, "function")
    assert.equal(typeof created.store.get, "function")
    assert.equal(typeof created.logs.query, "function")
    assert.equal(typeof created.database.query, "function")
    assert.deepEqual(await created.permissions.get("files"), ["read"])
    assert.deepEqual(await created.permissions.all(), { files: ["read"] })
    assert.deepEqual(await created.permissions.set("files", true), { permission: ["read"], needReload: false })
    assert.deepEqual(await created.permissions.delete("files"), { permission: null, needReload: false })
    assert.equal((await created.icon()).type, "image/png")
    assert.equal(await created.agent(), "Program agent")
    await created.data.write("state.txt", "canonical")
    assert.equal(await created.data.text("state.txt"), "canonical")
    assert.equal(await created.store.get("state"), "stored")
    assert.deepEqual(await created.logs.query("select 1"), [{ value: 1 }])
    assert.equal(await created.waitFor("uninstall"), true)
    assert.equal(await created.waitFor("forget"), undefined)
    assert.equal((await created.process.list())[0], started.value.process)
    assert.equal(await created.process.waitFor("create"), started.value.process)
    assert.equal((await created.process.waitFor("exit")).process, started.value.process)
    const forked = await created.fork("forked")
    assert.equal(forked.identity, "forked")
    assert.equal(forked instanceof Program, true)
    assert.equal(await started.value.process.parent(), null)
    assert.equal(await started.value.process.option("mode"), "test")
    const publication = await started.value.process.server.traffic.waitFor("trace")
    assert.equal(publication.to, started.value.process.client)
    assert.deepEqual(publication.payload, { value: 1 })
    const asks = started.value.process.server.traffic.asks({ signal: AbortSignal.timeout(1_000) })
    const question = (await asks.next()).value
    await asks.return()
    assert.equal(question.event, "trace")
    assert.equal(question.questionId, "question-identity")
    assert.equal(question.message.to, started.value.process.server)
    assert.deepEqual(question.message.payload, { value: 2 })
    const answers = started.value.process.server.traffic.answers({ signal: AbortSignal.timeout(1_000) })
    const answer = (await answers.next()).value
    await answers.return()
    assert.equal(answer.event, "trace")
    assert.equal(answer.questionId, "question-identity")
    assert.equal(answer.message.to, started.value.process.client)
    assert.deepEqual(answer.message.outcome, { success: true, value: 3 })
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

    const exactProgramRequests = requests.filter(value =>
      value.target === "api" && value.request.capability === "program"
    )
    const exactProcessRequests = requests.filter(value =>
      value.target === "api" && value.request.capability === "programProcess"
    )
    assert(exactProgramRequests.every(value => value.request.handle?.reference === program.reference))
    assert(exactProcessRequests.every(value => value.request.handle?.reference === program.reference))

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

function programApiResult(request, home) {
  if (request.operation === "storagePath") return join(home, request.area)
  if (request.operation === "agent") return "Program agent"
  if (request.operation === "wait") return request.event === "uninstall" ? true : undefined
  if (request.operation === "icon") return [137, 80, 78, 71]
  if (request.operation === "store" && request.storeOperation === "get") return "stored"
  if (request.operation === "query") return [{ value: 1 }]
  if (request.operation === "permissions" && request.permissionOperation === "get") return ["read"]
  if (request.operation === "permissions" && request.permissionOperation === "all") return { files: ["read"] }
  if (request.operation === "permissions" && request.permissionOperation === "set") return { permission: ["read"], needReload: false }
  if (request.operation === "permissions" && request.permissionOperation === "delete") return { permission: null, needReload: false }
  return true
}
