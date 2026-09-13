import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { defaultAppearance } from "@phreshos/core"
import { System, gatewayAddress } from "../dist/main.js"
import { createGateway } from "./gateway-fixture.mjs"

test("saved launch get and set cross the owner boundary without launching", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-launch-"))
  const program = { reference: "reference", identity: "example", assetId: "assets", installed: false,
    name: "Example", version: null, description: null, hasAgent: false, server: null,
    client: { start: true, service: false, title: null, position: null, size: null, layer: null, minimize: null, maximize: null } }
  let saved = null
  const gateway = createGateway(gatewayAddress(home), {
    session: { authorization: "owner", linkManager: { appearance: { key: "appearance", value: defaultAppearance } },
      authManager: { programManager: { programs: [["example", program]] }, processManager: { processes: [] } } },
    async route({ event, values }) {
      assert.equal(event, "/auth/program/launch")
      const [authorization, address, operation, value] = values
      assert.equal(authorization, "owner")
      assert.deepEqual(address, { identity: "example", reference: "reference" })
      if (operation === "get") return saved
      assert.equal(operation, "set")
      saved = value
    }
  })
  await gateway.listen()
  const system = await System.connect(home)
  try {
    const current = await system.program.find("example")
    assert.equal(await current.launch.get(), null)
    await current.launch.set({ options: { document: "icon.txt" } })
    assert.deepEqual(await current.launch.get(), { options: { document: "icon.txt" } })
    await assert.rejects(current.launch.set(true))
    saved = false
    await assert.rejects(current.launch.get())
  } finally {
    await system.disconnect()
    await gateway.close()
    await rm(home, { recursive: true, force: true })
  }
})
