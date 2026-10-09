import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { defaultAppearance } from "@phreshos/core"
import { System, gatewayAddress } from "../dist/main.js"
import { createGateway } from "./gateway-fixture.mjs"

test("a default's change reaches the owner with the type and the Program, or null", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-opening-"))
  const program = {
    reference: "program-reference", identity: "preview", assetId: "preview-assets",
    installed: true, name: "Preview", version: "0.0.0", description: null, hasAgent: false,
    permissions: {}, startup: false, server: null, client: null, opens: ["image/*"]
  }
  const defaults = {}
  const gateway = createGateway(gatewayAddress(home), {
    snapshot: {
      linkManager: { appearance: { key: "appearance", value: defaultAppearance } },
      authManager: { programManager: { programs: [["preview", program]] }, processManager: { processes: [] } }
    },
    async route({ event, values, publish }) {
      const [type, identity] = values
      if (event === "/auth/opening/defaults") return Object.fromEntries(Object.entries(defaults).map(([kept]) => [kept, program]))
      if (event === "/auth/opening/set-default") {
        defaults[type] = identity
        await publish("/auth/opening/default-change", type, program)
        return
      }
      if (event === "/auth/opening/clear-default") {
        delete defaults[type]
        await publish("/auth/opening/default-change", type, null)
        return
      }
      throw new Error("Unexpected route: " + event)
    }
  })
  await gateway.listen()
  const system = await System.connect(home)
  try {
    const preview = await system.program.find("preview")
    assert(preview)

    const set = system.opening.wait("changeDefault", 1000)
    await system.opening.setDefault("image/*", preview)
    assert.deepEqual(await set, { type: "image/*", program: preview })
    assert.deepEqual(await system.opening.defaults(), { "image/*": preview })

    const cleared = system.opening.wait("changeDefault", 1000)
    await system.opening.clearDefault("image/*")
    assert.deepEqual(await cleared, { type: "image/*", program: null })
  } finally {
    await system.disconnect()
    await gateway.close()
    await rm(home, { recursive: true, force: true })
  }
})
