import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { databaseTestFiles } from "./vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        ...configDefaults.exclude,
        "**/dist/**",
        ...databaseTestFiles,
        "scripts/sql-catalogue-python-bindings.test.ts",
      ],
    },
  }),
);
