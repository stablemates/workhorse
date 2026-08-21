import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { WORKHORSE_VERSION } from "../src/version.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const port = 32_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;

function assertIncludesTokens(body: string, page: string, tokens: readonly string[]): void {
  for (const token of tokens) {
    if (!body.includes(token)) throw new Error(`${page} omitted SEO token ${token}`);
  }
}

const site = spawn("pnpm", ["--filter", "@workhorse/site", "start"], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
  },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
for (const stream of [site.stdout!, site.stderr!]) {
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (site.exitCode !== null) throw new Error(`Documentation site exited early\n${output}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The static preview server can refuse connections briefly while it starts.
    }
    await sleep(50);
  }
  if (!ready) throw new Error(`Timed out waiting for documentation site\n${output}`);

  // `/` is the landing page; every documentation destination lives in the
  // docs sidebar.
  const expectations = [
    ["/", ["Workhorse", "Postgres", "quickstart"]],
    ["/docs", ["Workhorse", "PostgreSQL"]],
    ["/docs/api", ["API overview", `Workhorse version ${WORKHORSE_VERSION}`]],
    ["/docs/quickstart", ["quickstart", "worker"]],
    ["/docs/retries", ["retry", "backoff"]],
    ["/robots.txt", ["Sitemap"]],
    ["/sitemap.xml", ["<urlset"]],
  ] as const;

  const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
  if (root.status !== 200 && !(root.status >= 300 && root.status < 400)) {
    throw new Error(`The site root returned ${root.status}`);
  }

  for (const [path, tokens] of expectations) {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`${path} returned ${response.status}\n${body}`);
    for (const token of tokens) {
      if (!body.toLowerCase().includes(token.toLowerCase())) {
        throw new Error(`${path} omitted required token ${token}`);
      }
    }
  }

  const landingHtml = await (await fetch(`${baseUrl}/`)).text();
  assertIncludesTokens(landingHtml, "The landing page", [
    '<link rel="canonical" href="https://workhorse.run"',
    'property="og:image" content="https://workhorse.run/brand/workhorse-mark.png"',
    'type="application/ld+json"',
    '"@type":"SoftwareApplication"',
  ]);

  const quickstartHtml = await (await fetch(`${baseUrl}/docs/quickstart`)).text();
  assertIncludesTokens(quickstartHtml, "The quickstart page", [
    '<link rel="canonical" href="https://workhorse.run/docs/quickstart"',
    '<link rel="alternate" type="text/markdown" href="https://workhorse.run/docs/quickstart.md"',
    'name="twitter:title" content="Quickstart — Workhorse"',
    '"@type":"TechArticle"',
  ]);

  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  if (!sitemap.includes("<loc>https://workhorse.run/</loc>")) {
    throw new Error("The sitemap omitted the landing page");
  }
  if (sitemap.includes("<lastmod>")) {
    throw new Error("The sitemap claims a modification date that the source does not track");
  }

  // Static search ships one prerendered index that the browser downloads and
  // queries locally, so the smoke test checks the index rather than a query.
  const search = await fetch(`${baseUrl}/api/search`);
  const searchBody = await search.text();
  if (!search.ok) {
    throw new Error(`Documentation search index was unavailable: ${search.status}`);
  }
  if (!searchBody.toLowerCase().includes("checkpoint")) {
    throw new Error("Documentation search index omitted the checkpoint content");
  }

  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({
      message: "Documentation site smoke passed",
      root: true,
      docs: true,
      search: true,
      discovery: true,
    })}`,
  );
} finally {
  if (site.pid && site.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => site.once("exit", () => resolveExit()));
    if (process.platform === "win32") site.kill("SIGTERM");
    else process.kill(-site.pid, "SIGTERM");
    await Promise.race([
      exited,
      sleep(2_000).then(() => {
        if (site.pid && site.exitCode === null) {
          if (process.platform === "win32") site.kill("SIGKILL");
          else process.kill(-site.pid, "SIGKILL");
        }
      }),
    ]);
  }
}
