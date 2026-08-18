import { mkdir, writeFile } from "node:fs/promises";

import { highlight } from "fumadocs-core/highlight";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { landingSnippets } from "../lib/landing-snippets.js";

/**
 * Highlights every landing-page snippet into static markup.
 *
 * The docs pages get their highlighting from the Fumadocs MDX pipeline, but
 * the landing page is a plain route, and Shiki cannot run there without
 * entering the browser bundle. So the highlighting runs here, at build time,
 * and the route reads the finished markup from `.source/landing-code.json` —
 * the same shape `gen-docs-index.ts` uses to keep Node APIs out of the client.
 */

/**
 * Theme pair for every landing snippet.
 *
 * Both themes are written into the same markup and selected by CSS variables,
 * so they have to be chosen as a pair: `one-light` and `one-dark-pro` share a
 * hue assignment (keywords violet, strings green, types yellow, calls blue),
 * which keeps a snippet legible as the same code in either scheme.
 */
const codeThemes = { light: "one-light", dark: "one-dark-pro" } as const;

const rendered: Record<string, string> = {};

for (const [id, code] of Object.entries(landingSnippets)) {
  const node = await highlight(code, {
    lang: "ts",
    themes: codeThemes,
    defaultColor: false,
    components: {
      // Shiki emits per-token colours as `--shiki-light` / `--shiki-dark`
      // custom properties and relies on a `.shiki code span` rule to apply
      // them. That rule is keyed off the `shiki` class Shiki puts on the
      // `pre`, so the incoming className has to be preserved — replacing it
      // outright renders every token in the inherited foreground colour.
      pre: ({ className, ...props }) =>
        createElement("pre", {
          ...props,
          className: `${typeof className === "string" ? className : ""} wh-code-surface overflow-x-auto px-4 py-4 text-[12.5px] leading-[1.75] [&_code]:font-mono`,
        }),
    },
  });
  rendered[id] = renderToStaticMarkup(createElement("div", { className: "contents" }, node));
}

const outDir = new URL("../.source/", import.meta.url);
await mkdir(outDir, { recursive: true });
await writeFile(new URL("landing-code.json", outDir), `${JSON.stringify(rendered, null, 2)}\n`);
