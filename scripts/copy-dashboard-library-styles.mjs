// Copies the dashboard's style sheets into its compiled library.
//
// A consumer imports the package stylesheet `styles.css`, and it imports each component style
// sheet by a relative path. This copies each style sheet under `src` to the same path under
// `dist/library`, so those imports resolve. Node cannot load a `.css` import, so a server that
// imports the package would fail on a module that imports a style sheet. The build fails if a
// compiled module imports one. The exception is `browser.js`, the entry of the browser bundle, which
// no package export reaches.
//
// Usage: node copy-dashboard-library-styles.mjs <source directory> <library directory>
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [sourceRoot, libraryRoot] = process.argv.slice(2);
if (!sourceRoot || !libraryRoot) {
  console.error("Usage: copy-dashboard-library-styles.mjs <source directory> <library directory>");
  process.exit(2);
}

function filesUnder(root, extension) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

for (const file of filesUnder(sourceRoot, ".css")) {
  const target = path.join(libraryRoot, path.relative(sourceRoot, file));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(file, target);
}

const styleImport = /^\s*import\s+["']([^"']+\.css)["'];?\s*$/gm;
const browserEntry = path.join(libraryRoot, "browser.js");
const importers = filesUnder(libraryRoot, ".js")
  .filter((module) => module !== browserEntry)
  .flatMap((module) =>
    [...readFileSync(module, "utf8").matchAll(styleImport)].map(
      (match) => `${path.relative(libraryRoot, module)} imports ${match[1]}`,
    ),
  );
if (importers.length > 0) {
  console.error(
    `A dashboard library module imports a style sheet. Import it from styles.css instead:\n${importers.join("\n")}`,
  );
  process.exit(1);
}
