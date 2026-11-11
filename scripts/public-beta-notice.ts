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
 * line, and the compatibility boundary states the promise a reader upgrades on. The wording around
 * them is free to change; a rewrite that drops either is the failure worth catching.
 */

/** The stability label every public surface carries. Compared without regard to case. */
export const publicBetaLabel = "public beta";

/** The compatibility promise the notice makes. Compared against {@link prose}. */
export const compatibilityNotice = "inside a major line a migration only adds";

/**
 * The one exception to {@link compatibilityNotice}. Migration 0025 is a contract step that 0.5.0
 * ships, so a database from before 0.5.0 crosses it offline. The reference documents name it.
 * Compared without regard to case against {@link prose}.
 */
export const cutoverException = "migration 0025";

/**
 * Markdown prose, with blockquote markers and line wrapping removed.
 *
 * A surface may quote the notice, wrap it at any column, or reflow it. None of that changes the
 * sentence, so compare what a reader reads.
 */
export function prose(contents: string): string {
  return contents.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
}

/** Whether `contents` names the migration 0025 exception to the compatibility boundary. */
export function hasCutoverException(contents: string): boolean {
  return prose(contents).toLowerCase().includes(cutoverException);
}

/**
 * The page section that gives the offline steps across migration 0025. A README is read on a
 * registry page as well as in the repository, so its notice links the published site.
 */
export const offlineUpgradeSteps =
  "https://workhorse.run/docs/installation#upgrade-a-04x-database-offline";

/**
 * Whether a README that states {@link compatibilityNotice} also names its exception and links
 * {@link offlineUpgradeSteps}. A README without the promise needs neither. A team on a release
 * before 0.5.0 that reads the promise alone can plan a rolling deployment across the contract step.
 */
export function hasReadmeCutoverNotice(contents: string): boolean {
  if (!prose(contents).includes(compatibilityNotice)) return true;
  return hasCutoverException(contents) && contents.includes(offlineUpgradeSteps);
}

/** Whether `contents` carries the public-beta notice: the label and the compatibility boundary. */
export function hasPublicBetaNotice(contents: string): boolean {
  return (
    contents.toLowerCase().includes(publicBetaLabel) &&
    prose(contents).includes(compatibilityNotice)
  );
}
