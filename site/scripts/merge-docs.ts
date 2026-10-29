import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies the documentation pages that Blume built in `site/blume/dist` into
 * the TanStack Start output in `site/dist/client`, which `Dockerfile.site`
 * serves.
 *
 * Blume copies all of `site/public` into its output too, and it writes its own
 * Markdown mirrors. `gen-docs-index.ts` already owns the Markdown twins and
 * every other agent file, and the TanStack Start build already copied
 * `site/public`. This script therefore copies only what Blume alone makes:
 *
 * - each page at `docs/**\/index.html`;
 * - `_astro/`, the hashed scripts, styles, and fonts of those pages;
 * - `blume-nav/`, the sidebar sections that a page loads when a reader opens
 *   them;
 * - `blume-search.json`, the search index.
 *
 * A file in the site output with the same path is an error, because one of the
 * two builds would silently replace the other's page.
 */

const siteDir = fileURLToPath(new URL("../", import.meta.url));
const blumeDist = join(siteDir, "blume/dist");
const siteDist = join(siteDir, "dist/client");

const sharedDirectories = ["_astro", "blume-nav"] as const;
const sharedFiles = ["blume-search.json"] as const;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Shiki writes the colours of each code token as a style attribute, about fifty
 * bytes for each token, and a page has thousands of tokens. The site moves each
 * distinct style into a class in one stylesheet, as `lib/code-highlighting.ts`
 * does for the landing page. Blume's own rules read the same `--shiki-*`
 * properties, so the class sets them and the colours stay the same.
 */
const codeStyle = / style="(--shiki-[^"]*)"/g;

function tokenClass(style: string): string {
  return `wh-c${createHash("sha256").update(style).digest("hex").slice(0, 6)}`;
}

if (!(await exists(join(blumeDist, "docs/index.html")))) {
  throw new Error(`${blumeDist} has no docs/index.html. Run the Blume build first.`);
}
if (!(await exists(join(siteDist, "index.html")))) {
  throw new Error(`${siteDist} has no index.html. Run the TanStack Start build first.`);
}

const pages = (await filesUnder(join(blumeDist, "docs"))).filter((file) =>
  file.endsWith("/index.html"),
);
const shared = (
  await Promise.all(sharedDirectories.map((directory) => filesUnder(join(blumeDist, directory))))
).flat();
const assets = [...shared, ...sharedFiles.map((file) => join(blumeDist, file))];

const collisions: string[] = [];
await Promise.all(
  [...pages, ...assets].map(async (file) => {
    if (await exists(join(siteDist, relative(blumeDist, file)))) {
      collisions.push(relative(blumeDist, file));
    }
  }),
);
if (collisions.length > 0) {
  throw new Error(
    `The Blume output and the site output both have these files: ${collisions.toSorted().join(", ")}`,
  );
}

const sources = await Promise.all(
  pages.map(async (file) => ({ file, html: await readFile(file, "utf8") })),
);
const styles = new Map<string, string>();
for (const { html } of sources) {
  for (const match of html.matchAll(codeStyle)) {
    const style = match[1];
    if (style === undefined) continue;
    const name = tokenClass(style);
    const known = styles.get(name);
    if (known !== undefined && known !== style) {
      throw new Error(`The code styles "${known}" and "${style}" share the class ${name}`);
    }
    styles.set(name, style);
  }
}

const stylesheet = [...styles]
  .toSorted(([a], [b]) => a.localeCompare(b))
  .map(([name, style]) => `.${name}{${style}}`)
  .join("\n");
const stylesheetPath = `/_astro/wh-code.${createHash("sha256").update(stylesheet).digest("hex").slice(0, 8)}.css`;
const stylesheetLink = `<link rel="stylesheet" href="${stylesheetPath}">`;

await mkdir(join(siteDist, "_astro"), { recursive: true });
await writeFile(join(siteDist, stylesheetPath), `${stylesheet}\n`);

await Promise.all(
  sources.map(async ({ file, html }) => {
    const page = html
      .replace(codeStyle, (_match, style: string) => ` class="${tokenClass(style)}"`)
      // A code block's `<pre>` already has a class attribute, so the rewrite
      // above gave it a second one. Merge the two into the first.
      .replace(
        /(<pre class="[^"]*)"([^>]*?) class="(wh-c[0-9a-f]{6})"/g,
        (_match, before: string, between: string, name: string) => `${before} ${name}"${between}`,
      )
      .replace("</head>", `${stylesheetLink}</head>`);
    const target = join(siteDist, relative(blumeDist, file));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, page);
  }),
);

await Promise.all(assets.map((file) => cp(file, join(siteDist, relative(blumeDist, file)))));

console.log(
  `Copied ${pages.length} documentation pages and ${assets.length} assets, ` +
    `with ${styles.size} code token styles in ${stylesheetPath}`,
);
