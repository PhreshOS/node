import { SocketServer } from "@the-link/ipc/socket-server"
import messagepack from "@the-link/messagepack"

const emptySession = {
  authorization: "owner",
  linkManager: { appearance: { key: "appearance", value: {} } },
  authManager: {
    programManager: { programs: [] },
    processManager: { processes: [] }
  }
}

/** A direct LinkManager boundary used by Node contract tests. */
export function createGateway(address, options = {}) {
  const server = new SocketServer(address)

  server.setSerialize(messagepack.serialize)
  server.setDeserialize(messagepack.deserialize)
  server.onConnection(peer => {
    const stop = peer.$inbound.forwardTo(async (event, ...values) => {
      const result = await options.route?.({
        event,
        values,
        publish: (name, ...payload) => peer.$outbound.publish(name, ...payload)
      })

      return result === undefined ? [] : [result]
    })

    peer.$internal.subscribeOnce("disconnect", stop)
    options.connected?.(peer)

    return peer.$outbound.publish("/gateway/ready", options.session ?? emptySession)
  })

  return server
}
