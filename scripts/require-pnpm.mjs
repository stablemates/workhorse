// The installation guard runs as `preinstall`, before any dependency exists. It is plain
// JavaScript and imports nothing, because `tsx` and every other devDependency is still absent at
// that point — a guard that needed one would fail the very command it tells the developer to run.

const message =
  "Workhorse uses pnpm for dependency installation. Run pnpm install instead of bun install.";

/**
 * True when a package manager identifies itself as Bun.
 *
 * npm, pnpm, and Bun all publish `npm_config_user_agent` in the form `name/version ...`, so the
 * first field identifies the caller.
 *
 * @param {string | undefined} userAgent
 * @returns {boolean}
 */
export function isBunUserAgent(userAgent) {
  return userAgent === undefined ? false : userAgent.split(" ")[0].startsWith("bun/");
}

if (isBunUserAgent(process.env.npm_config_user_agent)) {
  console.error(message);
  process.exit(1);
}
