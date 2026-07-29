import { createServer } from "node:net";

export async function resolveInternalApiPort(value: string | undefined): Promise<number> {
  const configuredPort = Number(value);
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535) {
    return configuredPort;
  }

  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate an internal API port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
