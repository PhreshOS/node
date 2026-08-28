import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Gateway, Project, gatewayAddress, resolveHome } from "../dist/main.js"

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

test("Gateway exposes the shared System contract over one owner-local address", async () => {
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

  const gateway = await Gateway.open(home)
  try {
    assert.equal(gateway.home, await realpath(home))
    assert.deepEqual(await gateway.system.appearance.snapshot(), { background: { light: "#fff" } })
  } finally {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})
