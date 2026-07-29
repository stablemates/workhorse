import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { resolveInternalApiPort } from "../scripts/development-port.js";

describe("development API port", () => {
  it("preserves an explicit valid port", async () => {
    await expect(resolveInternalApiPort("31415")).resolves.toBe(31_415);
  });

  it.each([undefined, "", "0", "-1", "invalid", "65536"])(
    "allocates an available port for %s",
    async (value) => {
      const port = await resolveInternalApiPort(value);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);

      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });
    },
  );
});
