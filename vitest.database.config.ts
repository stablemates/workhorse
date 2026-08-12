import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { databaseTestFiles } from "./vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: databaseTestFiles,
    },
  }),
);
