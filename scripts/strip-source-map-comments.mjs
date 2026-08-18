import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2];

if (directory === undefined) {
  throw new Error("Usage: node scripts/strip-source-map-comments.mjs <directory>");
}

for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isFile() || (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts"))) {
    continue;
  }

  const file = path.join(directory, entry.name);
  const source = await readFile(file, "utf8");
  const stripped = source.replace(/^\/\/[#@] sourceMappingURL=.*\.map\r?\n?/gm, "");

  if (stripped !== source) {
    await writeFile(file, stripped);
  }
}
