import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./packages.js";

/**
 * Which images in `site/public` the site uses (SM-1673).
 *
 * The site build copies all of `site/public` into its output, so a file there that no page names
 * still ships in the site image. An image counts as used by the site when the site sources name
 * its public path, when `site/integrations.json` names it as a logo, or when a page shows its
 * diagram through `<Diagram name="…">`. Some diagram PNGs are used only by Markdown in the
 * repository, such as the README, which GitHub renders from the repository path. They must stay in
 * `site/public/diagrams`, but the site does not use them, so `Dockerfile.site` removes them from
 * the build output with `--prune`.
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

async function siteSources(): Promise<string> {
  const files = [
    ...(await Promise.all(sourceDirectories.map((name) => walk(path.join(siteRoot, name))))).flat(),
    ...sourceFiles.map((name) => path.join(siteRoot, name)),
  ].filter(
    (file) => sourcePattern.test(file) && !/\.test\.tsx?$/.test(file) && !ignoredSources.has(file),
  );
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")));
  return texts.join("\n");
}

/** The images in `site/public` that the site uses, as paths below `site/public`. */
export async function siteImageUses(): Promise<Set<string>> {
  const sources = await siteSources();
  const used = new Set<string>();
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
