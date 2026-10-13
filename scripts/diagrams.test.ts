import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagrams } from "./diagrams.js";
import { repositoryRoot } from "./packages.js";

describe("documentation diagrams", () => {
  for (const diagram of diagrams) {
    for (const theme of ["light", "dark"] as const) {
      it(`matches the committed ${diagram.slug}-${theme}.svg`, async () => {
        const file = path.join(repositoryRoot, `site/public/diagrams/${diagram.slug}-${theme}.svg`);
        expect(diagram.render(theme), "Run `pnpm diagrams:generate`.").toBe(
          await readFile(file, "utf8"),
        );
      });
    }
  }
});
