import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Project } from "../dist/main.js"

test("a Client development command receives its assigned address", async context => {
  const directory = await mkdtemp(join(tmpdir(), "phresh-project-"))
  const observation = join(directory, "development.json")

  context.after(() => rm(directory, { force: true, recursive: true }))

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
  const system = {
    async forceCreateProgram(value) {
      definition = value
      return {
        process: {
          async *run() {
            yield { event: "started", process }
            yield { event: "exited", process, exit: { status: "exited", code: 0, signal: null } }
          }
        }
      }
    }
  }

  const project = Project.define({
    identity: "development-program",
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
  assert.equal(environment.base, "/program/development-program/assets/")
  assert.equal(Number.isInteger(environment.port), true)
  assert.equal(definition.client.location, `http://localhost:${environment.port}/`)
  await assert.rejects(fetch(definition.client.location))
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
