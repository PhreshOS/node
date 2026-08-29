import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Project, System, gatewayAddress, resolveHome } from "../dist/main.js"

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

  assert.deepEqual(project.description("production").server, {
    location: join(directory, "dist", "server"),
    start: undefined,
    installCommand: undefined,
    uninstallCommand: undefined,
    entryFile: "main.js"
  })
  assert.deepEqual(project.description("development").server, {
    location: directory,
    start: undefined,
    installCommand: undefined,
    uninstallCommand: undefined,
    startCommand: "tsx source/server/main.ts"
  })
})

test("Project composes production from force-create and one attached Process run", async () => {
  const directory = join(process.cwd(), "project")
  const project = Project.define({
    identity: "example",
    client: { location: "client" }
  }, { directory })
  const createdProcess = { identity: "process-identity" }
  const calls = []
  let forgotten = false
  const system = {
    async forceCreateProgram(description) {
      calls.push({ operation: "forceCreateProgram", description })
      return {
        process: {
          async *run(launch, options) {
            calls.push({ operation: "run", launch, signal: options.signal })
            yield { event: "started", process: createdProcess }
            yield { event: "exited", process: createdProcess, exit: { status: "exited", code: 0, signal: null } }
          }
        },
        async forget() { forgotten = true }
      }
    }
  }

  const result = await project.start(system, { options: { mode: "test" } })

  assert.equal(result.process, createdProcess)
  assert.equal(result.exit.code, 0)
  assert.equal(forgotten, true)
  assert.equal(calls[0].operation, "forceCreateProgram")
  assert.equal(calls[0].description.client.location, join(directory, "client"))
  assert.deepEqual(calls[1].launch, { options: { mode: "test" } })
  assert.equal(calls[1].signal.aborted, true)
})

test("Project keeps an HTTP development Client location as a runtime location", () => {
  const project = Project.define({
    identity: "web-client",
    client: {
      location: "dist/client",
      development: { url: "https://localhost.example/client/" }
    }
  })

  assert.equal(project.description("development").client.location, "https://localhost.example/client/")
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
    assert.equal(system.home, await realpath(home))
    assert.deepEqual(await system.appearance.snapshot(), { background: { light: "#fff" } })
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
  const process = {
    identity: "process-identity",
    name: null,
    program: program.identity,
    programSnapshot: program,
    startedAt: new Date().toISOString(),
    server: { declared: true, running: true },
    client: { declared: false, running: false }
  }

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
        socket.end(`${JSON.stringify({ event: "created", program })}\n`)
      } else if (envelope.request.word === "run-process") {
        running = true
        socket.write(`${JSON.stringify({ event: "started", process })}\n`)
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
    const controller = new AbortController()
    const iterator = created.process.run({ options: { mode: "test" } }, { signal: controller.signal })
    const started = await iterator.next()

    assert.equal(started.value.event, "started")
    assert.equal(started.value.process.identity, process.identity)

    controller.abort(new Error("cancelled by test"))
    await assert.rejects(iterator.next(), /cancelled by test/)
    await runClosed

    const run = requests.find(value => value.request.word === "run-process").request
    assert.deepEqual(run.handle, { identity: "example", reference: "program-reference" })
    assert.deepEqual(run.launch, { options: { mode: "test" } })
  } finally {
    await system.disconnect()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})
