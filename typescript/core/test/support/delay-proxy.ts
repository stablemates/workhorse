import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";

// The type byte of a password, SASL initial response, or SASL response message.
const PASSWORD_MESSAGE = "p".charCodeAt(0);

/**
 * A TCP proxy in front of PostgreSQL that holds each chunk from the client for `delayMs` before it
 * sends the chunk to the server, in the order the chunks arrived. Answers from the server go back
 * at once. So each round trip of every connection through the proxy takes at least `delayMs`, and
 * PostgreSQL sees an idle gap of `delayMs` before each statement.
 *
 * The delay applies to statements, not to the connect. The startup message and the password
 * messages (type `p`) of a new connection go through at once. The first other message turns the
 * delay on for the rest of the connection, so no chunk can pass a held chunk.
 *
 * `url` is `databaseUrl` with the host and port of the proxy.
 */
export async function startDelayProxy(
  databaseUrl: string,
  delayMs: number,
): Promise<{ url: string; close(): Promise<void> }> {
  const target = new URL(databaseUrl);
  const targetHost = target.hostname || "localhost";
  const targetPort = Number(target.port || 5432);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    const end = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    let startup = true;
    let delaying = false;
    // Timers with the same delay fire in the order they were set, so the chunks keep their order.
    client.on("data", (chunk: Buffer) => {
      const connecting = startup || chunk[0] === PASSWORD_MESSAGE;
      startup = false;
      if (!delaying && connecting) {
        upstream.write(chunk);
        return;
      }
      delaying = true;
      setTimeout(() => {
        if (!upstream.destroyed) upstream.write(chunk);
      }, delayMs);
    });
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const proxied = new URL(databaseUrl);
  proxied.hostname = "127.0.0.1";
  proxied.port = String((server.address() as AddressInfo).port);
  return {
    url: proxied.toString(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
