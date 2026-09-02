/**
 * The public-beta notice, owned once.
 *
 * Every public surface carries the notice, and more than one check reads it: this repository's
 * Markdown and MDX surfaces are governed by `scripts/public-beta-release.test.ts`, and the copy
 * inside each published tarball by `typescript/core/test/packed-packages.ts`. Restating the
 * sentence in a second check is how the two came to assert notices that could not both exist, so
 * both read this module instead.
 *
 * The notice is two durable facts wrapped in editorial prose. The label names the stability of the
 * line. The compatibility boundary states the promise a reader upgrades on. The wording around
 * them is free to change; a rewrite that drops either fact is the failure worth catching.
 */

/** The stability label every public surface carries. Compared without regard to case. */
export const publicBetaLabel = "public beta";

/** The compatibility promise the notice makes. Compared against {@link prose}. */
export const compatibilityNotice = "inside a major line a migration only adds";

/**
 * Markdown prose, with blockquote markers and line wrapping removed.
 *
 * A surface may quote the notice, wrap it at any column, or reflow it. None of that changes the
 * sentence, so compare what a reader reads.
 */
export function prose(contents: string): string {
  return contents.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
}

/** Whether `contents` carries the public-beta notice: the label and the compatibility boundary. */
export function hasPublicBetaNotice(contents: string): boolean {
  return (
    contents.toLowerCase().includes(publicBetaLabel) &&
    prose(contents).includes(compatibilityNotice)
  );
}
