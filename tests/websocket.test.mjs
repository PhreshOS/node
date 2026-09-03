import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { System, gatewayAddress } from "../dist/main.js"
import { createGateway } from "./gateway-fixture.mjs"

test("System.websocket returns a native socket owned by its System connection", async () => {
  const home = await mkdtemp(join(tmpdir(), "phresh-websocket-"))
  const address = gatewayAddress(home)
  let ownerConnection
  const gateway = createGateway(address, {
    connected(peer) { ownerConnection = peer }
  })
  const peers = new Set()
  const websocketServer = createServer()

  websocketServer.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"]
    assert.equal(typeof key, "string")

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64")

    peers.add(socket)
    socket.once("close", () => peers.delete(socket))
    socket.on("data", () => socket.end())
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"))
  })

  await mkdir(home, { recursive: true })
  await gateway.listen()
  await new Promise((resolve, reject) => {
    websocketServer.once("error", reject)
    websocketServer.listen(0, "127.0.0.1", resolve)
  })

  const system = await System.connect(home)

  try {
    const listening = websocketServer.address()
    assert.equal(typeof listening, "object")

    const socket = await system.websocket(`ws://127.0.0.1:${listening.port}`)
    assert(socket instanceof WebSocket)
    await opened(socket)
    assert.equal(socket.readyState, WebSocket.OPEN)

    const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }))
    await ownerConnection.disconnect()
    await closed
    assert.equal(socket.readyState, WebSocket.CLOSED)
  } finally {
    await system.disconnect()
    for (const peer of peers) peer.destroy()
    await new Promise(resolve => websocketServer.close(resolve))
    await gateway.close()
    await rm(home, { recursive: true, force: true })
  }
})

function opened(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", open)
      socket.removeEventListener("error", error)
    }
    const open = value => {
      cleanup()
      resolve(value)
    }
    const error = value => {
      cleanup()
      reject(value)
    }

    socket.addEventListener("open", open, { once: true })
    socket.addEventListener("error", error, { once: true })
  })
}
