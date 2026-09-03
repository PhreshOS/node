import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { System, gatewayAddress } from "../dist/main.js"

test("System.shell preserves events and binds the gateway stream to its iterator", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-shell-"))
  const address = gatewayAddress(home)
  let cancelled
  const cancellation = new Promise(resolve => { cancelled = resolve })
  const server = createServer(socket => {
    let buffer = ""

    socket.on("data", chunk => {
      buffer += String(chunk)

      const boundary = buffer.indexOf("\n")
      if (boundary < 0) return

      const envelope = JSON.parse(buffer.slice(0, boundary))

      assert.equal(envelope.target, "shell")

      if (envelope.request.command === "complete") {
        assert.deepEqual(envelope.request.options, { cwd: "/work", env: { EXAMPLE: "value" } })
        socket.end([
          { event: "started", pid: 42 },
          { event: "output", stream: "stdout", text: "hello" },
          { event: "exited", exit: { status: "exited", code: 0, signal: null } }
        ].map(event => JSON.stringify(event)).join("\n") + "\n")
      }
      else {
        socket.write(`${JSON.stringify({ event: "started", pid: 43 })}\n`)
        socket.once("close", cancelled)
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
    const events = []

    for await (const event of system.shell("complete", { cwd: "/work", env: { EXAMPLE: "value" } })) events.push(event)

    assert.deepEqual(events, [
      { event: "started", pid: 42 },
      { event: "output", stream: "stdout", text: "hello" },
      { event: "exited", exit: { status: "exited", code: 0, signal: null } }
    ])

    const running = system.shell("running")

    assert.deepEqual(await running.next(), { done: false, value: { event: "started", pid: 43 } })

    await running.return(undefined)
    await cancellation
  }
  finally {
    await system.disconnect()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})
