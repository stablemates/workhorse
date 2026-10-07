import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { databaseHookTimeout, databaseTestFiles } from "./vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: databaseTestFiles,
      hookTimeout: databaseHookTimeout,
    },
  }),
);
