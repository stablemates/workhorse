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

/**
 * The documentation theme pair, used by the MDX pipeline.
 */
export const docsCodeThemes = { light: "github-light", dark: "github-dark-dimmed" } as const;

/**
 * The landing page theme pair.
 *
 * `one-light` and `one-dark-pro` share a hue assignment (keywords violet,
 * strings green, types yellow, calls blue), which keeps a snippet legible as
 * the same code in either scheme.
 */
export const landingCodeThemes = { light: "one-light", dark: "one-dark-pro" } as const;

/**
 * Where the generated stylesheet is written, relative to the site package.
 */
export const codeThemeStylesheet = ".source/code-theme.css";

/**
 * Six characters of the hash Shiki derives from a token's colours.
 *
 * The full name is twelve characters and repeats once per token, so the
 * shortening is worth about 27 KB on the landing page alone. Six characters of
 * base 36 leave collision far below the few dozen distinct styles a theme pair
 * produces, and `gen-code-theme.ts` fails the build if two styles ever do
 * collide.
 */
export function shortenTokenClass(name: string): string {
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
