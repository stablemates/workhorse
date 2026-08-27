import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const proxyRunConfiguration = `  run:
    http_port: 8080
    bind_ips:
      - 127.0.0.1`;

describe("public deployment ingress", () => {
  it.each(["config/deploy.yml", "config/deploy.site.yml"])(
    "keeps the Kamal proxy on host loopback in %s",
    async (path) => {
      const config = await readFile(path, "utf8");

      expect(config).toContain(proxyRunConfiguration);
      expect(config).not.toContain("ssl: true");
    },
  );

  it("runs the authenticated tunnel beside the shared proxy", async () => {
    const config = await readFile("config/deploy.site.yml", "utf8");

    expect(config).toContain("network: host");
    expect(config).toContain("cmd: tunnel --no-autoupdate run");
    expect(config).toContain("TUNNEL_TOKEN:WORKHORSE_CLOUDFLARE_TUNNEL_TOKEN");
  });
});
