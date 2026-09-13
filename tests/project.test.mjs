import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { Project } from "../dist/main.js"

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
          process: {
            async *run() {
              yield { event: "started", process }
              yield { event: "exited", process, exit: { status: "exited", code: 0, signal: null } }
            }
          }
        }
      }
    }
  }

  const project = Project.define({
    identity: "development-program",
    startup: true,
    options: { language: "en" },
    client: {
      location: "dist/client",
      development: { startCommand: "node client.mjs" }
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
  assert.equal(definition.startup, true)
  assert.deepEqual(definition.options, { language: "en" })
  await assert.rejects(fetch(definition.client.location))
})

test("authoring defaults survive production, development, and packaging", async context => {
  const directory = await mkdtemp(join(tmpdir(), "phresh-project-defaults-"))
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }))
  await mkdir(join(directory, "client"))
  await writeFile(join(directory, "client", "index.html"), "<!doctype html>")
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }))
  const defaults = {
    options: { document: "default.txt", language: "en" },
    startup: { options: { document: "welcome.txt" } },
    launch: { options: { document: "icon.txt" } }
  }
  const project = Project.define({
    identity: "example",
    ...defaults,
    client: { location: "client", development: { url: "http://localhost:5200" } }
  }, { directory })
  for (const definition of [project.productionDefinition(), project.developmentDefinition()]) {
    assert.deepEqual(definition.options, defaults.options)
    assert.deepEqual(definition.startup, defaults.startup)
    assert.deepEqual(definition.launch, defaults.launch)
  }
  const packed = await project.pack()
  const definition = JSON.parse(await readFile(packed.declarationPath, "utf8"))
  assert.deepEqual(definition.options, defaults.options)
  assert.deepEqual(definition.startup, defaults.startup)
  assert.deepEqual(definition.launch, defaults.launch)
  assert.equal(definition.storage, undefined)
  assert.equal(definition.client.development, undefined)
})

test("authoring rejects invalid default options and startup launches", () => {
  const config = { identity: "example", client: { location: "client" } }
  assert.throws(() => Project.define({ ...config, options: { count: 1 } }), /text values/)
  assert.throws(() => Project.define({ ...config, startup: { client: { location: "old" } } }), /unknown field/)
  assert.throws(() => Project.define({ ...config, launch: null }), /object/)
  assert.throws(() => Project.define({ ...config, launch: false }), /object/)
  assert.throws(() => Project.define({ ...config, startup: false }), /object/)
})

test("authoring preserves optional startup and icon launch decisions", () => {
  for (const value of [undefined, true]) {
    const project = Project.define({
      identity: "example", startup: value, launch: value,
      client: { location: "client", development: { url: "http://localhost:5200" } }
    })
    for (const definition of [project.productionDefinition(), project.developmentDefinition()]) {
      assert.equal(definition.startup, value)
      assert.equal(definition.launch, value)
    }
  }
})

test("a development definition uses the direct-run Client port by default", () => {
  const project = Project.define({
    identity: "default-development-port",
    client: {
      location: "dist/client",
      development: { startCommand: "vite" }
    }
  })

  assert.equal(project.developmentDefinition().client.location, "http://localhost:5200/")
})
