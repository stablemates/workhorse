import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { Theme } from "./diagram-svg.js";
import { repositoryRoot } from "./packages.js";
import { diagramSizes, diagrams } from "./diagrams.js";

/**
 * Write or verify the documentation diagrams in `site/public/diagrams/`.
 *
 * Each diagram has a light and a dark SVG, the source of record, and a PNG at twice the size for
 * the README, because GitHub cannot load the Geist fonts in an embedded SVG. The PNGs use the
 * Geist TTF files from the pinned `geist` package and no system fonts, so the output does not
 * depend on the machine. It also writes `site/lib/diagram-sizes.json`, the CSS width and height of
 * each diagram, so the site can reserve the space of an image before it loads. `--check` compares
 * the SVGs and the size map.
 */

const themes: readonly Theme[] = ["light", "dark"];
const outputDirectory = path.join(repositoryRoot, "site/public/diagrams");
const sizesFile = path.join(repositoryRoot, "site/lib/diagram-sizes.json");
const fonts = path.join(repositoryRoot, "node_modules/geist/dist/fonts");
const fontFiles = [
  "geist-sans/Geist-Regular.ttf",
  "geist-sans/Geist-SemiBold.ttf",
  "geist-mono/GeistMono-Regular.ttf",
].map((file) => path.join(fonts, file));

function renderPng(svg: string): Buffer {
  const width = Number(/viewBox="0 0 (\d+) /.exec(svg)![1]);
  return new Resvg(svg, {
    fitTo: { mode: "width", value: width * 2 },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Geist" },
  })
    .render()
    .asPng();
}

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const diagram of diagrams) {
  for (const theme of themes) {
    const file = path.join(outputDirectory, `${diagram.slug}-${theme}`);
    const svg = diagram.render(theme);
    if (check) {
      const current = await readFile(`${file}.svg`, "utf8").catch(() => "");
      if (current !== svg) stale.push(path.relative(repositoryRoot, `${file}.svg`));
      continue;
    }
    await writeFile(`${file}.svg`, svg);
    await writeFile(`${file}.png`, renderPng(svg));
  }
}
const sizeLines = Object.entries(diagramSizes()).map(
  ([slug, [width, height]]) => `  ${JSON.stringify(slug)}: [${width}, ${height}]`,
);
const sizes = `{\n${sizeLines.join(",\n")}\n}\n`;
if (check) {
  const current = await readFile(sizesFile, "utf8").catch(() => "");
  if (current !== sizes) stale.push(path.relative(repositoryRoot, sizesFile));
} else {
  await writeFile(sizesFile, sizes);
}
if (stale.length > 0) {
  console.error(`These diagrams are stale. Run \`pnpm diagrams:generate\`:\n${stale.join("\n")}`);
  process.exitCode = 1;
}
