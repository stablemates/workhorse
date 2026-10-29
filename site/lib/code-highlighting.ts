/**
 * How every code sample on this site is coloured, in one place.
 *
 * Shiki writes both themes onto each token. Written as a style attribute that
 * is about fifty bytes per token, and a page carries thousands of tokens: the
 * landing page once shipped 361 KB of repeated hex colours, more than the whole
 * documentation corpus. Written as a class it is a few bytes, and the colours
 * are stated once in a generated stylesheet.
 *
 * Two pipelines highlight code and they run in separate processes: the MDX
 * pipeline in `source.config.ts` for documentation pages, and
 * `scripts/gen-landing-code.ts` for the landing page. `scripts/gen-code-theme.ts`
 * writes the one stylesheet both of them depend on. That only works because a
 * class name is derived from the colours it stands for, so the same token style
 * gets the same name in every process, whatever order it is met in.
 */
import { transformerStyleToClass } from "@shikijs/transformers";

/** The part of a Shiki theme registration that the two landing themes use. */
interface CodeTheme {
  name: string;
  type: "light" | "dark";
  colors: { "editor.background": string; "editor.foreground": string };
  tokenColors: { scope: string[]; settings: { foreground: string; fontStyle?: string } }[];
}

/** The four token roles a landing theme colours. Everything else takes the foreground. */
interface CodeThemeRoles {
  background: string;
  foreground: string;
  strong: string;
  keyword: string;
  quiet: string;
  literal: string;
}

/**
 * Builds a restrained theme: names and calls in the strongest neutral, plain
 * text one step down, and keywords, comments, and punctuation in the quieter
 * neutral. Comments stay upright, because Geist Mono has no italic face and
 * the browser would slant the regular one. Literals take the role the caller
 * gives them.
 */
function restrainedTheme(name: string, type: CodeTheme["type"], roles: CodeThemeRoles): CodeTheme {
  return {
    name,
    type,
    colors: { "editor.background": roles.background, "editor.foreground": roles.foreground },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: roles.quiet },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "constant.language",
          "variable.language",
        ],
        settings: { foreground: roles.keyword },
      },
      {
        scope: ["punctuation", "meta.brace", "keyword.operator"],
        settings: { foreground: roles.quiet },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "punctuation.definition.string",
          "constant.numeric",
          "constant.character",
        ],
        settings: { foreground: roles.literal },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "entity.name.type",
          "entity.name.class",
          "support.type",
          "support.class",
        ],
        settings: { foreground: roles.strong },
      },
    ],
  };
}

/**
 * The theme pair of every code sample the site highlights: the landing and
 * features pages, and through the MDX pipeline the comparison pages and the
 * blog. The stock GitHub themes that the MDX pipeline used before had light
 * tokens at 3.2:1 to 4.4:1 and dark comments at 4.2:1 on these fills.
 *
 * A snippet on the landing page or the features page is evidence, not
 * decoration, so its colours stay inside the neutral ramp, except strings and
 * numbers, which take the amber key color as the rest of those pages do
 * (`src/styles/marketing.css`). Names and calls read strongest and everything
 * else recedes. The background is the panel fill of the frame: n3 in light and
 * n2 in dark. Each colour has at least 4.5:1 contrast on it, so the quieter
 * roles use n8 in light and n7 in dark, and light mode uses the darker amber
 * ink (#8f5b1d, 5.2:1 on n3). The amber itself is 5.2:1 on n2.
 */
export const siteCodeThemes = {
  light: restrainedTheme("workhorse-light", "light", {
    background: "#f4f4f4",
    foreground: "#333333",
    strong: "#000000",
    keyword: "#555555",
    quiet: "#555555",
    literal: "#8f5b1d",
  }),
  dark: restrainedTheme("workhorse-dark", "dark", {
    background: "#202020",
    foreground: "#cfcfcf",
    strong: "#ffffff",
    keyword: "#ababab",
    quiet: "#ababab",
    literal: "#cf9148",
  }),
};

/** The theme pair, as the highlighting scripts receive it. */
export type CodeThemePair = typeof siteCodeThemes;

/**
 * Six characters of the hash Shiki derives from a token's colours.
 *
 * The full name is twelve characters and repeats once per token, so the
 * shortening is worth about 27 KB on the landing page alone. Six characters of
 * base 36 leave collision far below the few dozen distinct styles a theme pair
 * produces, and `gen-code-theme.ts` fails the build if two styles ever do
 * collide.
 */
function shortenTokenClass(name: string): string {
  return name.slice(0, 6);
}

/**
 * A transformer that replaces each token's style attribute with a class.
 *
 * Every caller must build it the same way, because the class names have to
 * agree with the generated stylesheet. Call `getCSS()` on the returned
 * instance to read the rules for whatever it highlighted.
 */
export function createTokenClassTransformer() {
  return transformerStyleToClass({ classPrefix: "wh", classReplacer: shortenTokenClass });
}
