import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "require-pnpm.mjs");

/**
 * Run the guard exactly as `preinstall` runs it: `node`, no dependency, one environment variable.
 *
 * The test drives the real entry point rather than an exported helper, because the failure this
 * guard prevents is a package manager reaching the install, not a predicate returning false.
 */
function runGuard(userAgent: string | undefined): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [guard], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(userAgent === undefined ? {} : { npm_config_user_agent: userAgent }),
    },
  });
  return { status: result.status, stderr: result.stderr };
}

describe("the package manager installation guard", () => {
  it("rejects a Bun install before it can replace the pnpm lockfile", () => {
    const result = runGuard("bun/1.3.14 npm/? node/v26.5.0 darwin arm64");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run pnpm install instead of bun install");
  });

  it("allows a pnpm install", () => {
    const result = runGuard("pnpm/10.18.3 npm/? node/v24.13.3 darwin arm64");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows an install that publishes no package manager user agent", () => {
    const result = runGuard(undefined);
    expect(result.status).toBe(0);
  });
});
