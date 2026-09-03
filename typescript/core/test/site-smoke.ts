import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { WORKHORSE_VERSION } from "../src/version.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const port = 32_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;

function assertIncludesTokens(body: string, page: string, tokens: readonly string[]): void {
  for (const token of tokens) {
    if (!body.includes(token)) throw new Error(`${page} omitted required token ${token}`);
  }
}

const site = spawn("pnpm", ["--filter", "@stablemates/workhorse-site", "start"], {
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
    ["/", ["Workhorse", "Postgres", "quickstart", "derby", "G-9NC8FKZPVB"]],
    ["/docs", ["Workhorse", "PostgreSQL"]],
    ["/docs/api", ["API overview", `Workhorse version ${WORKHORSE_VERSION}`]],
    ["/docs/for-ai-agents", ["TypeScript", "Python", "Go"]],
    // The playbook's remedy for a non-restart-safe external effect is a
    // checkpoint. A rewrite that drops the word drops the one mistake a
    // recorded baseline session actually made.
    ["/docs/for-ai-agents.md", ["TypeScript", "Python", "Go", "checkpoint"]],
    ["/docs/integrations", ["Verified", "Documented", "Tested against drizzle-orm"]],
    ["/docs/integrations.md", ["ORMs and query builders", "Tested against drizzle-orm"]],
    ["/docs/quickstart", ["quickstart", "worker"]],
    ["/docs/releases", ["TypeScript", "Python", "Go", "current line"]],
    // The twin expands every language tab inline, so an agent that fetches it
    // sees the Python install the HTML hides behind a tab control.
    ["/docs/quickstart.md", ["**TypeScript**", "**Python**", "**Go**", "pip install"]],
    ["/docs/retries", ["retry", "backoff"]],
    ["/llms.txt", ["llms-full.txt", "/docs/quickstart.md"]],
    ["/llms-full.txt", ["https://workhorse.run/docs/quickstart", "Queue.enqueue"]],
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

  // `expectations` proves a page contains something. A twin has to prove the
  // opposite: that no MDX tag survived the transform. Sweep every page the
  // generator wrote rather than a sample, because one unexpanded page is one
  // agent reading markup where it expected code.
  const docsIndex = JSON.parse(
    await readFile(resolve(repositoryRoot, "site/.source/docs-index.json"), "utf8"),
  ) as { pages: Record<string, { url: string }> };
  const twinPaths = Object.values(docsIndex.pages).map((page) =>
    // `index` is served at `/docs`, so its twin is `/docs.md`.
    page.url === "/docs" ? "/docs.md" : `${page.url}.md`,
  );
  if (twinPaths.length === 0) throw new Error("The docs index listed no pages to sweep");

  const forbidden = [
    ...twinPaths.map((path) => [path, ["<Tab"]] as const),
    ["/llms-full.txt", ["<Tab"]] as const,
  ] as const;

  for (const [path, tokens] of forbidden) {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    for (const token of tokens) {
      if (body.includes(token)) throw new Error(`${path} still carries the MDX tag ${token}`);
    }
  }

  // Every documentation link in the playbook must reach a twin, because the page
  // is read by agents that cannot open a language tab. A link to the HTML page
  // costs the reader two of its three languages, so assert the suffix and then
  // prove each target actually resolves.
  const playbook = await (await fetch(`${baseUrl}/docs/for-ai-agents.md`)).text();
  const playbookLinks = [...playbook.matchAll(/\]\((\/docs\/[^)\s]+)\)/g)].map(
    (match) => match[1]!,
  );
  if (playbookLinks.length === 0) {
    throw new Error("The agent playbook carried no documentation links to check");
  }
  for (const link of playbookLinks) {
    if (!link.endsWith(".md")) {
      throw new Error(`The agent playbook links ${link}, which is not a Markdown twin`);
    }
    const linked = await fetch(`${baseUrl}${link}`);
    if (!linked.ok)
      throw new Error(`The agent playbook links ${link}, which returned ${linked.status}`);
  }

  // Expanding the tabs cost no size, because the twins already carried all three
  // languages and de-indenting the fences gave a little back. The bound catches a
  // generator that starts repeating content, not ordinary growth.
  const llmsFullText = await (await fetch(`${baseUrl}/llms-full.txt`)).text();
  const llmsFullBytes = Buffer.byteLength(llmsFullText, "utf8");
  if (llmsFullBytes > 320_000) {
    throw new Error(`llms-full.txt grew to ${llmsFullBytes} bytes, well past its 256 KB shape`);
  }

  // The router's lead is the prose above its first `##`. It has to name the
  // entry point, the `.md` rule, and the Installation page, and the size it
  // states for `llms-full.txt` has to be the size the file actually has, so a
  // generator that types the number instead of measuring it fails here.
  const llmsLead = (await (await fetch(`${baseUrl}/llms.txt`)).text()).split("\n## ")[0]!;
  assertIncludesTokens(llmsLead, "The llms.txt lead", [
    "https://workhorse.run/docs/for-ai-agents.md",
    "Append `.md` to any page URL",
    "https://workhorse.run/docs/installation.md",
    `about ${Math.round(llmsFullBytes / 1000)} KB`,
  ]);
  // The full file carries its own lead rather than a copy of the router's: it
  // points back at the index and states the version rule for the install
  // commands it contains.
  assertIncludesTokens(llmsFullText.split("\n## ")[0]!, "The llms-full.txt lead", [
    "every documentation page in one download",
    "https://workhorse.run/llms.txt",
    "name no version",
  ]);

  const landingHtml = await (await fetch(`${baseUrl}/`)).text();
  assertIncludesTokens(landingHtml, "The landing page", [
    // The footer link is the only agent entry point on the landing page, so a
    // refactor of `site-footer.tsx` that drops it leaves an agent with nothing
    // to follow.
    'href="/llms.txt"',
    '<link rel="canonical" href="https://workhorse.run"',
    'property="og:image" content="https://workhorse.run/brand/workhorse-mark.png"',
    'type="application/ld+json"',
    '"@type":"SoftwareApplication"',
    'aria-label="typescript"',
    'aria-label="python"',
    'aria-label="go"',
  ]);

  const quickstartHtml = await (await fetch(`${baseUrl}/docs/quickstart`)).text();
  assertIncludesTokens(quickstartHtml, "The quickstart page", [
    '<link rel="canonical" href="https://workhorse.run/docs/quickstart"',
    '<link rel="alternate" type="text/markdown" href="https://workhorse.run/docs/quickstart.md"',
    'name="twitter:title" content="Quickstart — Workhorse"',
    '"@type":"TechArticle"',
  ]);

  // The catalog reaches an agent only if the generator expanded the component
  // into Markdown. A twin that still carries the tag serves an empty page.
  const catalogTwin = await (await fetch(`${baseUrl}/docs/integrations.md`)).text();
  if (catalogTwin.includes("<IntegrationCatalog")) {
    throw new Error("The integrations twin shipped the catalog component instead of the catalog");
  }

  // The releases page states which versions receive fixes, so a stale table on
  // it publishes a false security policy. Read the newest heading of each
  // changelog here rather than through the site's own parser: a check that
  // shares the generator's reading of the file cannot catch the generator
  // misreading it.
  const releasesHtml = await (await fetch(`${baseUrl}/docs/releases`)).text();
  const releasesTwin = await (await fetch(`${baseUrl}/docs/releases.md`)).text();
  if (releasesTwin.includes("<ReleaseTable")) {
    throw new Error("The releases twin shipped the table component instead of the versions");
  }
  for (const changelog of ["CHANGELOG.md", "python/CHANGELOG.md", "go/CHANGELOG.md"]) {
    const source = await readFile(resolve(repositoryRoot, changelog), "utf8");
    const newest = /^## (\S+) — (\d{4}-\d{2}-\d{2})$/m.exec(source);
    const version = newest?.[1];
    const date = newest?.[2];
    if (!version || !date) {
      throw new Error(`${changelog} has no "## <version> — <date>" heading to check`);
    }
    for (const [surface, body] of [
      ["/docs/releases", releasesHtml],
      ["/docs/releases.md", releasesTwin],
      ["/llms-full.txt", llmsFullText],
    ] as const) {
      if (!body.includes(version) || !body.includes(date)) {
        throw new Error(
          `${surface} does not carry ${version} (${date}), the newest release in ${changelog}`,
        );
      }
    }
  }

  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  if (!sitemap.includes("<loc>https://workhorse.run/</loc>")) {
    throw new Error("The sitemap omitted the landing page");
  }
  if (sitemap.includes("<lastmod>")) {
    throw new Error("The sitemap claims a modification date that the source does not track");
  }

  // The blog (ADR 0052) ships with zero posts and grows one file at a time.
  // With a post, the index, the post, its twin, and the feed all resolve and
  // the section is linked; with none, nothing links `/blog` and the sitemap
  // does not list it, so an empty page never reaches a reader.
  const blogIndex = JSON.parse(
    await readFile(resolve(repositoryRoot, "site/.source/blog-index.json"), "utf8"),
  ) as { posts: { slug: string; url: string; title: string; date: string }[] };
  if (blogIndex.posts.length > 0) {
    const newest = blogIndex.posts[0]!;
    const index = await fetch(`${baseUrl}/blog`);
    const indexHtml = await index.text();
    if (!index.ok) throw new Error(`/blog returned ${index.status}`);
    assertIncludesTokens(indexHtml, "The blog index", [
      '<link rel="canonical" href="https://workhorse.run/blog"',
      '<link rel="alternate" type="application/rss+xml" href="https://workhorse.run/blog/feed.xml"',
      `href="${newest.url}"`,
      newest.title,
    ]);
    if (!landingHtml.includes('href="/blog"')) {
      throw new Error("The landing page does not link the blog although it has a post");
    }

    const postResponse = await fetch(`${baseUrl}${newest.url}`);
    const postHtml = await postResponse.text();
    if (!postResponse.ok) throw new Error(`${newest.url} returned ${postResponse.status}`);
    assertIncludesTokens(postHtml, `The post ${newest.url}`, [
      `<link rel="canonical" href="https://workhorse.run${newest.url}"`,
      `<link rel="alternate" type="text/markdown" href="https://workhorse.run${newest.url}.md"`,
      'property="og:type" content="article"',
      '"@type":"BlogPosting"',
      `dateTime="${newest.date}"`,
    ]);

    const twin = await fetch(`${baseUrl}${newest.url}.md`);
    const twinText = await twin.text();
    if (!twin.ok) throw new Error(`${newest.url}.md returned ${twin.status}`);
    if (!twinText.startsWith(`---\ntitle: ${JSON.stringify(newest.title)}\n`)) {
      throw new Error(`${newest.url}.md does not start with the twin frontmatter`);
    }
    assertIncludesTokens(twinText, `The twin ${newest.url}.md`, [
      `canonical: "https://workhorse.run${newest.url}"`,
      `# ${newest.title}`,
    ]);

    const feed = await fetch(`${baseUrl}/blog/feed.xml`);
    const feedText = await feed.text();
    if (!feed.ok) throw new Error(`/blog/feed.xml returned ${feed.status}`);
    const feedType = feed.headers.get("content-type") ?? "";
    if (!/xml/.test(feedType)) {
      throw new Error(`/blog/feed.xml was served as ${feedType || "no content type"}`);
    }
    if (!feedText.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"')) {
      throw new Error("/blog/feed.xml is not an RSS 2.0 document");
    }
    const feedLinks = [...feedText.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map(
      (match) => match[1]!,
    );
    if (feedLinks.length !== blogIndex.posts.length) {
      throw new Error(
        `/blog/feed.xml lists ${feedLinks.length} of ${blogIndex.posts.length} posts`,
      );
    }
    for (const [position, link] of feedLinks.entries()) {
      const expected = `https://workhorse.run${blogIndex.posts[position]!.url}`;
      if (link !== expected) {
        throw new Error(`/blog/feed.xml item ${position} links ${link}, expected ${expected}`);
      }
    }
    for (const url of blogIndex.posts.map((post) => post.url)) {
      if (!sitemap.includes(`<loc>https://workhorse.run${url}</loc>`)) {
        throw new Error(`The sitemap omitted the post ${url}`);
      }
    }
    if (!sitemap.includes("<loc>https://workhorse.run/blog</loc>")) {
      throw new Error("The sitemap omitted the blog index although it has a post");
    }
  } else {
    if (landingHtml.includes('href="/blog"')) {
      throw new Error("The landing page links the blog although it has no post");
    }
    if (quickstartHtml.includes('href="/blog"')) {
      throw new Error("The quickstart page links the blog although it has no post");
    }
    if (sitemap.includes("https://workhorse.run/blog")) {
      throw new Error("The sitemap lists the blog although it has no post");
    }
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
    const exited = new Promise<void>((resolveExit) => {
      site.once("exit", () => resolveExit());
    });
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
