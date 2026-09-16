import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { databaseTestFiles } from "./vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: databaseTestFiles,
      // Every file's teardown drops its scratch database, and PostgreSQL forces a cluster-wide
      // immediate checkpoint on each DROP DATABASE. When two checkouts run this suite on the same
      // instance, those checkpoints queue behind each other's write load; a drop that waits on
      // `CheckpointStart` for a minute is the instance serializing work, not a hung hook. Timing
      // it out only leaks the database it was about to drop.
      hookTimeout: 120_000,
    },
  }),
);
