import { describe, expect, it } from "vitest";
import {
  agentEntryPointHopBound,
  assertAgentEntryPointReachable,
  crawlableBody,
  type CrawlSurface,
} from "./agent-entrypoint-crawl.js";

const site = "https://workhorse.run";
const router = `${site}/llms.txt`;
const entryPoint = `${site}/docs/for-ai-agents.md`;
const surfaceNames = [
  "site landing page",
  "robots.txt",
  "root README",
  "TypeScript README",
  "Python README",
  "Go README",
  "documentation page",
] as const;

function surfacesWithout(missing?: string): CrawlSurface[] {
  return surfaceNames.map((name, index) => ({
    name,
    url: new URL(name === "site landing page" ? "/" : `/surface-${index}`, site),
    body:
      name === missing
        ? "No agent documentation link"
        : name === "documentation page"
          ? `[Workhorse home](${site}/)`
          : `[Agent documentation](${router})`,
  }));
}

const pages = new Map([
  [`${site}/`, `[Agent documentation](${router})`],
  [router, `[Workhorse for AI coding agents](${entryPoint})`],
  [entryPoint, "# Workhorse for AI coding agents"],
]);

const loadPage = async (url: URL): Promise<string | null> => pages.get(url.href) ?? null;

describe("agent entry point crawl", () => {
  it("reaches the agent page from every landing surface within the hop bound", async () => {
    await expect(
      assertAgentEntryPointReachable(surfacesWithout(), loadPage, site, agentEntryPointHopBound),
    ).resolves.toBeUndefined();
  });

  it.each(surfaceNames)("names %s when its pointer is removed", async (name) => {
    await expect(
      assertAgentEntryPointReachable(surfacesWithout(name), loadPage, site),
    ).rejects.toThrow(name);
  });

  it("follows links only from successful text responses", async () => {
    const link = `[Agent documentation](${router})`;
    const response = (status: number, contentType: string) =>
      new Response(link, { status, headers: { "content-type": contentType } });

    await expect(crawlableBody(response(200, "text/html; charset=utf-8"))).resolves.toBe(link);
    await expect(crawlableBody(response(200, "text/markdown"))).resolves.toBe(link);
    await expect(crawlableBody(response(200, "image/png"))).resolves.toBeNull();
    await expect(crawlableBody(response(404, "text/html"))).resolves.toBeNull();
  });
});
