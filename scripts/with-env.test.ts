import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvironment } from "./environment-file.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const environmentPath = resolve(repositoryRoot, ".env");
const probePath = resolve(repositoryRoot, "scripts/with-env-probe.tmp.cjs");

/**
 * Report the variables the wrapper handed the child. Written beside the wrapper because the whole
 * point of `with-env.ts` is that it resolves `.env` from its own checkout, not the caller's cwd.
 */
const probeSource = `require("node:fs").writeFileSync(
  process.env.PROBE_OUTPUT,
  JSON.stringify({
    primary: process.env.DATABASE_URL_PRIMARY,
    generic: process.env.DATABASE_URL,
    port: process.env.WORKHORSE_API_PORT,
    cwd: process.cwd(),
  }),
);
`;

afterEach(async () => {
  await rm(probePath, { force: true });
  await rm(`${probePath}.out`, { force: true });
});

async function runWrapper(environment: NodeJS.ProcessEnv, cwd: string) {
  await writeFile(probePath, probeSource);
  const output = `${probePath}.out`;
  const child = spawn(
    resolve(repositoryRoot, "node_modules/.bin/tsx"),
    [resolve(repositoryRoot, "scripts/with-env.ts"), process.execPath, probePath],
    { cwd, env: { ...environment, PROBE_OUTPUT: output }, stdio: "inherit" },
  );
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  expect(exitCode).toBe(0);
  return JSON.parse(await readFile(output, "utf8")) as {
    primary?: string;
    generic?: string;
    port?: string;
    cwd: string;
  };
}

describe("repository command environment", () => {
  it.skipIf(process.platform === "win32")(
    "overrides a database URL inherited from another checkout",
    async () => {
      const checkoutEnvironment = await readEnvironment(environmentPath);
      const inheritedPrimary = "postgres://workhorse:workhorse@localhost:5432/other_dev_primary";
      const expected = checkoutEnvironment.DATABASE_URL_PRIMARY ?? inheritedPrimary;

      const result = await runWrapper(
        {
          ...process.env,
          DATABASE_URL_PRIMARY: inheritedPrimary,
          DATABASE_URL: "postgres://workhorse:workhorse@localhost:5432/caller_owned",
        },
        repositoryRoot,
      );

      expect(result.primary).toBe(expected);
      expect(result.generic).toContain("caller_owned");
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves its checkout from the script rather than the working directory",
    async () => {
      const checkoutEnvironment = await readEnvironment(environmentPath);
      const result = await runWrapper({ ...process.env }, resolve(repositoryRoot, ".."));

      expect(result.primary).toBe(
        checkoutEnvironment.DATABASE_URL_PRIMARY ?? process.env.DATABASE_URL_PRIMARY,
      );
      expect(resolve(result.cwd)).toBe(repositoryRoot);
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves variables it does not provision to the caller",
    async () => {
      const result = await runWrapper(
        { ...process.env, WORKHORSE_API_PORT: "4123" },
        repositoryRoot,
      );

      expect(result.port).toBe("4123");
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it.skipIf(process.platform === "win32")(`forwards ${signal} to the command`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "workhorse-with-env-signal-"));
      try {
        const ready = join(directory, "ready");
        const received = join(directory, "received");
        const command = `const { writeFileSync } = require("node:fs");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { writeFileSync(${JSON.stringify(received)}, signal); process.exit(0); });
}
writeFileSync(${JSON.stringify(ready)}, "");
setInterval(() => {}, 1000);`;
        // Only the wrapper gets the signal, so the command can get it only by the forward.
        const wrapper = spawn(
          resolve(repositoryRoot, "node_modules/.bin/tsx"),
          [resolve(repositoryRoot, "scripts/with-env.ts"), process.execPath, "-e", command],
          { cwd: repositoryRoot, env: process.env, stdio: "ignore" },
        );
        const exited = new Promise<number | null>((resolveExit, reject) => {
          wrapper.once("error", reject);
          wrapper.once("exit", resolveExit);
        });
        try {
          for (let attempt = 0; attempt < 250; attempt += 1) {
            if (
              await readFile(ready).then(
                () => true,
                () => false,
              )
            )
              break;
            await delay(20);
          }
          wrapper.kill(signal);

          expect(await exited).toBe(0);
          expect(await readFile(received, "utf8")).toBe(signal);
        } finally {
          if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
