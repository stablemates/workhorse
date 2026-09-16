import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { worktreeDatabaseUrl } from "../typescript/core/src/local-database.js";
import {
  checkoutDatabaseEnvironment,
  writeCheckoutDatabaseEnvironment,
} from "./checkout-databases.js";
import {
  describeUnscopedDatabases,
  linkedWorktreeId,
  unscopedDatabases,
} from "./worktree-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryCheckout(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "workhorse-checkout-databases-"));
  temporaryDirectories.push(path);
  return path;
}

describe("checkout database environment", () => {
  it("derives every database variable from the canonical local purposes", () => {
    expect(checkoutDatabaseEnvironment({})).toEqual({
      DATABASE_URL_PRIMARY: "postgres://workhorse:workhorse@localhost:5432/workhorse_dev_primary",
      DATABASE_URL_SECONDARY:
        "postgres://workhorse:workhorse@localhost:5432/workhorse_dev_secondary",
      DATABASE_URL_TEST: "postgres://workhorse:workhorse@localhost:5432/workhorse_test",
      DATABASE_URL_BENCH: "postgres://workhorse:workhorse@localhost:5432/workhorse_bench",
      DATABASE_URL_TEST_PACKED:
        "postgres://workhorse:workhorse@localhost:5432/workhorse_test_packed",
    });
  });

  it("appends missing variables without changing existing values", async () => {
    const checkout = await temporaryCheckout();
    const existingPrimary = "postgres://workhorse:workhorse@localhost:5432/custom_dev_primary";
    await writeFile(
      join(checkout, ".env"),
      `DATABASE_URL_PRIMARY=${existingPrimary}\nWORKHORSE_API_PORT=4123\n`,
    );

    const result = await writeCheckoutDatabaseEnvironment(checkout);
    const contents = await readFile(join(checkout, ".env"), "utf8");

    expect(result.environment.DATABASE_URL_PRIMARY).toBe(existingPrimary);
    expect(result.addedVariables).toEqual([
      "DATABASE_URL_SECONDARY",
      "DATABASE_URL_TEST",
      "DATABASE_URL_BENCH",
      "DATABASE_URL_TEST_PACKED",
    ]);
    expect(contents).toContain(`DATABASE_URL_PRIMARY=${existingPrimary}`);
    expect(contents).toContain("WORKHORSE_API_PORT=4123");
    expect((await stat(join(checkout, ".env"))).mode & 0o777).toBe(0o600);

    await writeCheckoutDatabaseEnvironment(checkout);
    expect(await readFile(join(checkout, ".env"), "utf8")).toBe(contents);
  });

  it("starts a missing environment file from the example", async () => {
    const checkout = await temporaryCheckout();
    await writeFile(
      join(checkout, ".env.example"),
      "DATABASE_URL_PRIMARY=postgres://workhorse:workhorse@localhost:5432/workhorse_dev_primary\nPORTLESS_PORT=43155\n",
    );

    const result = await writeCheckoutDatabaseEnvironment(checkout);
    const contents = await readFile(join(checkout, ".env"), "utf8");

    expect(result.addedVariables).toHaveLength(5);
    expect(contents).toContain("PORTLESS_PORT=43155");
    expect(contents).toContain("DATABASE_URL_TEST_PACKED=");
  });

  it("replaces database values only when linked worktree setup requests it", async () => {
    const checkout = await temporaryCheckout();
    await writeFile(
      join(checkout, ".env"),
      "DATABASE_URL_PRIMARY=postgres://workhorse:workhorse@localhost:5432/workhorse_dev_primary\n",
    );
    const generated = {
      DATABASE_URL_PRIMARY:
        "postgres://workhorse:workhorse@localhost:5432/workhorse_dev_primary_feature",
    };

    const result = await writeCheckoutDatabaseEnvironment(checkout, {
      databaseEnvironment: generated,
      overwriteExisting: true,
    });

    expect(result.environment.DATABASE_URL_PRIMARY).toBe(generated.DATABASE_URL_PRIMARY);
    expect(result.addedVariables).toEqual([]);
  });
});

describe("linked worktree database isolation", () => {
  const primaryEnvironment = checkoutDatabaseEnvironment({});

  function worktreeEnvironment(worktreeId: string): Record<string, string> {
    return {
      DATABASE_URL_PRIMARY: worktreeDatabaseUrl(
        primaryEnvironment.DATABASE_URL_PRIMARY!,
        "dev_primary",
        worktreeId,
      ),
      DATABASE_URL_SECONDARY: worktreeDatabaseUrl(
        primaryEnvironment.DATABASE_URL_SECONDARY!,
        "dev_secondary",
        worktreeId,
      ),
      DATABASE_URL_TEST: worktreeDatabaseUrl(
        primaryEnvironment.DATABASE_URL_TEST!,
        "test",
        worktreeId,
      ),
      DATABASE_URL_BENCH: worktreeDatabaseUrl(
        primaryEnvironment.DATABASE_URL_BENCH!,
        "bench",
        worktreeId,
      ),
      DATABASE_URL_TEST_PACKED: worktreeDatabaseUrl(
        primaryEnvironment.DATABASE_URL_TEST_PACKED!,
        "test_packed",
        worktreeId,
      ),
    };
  }

  it("accepts the databases setup generates for the same worktree", () => {
    expect(unscopedDatabases(worktreeEnvironment("prowfish"), "prowfish")).toEqual([]);
  });

  it("rejects the primary checkout's database names", () => {
    expect(
      unscopedDatabases(primaryEnvironment, "prowfish").map((entry) => entry.variable),
    ).toEqual([
      "DATABASE_URL_PRIMARY",
      "DATABASE_URL_SECONDARY",
      "DATABASE_URL_TEST",
      "DATABASE_URL_BENCH",
      "DATABASE_URL_TEST_PACKED",
    ]);
  });

  it("rejects another worktree's database names", () => {
    const unscoped = unscopedDatabases(worktreeEnvironment("mudskipper"), "prowfish");
    expect(unscoped).toHaveLength(5);
    expect(unscoped[2]).toEqual({
      variable: "DATABASE_URL_TEST",
      database: expect.stringMatching(/^workhorse_test_mudskipper_[0-9a-f]{8}$/),
    });
  });

  it("rejects a missing variable, which would fall back to the primary default", () => {
    const { DATABASE_URL_TEST: _test, ...partial } = worktreeEnvironment("prowfish");
    expect(unscopedDatabases(partial, "prowfish")).toEqual([
      { variable: "DATABASE_URL_TEST", database: undefined },
    ]);
  });

  it("names the offending databases and the command to run", () => {
    const message = describeUnscopedDatabases("prowfish", "/checkouts/prowfish", [
      { variable: "DATABASE_URL_TEST", database: "workhorse_test" },
    ]);
    expect(message).toContain("DATABASE_URL_TEST → workhorse_test");
    expect(message).toContain("pnpm worktree:setup");
    expect(message).toContain("/checkouts/prowfish");
  });

  it("tells a linked worktree apart from the primary checkout by its .git pointer", async () => {
    const linked = await temporaryCheckout();
    await writeFile(join(linked, ".git"), "gitdir: /repo/.git/worktrees/prowfish\n");
    expect(await linkedWorktreeId(linked)).toBe("prowfish");

    const primary = await temporaryCheckout();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(primary, ".git"));
    expect(await linkedWorktreeId(primary)).toBeUndefined();

    expect(await linkedWorktreeId(await temporaryCheckout())).toBeUndefined();
  });
});
