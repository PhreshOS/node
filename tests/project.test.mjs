import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { Project } from "../dist/main.js"

test("Project installation forwards the shared installation decisions and output", async () => {
  const decisions = { launch: { name: "main", replace: true }, purge: true }
  const project = Project.define({ identity: "install-example", client: { location: "client" } })
  const system = {
    program: {
      async forceCreate(definition) {
        assert.equal(definition.identity, "install-example")
        return {
          async *install(options) {
            assert.deepEqual(options, decisions)
            yield { stream: "stdout", text: "installed" }
          }
        }
      }
    }
  }
  const stream = await project.install(system, decisions)
  assert.deepEqual(await Array.fromAsync(stream), [{ stream: "stdout", text: "installed" }])
})

test("a Client development command receives its assigned address", async context => {
  const directory = await mkdtemp(join(tmpdir(), "phresh-project-"))
  const observation = join(directory, "development.json")

  context.onTestFinished(() => rm(directory, { force: true, recursive: true }))

  await writeFile(join(directory, "client.mjs"), `
    import { writeFile } from "node:fs/promises"
    import { createServer } from "node:http"

    const port = Number(process.env.PHRESHOS_CLIENT_PORT)
    const base = process.env.PHRESHOS_CLIENT_BASE

    await writeFile(${JSON.stringify(observation)}, JSON.stringify({ port, base }))

    createServer((request, response) => {
      response.statusCode = request.url?.startsWith(base) ? 200 : 404
      response.end()
    }).listen(port)
  `)

  let definition
  const process = { identity: "development-process" }
  const assetId = "00000000-0000-4000-8000-000000000000"
  const system = {
    program: {
      async forceCreate(value) {
        definition = value
        return {
          assetId,
          async *runProcess() {
            yield { event: "started", process }
            yield { event: "exited", process, exit: { status: "exited", code: 0, signal: null } }
          }
        }
      }
    }
  }

  const project = Project.define({
    identity: "development-program",
    installLaunch: true,
    client: {
      location: "dist/client",
      devCommand: "node client.mjs"
    }
  }, { directory })

  const events = []
  const lifecycle = await project.dev(system)

  await assert.rejects(readFile(observation, "utf8"), { code: "ENOENT" })

  for await (const event of lifecycle) events.push(event.event)

  const environment = JSON.parse(await readFile(observation, "utf8"))

  assert.deepEqual(events, ["started", "exited"])
  assert.equal(environment.base, `/program/${assetId}/assets/`)
  assert.equal(Number.isInteger(environment.port), true)
  assert.equal(definition.client.location, `http://localhost:${environment.port}/`)
  assert.equal(definition.installLaunch, true)
  await assert.rejects(fetch(definition.client.location))
})

test("authoring defaults survive production, development, and packaging", async context => {
  const directory = await mkdtemp(join(tmpdir(), "phresh-project-defaults-"))
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }))
  await mkdir(join(directory, "client"))
  await writeFile(join(directory, "client", "index.html"), "<!doctype html>")
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }))
  const defaults = {
    installLaunch: { options: { document: "welcome.txt" } }
  }
  const clientDefaults = {
    sandbox: false,
    surface: {
      radius: "full",
      color: "primary",
      material: { opacity: 0.7 }
    },
    transaction: { duration: 240, easing: "ease-out" }
  }
  const project = Project.define({
    identity: "example",
    ...defaults,
    client: {
      location: "client",
      devUrl: "http://localhost:5200",
      ...clientDefaults
    }
  }, { directory })
  for (const definition of [project.productionDefinition(), project.developmentDefinition()]) {
    assert.deepEqual(definition.installLaunch, defaults.installLaunch)
    assert.equal(definition.client.sandbox, false)
    assert.deepEqual(definition.client.surface, clientDefaults.surface)
    assert.deepEqual(definition.client.transaction, clientDefaults.transaction)
  }
  const packed = await project.pack()
  const definition = JSON.parse(await readFile(packed.declarationPath, "utf8"))
  assert.deepEqual(definition.installLaunch, defaults.installLaunch)
  assert.equal(definition.client.sandbox, false)
  assert.deepEqual(definition.client.surface, clientDefaults.surface)
  assert.deepEqual(definition.client.transaction, clientDefaults.transaction)
  assert.equal(definition.storage, undefined)
  assert.equal(definition.client.devCommand, undefined)
  assert.equal(definition.client.devUrl, undefined)
})

test("authoring validates consumed install launch values and ignores additional properties", () => {
  const config = { identity: "example", client: { location: "client" } }
  assert.deepEqual(Project.define({ ...config, installLaunch: { client: { extension: true } } }).productionDefinition().installLaunch, { client: {} })
  assert.throws(() => Project.define({ ...config, installLaunch: null }), /object/)
  assert.throws(() => Project.define({ ...config, installLaunch: false }), /object/)
  assert.throws(() => Project.define({ ...config, client: { ...config.client, surface: { radius: -1 } } }), /surface/i)
  assert.throws(() => Project.define({ ...config, client: { ...config.client, transaction: -1 } }), /transaction/i)
})

test("authoring preserves optional post-install launch decisions", () => {
  for (const value of [undefined, true]) {
    const project = Project.define({
      identity: "example", installLaunch: value,
      client: { location: "client", devUrl: "http://localhost:5200" }
    })
    for (const definition of [project.productionDefinition(), project.developmentDefinition()]) {
      assert.equal(definition.installLaunch, value)
    }
  }
})

test("a development definition uses the direct-run Client port by default", () => {
  const project = Project.define({
    identity: "default-development-port",
    client: {
      location: "dist/client",
      devCommand: "vite"
    }
  })

  assert.equal(project.developmentDefinition().client.location, "http://localhost:5200/")
})
