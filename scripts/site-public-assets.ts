import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./packages.js";

/**
 * Which images in `site/public` the site uses (SM-1673).
 *
 * The site build copies all of `site/public` into its output, so a file there that no page names
 * still ships in the site image. An image counts as used by the site when the site sources name
 * its public path, when a site module imports its file by a relative path, when
 * `site/integrations.json` names it as a logo, or when a page shows its diagram through
 * `<Diagram name="…">`. Some diagram PNGs are used only by Markdown in the
 * repository, such as the README, which GitHub renders from the repository path. They must stay in
 * `site/public/diagrams`, but the site does not use them, so `Dockerfile.site` removes them from
 * the build output with `--prune`.
 *
 * A package README is different. A registry such as PyPI or crates.io cannot resolve a repository
 * path, so the README loads the image from `https://workhorse.run/` (SM-1787). Such a reference in
 * repository Markdown outside `site/` counts as a use, and the prune step keeps the image.
 *
 * `scripts/site-public-assets.test.ts` fails when a committed file in `site/public` has no use.
 */

/** The file types this module classifies. Every committed file in `site/public` is one of them. */
export const imagePattern = /\.(png|svg|ico|jpe?g|webp|avif|gif)$/;

const siteRoot = path.join(repositoryRoot, "site");
const sourceDirectories = ["app", "components", "content", "lib", "src"];
const sourceFiles = ["integrations.json", "mdx-components.tsx", "nginx.conf", "source.config.ts"];
const sourcePattern = /\.(tsx?|mdx?|json|css|conf)$/;
// The size map names every generated diagram, whether a page shows it or not.
const ignoredSources = new Set([path.join(siteRoot, "lib/diagram-sizes.json")]);
// The image build excludes `.git`, so the Markdown search walks the checkout. It skips the site,
// whose sources the site search reads, and directories that hold only dependencies or build output.
const skippedMarkdownDirectories = new Set(["node_modules", "dist", "target"]);
const publicImageUrlPattern =
  /https:\/\/workhorse\.run\/((?:[\w.-]+\/)*[\w.-]+\.(?:png|svg|ico|jpe?g|webp|avif|gif))(?=["'`)?#;\s]|$)/gm;

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** The images in `site/public`, as paths below it with forward slashes, for example `icon.png`. */
export async function publicImages(): Promise<string[]> {
  const publicRoot = path.join(siteRoot, "public");
  return (await walk(publicRoot))
    .map((file) => path.relative(publicRoot, file).split(path.sep).join("/"))
    .filter((file) => imagePattern.test(file))
    .toSorted();
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || skippedMarkdownDirectories.has(entry.name)) continue;
      if (full === siteRoot) continue;
      files.push(...(await markdownFiles(full)));
    } else if (entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * The images in `site/public` that repository Markdown outside `site/` loads from the public site,
 * as paths below `site/public`.
 */
export function markdownImageUrls(markdown: string): Set<string> {
  const used = new Set<string>();
  for (const match of markdown.matchAll(publicImageUrlPattern)) used.add(match[1]!);
  return used;
}

async function repositoryMarkdown(): Promise<string> {
  const files = await markdownFiles(repositoryRoot);
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")));
  return texts.join("\n");
}

async function siteSources(): Promise<{ file: string; text: string }[]> {
  const files = [
    ...(await Promise.all(sourceDirectories.map((name) => walk(path.join(siteRoot, name))))).flat(),
    ...sourceFiles.map((name) => path.join(siteRoot, name)),
  ].filter(
    (file) => sourcePattern.test(file) && !/\.test\.tsx?$/.test(file) && !ignoredSources.has(file),
  );
  return Promise.all(
    files.map(async (file) => ({ file, text: await readFile(file, "utf8").catch(() => "") })),
  );
}

/**
 * The images in `site/public` that a site module imports by a relative path, such as
 * `import markSvg from "../public/brand/workhorse-mark.svg?raw"`. Each specifier resolves from
 * the directory of its module, and a query such as `?raw` does not change the file.
 */
function relativeImportUses(sources: { file: string; text: string }[]): Set<string> {
  const publicRoot = path.join(siteRoot, "public");
  const used = new Set<string>();
  for (const { file, text } of sources) {
    for (const match of text.matchAll(
      /\b(?:from|import)\s*\(?\s*["'](\.\.?\/[^"'?#]+\.(?:png|svg|ico|jpe?g|webp|avif|gif))[?#"']/g,
    )) {
      const relative = path.relative(publicRoot, path.resolve(path.dirname(file), match[1]!));
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      used.add(relative.split(path.sep).join("/"));
    }
  }
  return used;
}

/** The images in `site/public` that the site uses, as paths below `site/public`. */
export async function siteImageUses(): Promise<Set<string>> {
  const modules = await siteSources();
  const sources = modules.map((module) => module.text).join("\n");
  const used = relativeImportUses(modules);
  // A path ends at a quote, a parenthesis, a semicolon, whitespace, a query, or a fragment, so
  // `/icon.png.json` is no use of `/icon.png`. A path also counts when its file is missing, so the
  // caller can report the missing file.
  for (const match of sources.matchAll(
    /["'`(}]\/((?:[\w.-]+\/)*[\w.-]+\.(?:png|svg|ico|jpe?g|webp|avif|gif))(?=["'`)?#;\s]|$)/gm,
  )) {
    used.add(match[1]!);
  }
  const integrations = JSON.parse(
    await readFile(path.join(siteRoot, "integrations.json"), "utf8"),
  ) as { integrations?: { logo?: { light: string; dark: string } }[] };
  for (const entry of integrations.integrations ?? []) {
    if (!entry.logo) continue;
    used.add(`brand/integrations/${entry.logo.light}.svg`);
    used.add(`brand/integrations/${entry.logo.dark}.svg`);
  }
  for (const match of sources.matchAll(/<Diagram\b[^>]*?\bname="([^"]+)"/g)) {
    for (const variant of ["light", "dark", "narrow-light", "narrow-dark"]) {
      used.add(`diagrams/${match[1]!}-${variant}.png`);
    }
  }
  for (const image of markdownImageUrls(await repositoryMarkdown())) used.add(image);
  return used;
}

/**
 * Remove each image that the site does not use from a built site directory. Before it removes a
 * file, it confirms that no built HTML, Markdown, or JavaScript file names it.
 */
async function pruneUnusedImages(output: string): Promise<string[]> {
  const used = await siteImageUses();
  const unused = (await publicImages()).filter((image) => !used.has(image));
  const built = (await walk(output)).filter((file) => /\.(html|md|js|css|txt|json)$/.test(file));
  const text = (await Promise.all(built.map((file) => readFile(file, "utf8")))).join("\n");
  const named = unused.filter((image) => text.includes(`/${image}`));
  if (named.length > 0) {
    throw new Error(
      `The built site names images that the source check calls unused:\n${named.join("\n")}`,
    );
  }
  await Promise.all(unused.map((image) => rm(path.join(output, image), { force: true })));
  return unused;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const index = process.argv.indexOf("--prune");
  const output = index === -1 ? undefined : process.argv[index + 1];
  if (output === undefined) {
    console.error("Usage: tsx scripts/site-public-assets.ts --prune <built site directory>");
    process.exit(2);
  }
  const removed = await pruneUnusedImages(path.resolve(output));
  console.log(`Removed ${removed.length} images that the site does not use.`);
}
