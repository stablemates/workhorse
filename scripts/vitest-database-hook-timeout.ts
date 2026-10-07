import path from "node:path";
import { expect, inject, vi } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    databaseHookTimeout: number;
    databaseTestFiles: string[];
  }
}

// A database test file drops its scratch database in teardown, and that drop can wait a minute
// behind another checkout's checkpoints. The file gets the longer hook timeout under every config,
// including a plain `vitest run <file>`, not only under vitest.database.config.ts.
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const testFile = path.relative(repositoryRoot, expect.getState().testPath ?? "");
if (inject("databaseTestFiles").some((pattern) => path.matchesGlob(testFile, pattern))) {
  vi.setConfig({ hookTimeout: inject("databaseHookTimeout") });
}
