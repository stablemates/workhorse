import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./packages.js";

// The compression and cache policy of the site origin (SM-1673), read from site/nginx.conf.
// `pnpm test:site-nginx` serves the built site through nginx and checks the headers it sends, but
// it needs an nginx binary and runs in neither CI nor `pnpm check`. This test reads the file, so CI
// keeps the policy that typescript/demo/DEPLOYMENT.md states.
const baseline = [
  "add_header X-Content-Type-Options nosniff always;",
  `add_header Content-Security-Policy "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" always;`,
  "add_header Referrer-Policy strict-origin-when-cross-origin always;",
];

/** The body of each `location` block, keyed by its match, without comments. */
function locations(config: string): Map<string, string> {
  const source = config.replace(/#.*$/gm, "");
  const blocks = new Map<string, string>();
  for (const match of source.matchAll(/^\s*location\s+([^{]+?)\s*\{/gm)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.set(match[1]!, source.slice(start, index - 1));
  }
  return blocks;
}

function directives(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

describe("site/nginx.conf", async () => {
  const config = await readFile(path.join(repositoryRoot, "site/nginx.conf"), "utf8");
  const blocks = locations(config);
  const block = (match: string) => {
    const body = blocks.get(match);
    if (body === undefined) throw new Error(`site/nginx.conf has no location ${match}`);
    return directives(body);
  };

  it("compresses the text responses and varies them by Accept-Encoding", () => {
    const top = directives(config.replace(/#.*$/gm, "").split(/^server\s*\{/m)[0]!);
    expect(top).toContain("gzip on;");
    expect(top).toContain("gzip_vary on;");
    const types = top
      .find((line) => line.startsWith("gzip_types "))
      ?.slice(11, -1)
      .split(" ");
    // nginx always compresses text/html when gzip is on, so the list names the other types.
    expect(types).toEqual(
      expect.arrayContaining([
        "text/markdown",
        "text/css",
        "application/javascript",
        "application/json",
        "image/svg+xml",
      ]),
    );
  });

  it("makes the content-hashed assets immutable for one year, without Vary", () => {
    const assets = block("^~ /assets/");
    expect(assets).toContain('add_header Cache-Control "public, max-age=31536000, immutable";');
    expect(assets.filter((line) => /^(expires|add_header Vary)\b/.test(line))).toEqual([]);
  });

  it("caches an image for one hour and does not vary it by Accept", () => {
    const images = block("~* \\.(png|svg|ico|jpe?g|webp|avif|gif)$");
    expect(images).toContain('add_header Cache-Control "public, max-age=3600";');
    expect(images.filter((line) => line.startsWith("add_header Vary"))).toEqual([]);
  });

  it("revalidates the pages and the Markdown twins, and keeps their negotiation headers", () => {
    const pages = block("/");
    expect(pages).toContain("add_header Cache-Control no-cache;");
    expect(pages).toContain("add_header Vary Accept always;");
    expect(block("~ ^/(.+\\.md|llms\\.txt|llms-full\\.txt)$")).toContain(
      "add_header Cache-Control no-cache;",
    );
    expect(block("~ \\.(html|md|txt|xml|json)$")).toContain("add_header Cache-Control no-cache;");
    expect(block("/api/")).toContain("add_header Cache-Control no-cache;");
    expect(block("@unavailable")).toContain("add_header Cache-Control no-store always;");
  });

  it("caches a redirect for one hour, and nothing that nginx sends before a location", () => {
    const server = config.replace(/#.*$/gm, "").split(/^server\s*\{/m)[1]!;
    const serverLevel = directives(server.split(/^\s*location\b/m)[0]!);
    expect(serverLevel.filter((line) => line.startsWith("add_header Cache-Control"))).toEqual([]);
    const redirects = [...blocks].filter(([, body]) => /^\s*return 301\b/m.test(body));
    expect(redirects.map(([match]) => match)).toEqual([
      "= /favicon.ico",
      "~ ^(/.+)/$",
      "= /docs/job-dependencies",
      "= /docs/child-jobs",
    ]);
    for (const [, body] of redirects) {
      expect(directives(body)).toContain('add_header Cache-Control "public, max-age=3600" always;');
    }
  });

  it("repeats the security headers in each location that adds a header", () => {
    const missing = [...blocks]
      .filter(([, body]) => body.includes("add_header"))
      .flatMap(([match, body]) =>
        baseline
          .filter((line) => !directives(body).includes(line))
          .map((line) => `${match}: ${line}`),
      );
    expect(blocks.size).toBeGreaterThan(8);
    expect(missing).toEqual([]);
  });
});
