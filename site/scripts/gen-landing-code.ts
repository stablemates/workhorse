import { mkdir, writeFile } from "node:fs/promises";

import { highlight } from "fumadocs-core/highlight";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createTokenClassTransformer, landingCodeThemes } from "../lib/code-highlighting.js";
import {
  landingSnippetLanguages,
  landingSnippets,
  type LandingSnippetId,
} from "../lib/landing-snippets.js";

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
 * Token colours reach the page as classes, and `scripts/gen-code-theme.ts`
 * writes the rules. This transformer has to be built the same way there.
 */
const tokenClasses = createTokenClassTransformer();

const rendered: Record<string, string> = {};

for (const [id, code] of Object.entries(landingSnippets)) {
  const node = await highlight(code, {
    lang: landingSnippetLanguages[id as LandingSnippetId] ?? "ts",
    themes: landingCodeThemes,
    transformers: [tokenClasses],
    defaultColor: false,
    components: {
      // The `pre` carries the class holding `--shiki-light-bg` and
      // `--shiki-dark-bg`, which `.wh-code-surface` reads for the frame
      // colour, as well as the `shiki` class the token rules are keyed off.
      // So the incoming className has to be preserved — replacing it outright
      // renders every token in the inherited foreground colour on an
      // unthemed frame.
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
