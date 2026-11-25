/**
 * The release notice, owned once.
 *
 * Every public surface carries the notice, and more than one check reads it: this repository's
 * Markdown and MDX surfaces are governed by `scripts/public-beta-release.test.ts`, and the copy
 * inside each published tarball by `typescript/core/test/packed-packages.ts`. Restating the
 * sentence in a second check is how the two came to assert notices that could not both exist, so
 * both read this module instead.
 *
 * The notice is two durable facts wrapped in editorial prose. The SemVer statement names the
 * promise of the stable line, and the compatibility boundary states the promise a reader upgrades
 * on. The wording around them is free to change; a rewrite that drops either is the failure worth
 * catching.
 *
 * Until 1.0.0 the notice carried the "public beta" label. At 1.0.0 the label retires and "stable"
 * replaces it (ADR 0054). "Stable" is the absence of a qualifier (`GLOSSARY.md`), so a current
 * surface states the SemVer promise and does not carry the retired label. The dated 0.x changelog
 * entries keep the label as history.
 */

/** The label of the 0.x releases, which retires at 1.0.0. Compared without regard to case. */
export const retiredLabel = "public beta";

/** The promise of the stable line, which every notice states. Compared against {@link prose}. */
export const semverNotice = "follows Semantic Versioning";

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

/** Whether `contents` still names the retired label. */
export function hasRetiredLabel(contents: string): boolean {
  return contents.toLowerCase().includes(retiredLabel);
}

/** Whether `contents` carries the notice: the SemVer promise and the compatibility boundary. */
export function hasStableNotice(contents: string): boolean {
  const text = prose(contents);
  return text.includes(semverNotice) && text.includes(compatibilityNotice);
}
