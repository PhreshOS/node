import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { defaultAppearance } from "@phreshos/core"
import { System, gatewayAddress } from "../dist/main.js"
import { createGateway } from "./gateway-fixture.mjs"

test("Window flags and geometry cross the owner boundary independently", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-window-"))
  const program = {
    reference: "program-reference", identity: "example", assetId: "example-assets",
    installed: false, name: "Example", version: "0.0.0", description: null, hasAgent: false,
    server: null,
    client: { start: true, service: false, title: null, header: null, frame: null, transaction: null, position: null, size: null, layer: null, minimize: null, maximize: null }
  }
  const window = {
    title: "Example", header: true, frame: true, transaction: false, position: { x: 20, y: 30 }, size: { width: 320, height: 240 },
    layer: "window", depth: 1, minimized: false, maximized: false
  }
  const process = {
    reference: "process-reference", identity: "process", name: "main", program: "example",
    parent: null, options: {}, startedAt: new Date(), serverEndpoint: false, server: null,
    client: null, clientEndpoint: { window }
  }
  const gateway = createGateway(gatewayAddress(home), {
    snapshot: {
      linkManager: { appearance: { key: "appearance", value: defaultAppearance } },
      authManager: {
        programManager: { programs: [["example", program]] },
        processManager: { processes: [["process", process]] }
      }
    },
    async route({ event, values, publish }) {
      const [identity, input] = values
      assert.equal(identity, "process")
      const operation = event.split("/").at(-1)
      if (operation === "maximize") window.maximized = input
      else if (operation === "minimize") window.minimized = input
      else if (operation === "set-geometry") {
        window.position = { x: input.x, y: input.y }
        window.size = { width: input.width, height: input.height }
      }
      else if (operation === "set-header") window.header = input
      else throw new Error("Unexpected Window operation: " + operation)
      const changed = { identity, window: { ...window } }
      if (operation === "set-geometry") {
        await publish("/auth/process/move", changed)
        await publish("/auth/process/resize", changed)
      } else if (operation === "set-header") await publish("/auth/process/change-header", changed)
      else await publish("/auth/process/" + operation, changed)
      return changed
    }
  })
  await gateway.listen()
  const system = await System.connect(home)
  try {
    const owner = await system.process.find("process")
    assert(owner)
    assert.equal(await owner.client.running(), false)
    assert.equal(await owner.client.process(), owner)

    const current = owner.client.window
    const maximized = current.wait("maximize", 1000)
    await current.maximize()
    assert.equal(await maximized, true)
    assert.equal(await current.maximized(), true)
    await current.minimize()
    assert.equal(await current.minimized(), true)
    assert.equal(await current.maximized(), true)
    const header = current.wait("changeHeader", 1000)
    await current.setHeader(false)
    assert.equal(await header, false)
    assert.equal(await current.header(), false)

    const geometry = { x: 70, y: 80, width: 700, height: 500 }
    const moved = current.wait("move", 1000)
    const resized = current.wait("resize", 1000)
    await current.setGeometry(geometry)
    assert.deepEqual(await moved, { x: geometry.x, y: geometry.y })
    assert.deepEqual(await resized, { width: geometry.width, height: geometry.height })
    assert.equal(await current.minimized(), true)
    assert.equal(await current.maximized(), true)
    await current.minimize(false)
    assert.equal(await current.maximized(), true)
    await current.maximize(false)
    assert.equal(await current.maximized(), false)
    assert.deepEqual(await current.position(), { x: geometry.x, y: geometry.y })
    assert.deepEqual(await current.size(), { width: geometry.width, height: geometry.height })
  } finally {
    await system.disconnect()
    await gateway.close()
    await rm(home, { recursive: true, force: true })
  }
})
