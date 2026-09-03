import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { System, gatewayAddress } from "../dist/main.js"
import { createGateway } from "./gateway-fixture.mjs"

test("System.shell executes locally and belongs to its System connection", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-shell-"))
  const address = gatewayAddress(home)
  let connections = 0
  let ownerConnection
  const server = createGateway(address, {
    connected(peer) {
      connections += 1
      ownerConnection = peer
    }
  })
  const http = createHttpServer(() => undefined)

  await mkdir(home, { recursive: true })
  await server.listen()
  await new Promise((resolve, reject) => {
    http.once("error", reject)
    http.listen(0, "127.0.0.1", resolve)
  })

  const system = await System.connect(home)

  try {
    const script = "process.stdout.write(process.cwd() + ':' + process.env.PHRESHOS_SHELL_TEST); process.stderr.write('stderr')"
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
    const events = []

    for await (const event of system.shell(command, { cwd: home, env: { PHRESHOS_SHELL_TEST: "local" } })) events.push(event)

    assert.equal(events[0].event, "started")
    assert.equal(events.at(-1).event, "exited")
    assert.deepEqual(events.at(-1).exit, { status: "exited", code: 0, signal: null })
    assert.equal(events.filter(event => event.event === "output" && event.stream === "stdout").map(event => event.text).join(""), `${await realpath(home)}:local`)
    assert.equal(events.filter(event => event.event === "output" && event.stream === "stderr").map(event => event.text).join(""), "stderr")
    assert.equal(connections, 1)

    const running = system.shell(`${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1_000)")}`)
    assert.equal((await running.next()).value.event, "started")
    const waiting = running.next()
    const httpAddress = http.address()
    assert.equal(typeof httpAddress, "object")
    const fetching = system.fetch(`http://127.0.0.1:${httpAddress.port}/`)
    const shellClosed = assert.rejects(waiting, /System connection is closed/)
    const fetchClosed = assert.rejects(fetching, /System connection is closed/)

    await ownerConnection.disconnect()
    await shellClosed
    await fetchClosed
    await assert.rejects(system.storage.path(), /System connection is closed/)
    await assert.rejects(system.uploads.path(), /System connection is closed/)
    assert.equal(connections, 1)
  } finally {
    await system.disconnect()
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})
