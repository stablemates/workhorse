const agentEntryPoint = "/docs/for-ai-agents";

export const agentEntryPointHopBound = 3;

export interface CrawlSurface {
  readonly body: string;
  readonly name: string;
  readonly url: URL;
}

export type CrawlPage = (url: URL) => Promise<string | null>;

function pagePath(url: URL): string {
  const path = url.pathname.replace(/\.md$/, "").replace(/\/$/, "");
  return path === "" ? "/" : path;
}

function linksIn(body: string, base: URL, siteOrigin: string): URL[] {
  const links = new Map<string, URL>();
  const add = (value: string): void => {
    const decoded = value.replaceAll("&amp;", "&").replace(/[\])},.;]+$/, "");
    try {
      const url = new URL(decoded, base);
      url.hash = "";
      if (url.origin === siteOrigin) links.set(url.href, url);
    } catch {
      // A malformed link cannot form part of a reachable path.
    }
  };

  for (const match of body.matchAll(/\bhref=["']([^"']+)["']/gi)) add(match[1]!);
  for (const match of body.matchAll(/\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) add(match[1]!);
  for (const match of body.matchAll(/https?:\/\/[^\s<>"']+/g)) add(match[0]);

  return [...links.values()];
}

async function canReach(
  surface: CrawlSurface,
  loadPage: CrawlPage,
  siteOrigin: string,
  maxHops: number,
): Promise<boolean> {
  let frontier = [{ body: surface.body, hops: 0, url: surface.url }];
  const visited = new Set<string>([surface.url.href]);

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const page of frontier) {
      if (pagePath(page.url) === agentEntryPoint) return true;
      if (page.hops === maxHops) continue;

      for (const url of linksIn(page.body, page.url, siteOrigin)) {
        if (visited.has(url.href)) continue;
        visited.add(url.href);
        const body = await loadPage(url);
        if (body !== null) next.push({ body, hops: page.hops + 1, url });
      }
    }
    frontier = next;
  }

  return false;
}

/**
 * Prove that every place an agent can land leads to the one integration page.
 * The loader owns the network boundary, so the smoke test can map public site
 * URLs onto its local preview while unit tests keep the crawl in memory.
 */
export async function assertAgentEntryPointReachable(
  surfaces: readonly CrawlSurface[],
  loadPage: CrawlPage,
  siteOrigin: string,
  maxHops = agentEntryPointHopBound,
): Promise<void> {
  const unreachable: string[] = [];
  for (const surface of surfaces) {
    if (!(await canReach(surface, loadPage, siteOrigin, maxHops))) unreachable.push(surface.name);
  }

  if (unreachable.length > 0) {
    throw new Error(
      `The agent entry point ${agentEntryPoint} was not reachable within ${maxHops} hops from ${unreachable.join(
        ", ",
      )}`,
    );
  }
}
