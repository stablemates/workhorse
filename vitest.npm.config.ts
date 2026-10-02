import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { databaseTestFiles } from "./vitest.config.js";

// Unit tests that spawn the Python toolchain. The npm release job installs none, so they leave its
// scope and run in `vitest.python-toolchain.config.ts` instead.
export const pythonToolchainTestFiles = [
  "scripts/sql-catalogue-python-bindings.test.ts",
  // Spawns `uv publish`.
  "scripts/check-attestation-upload.test.ts",
];

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        ...configDefaults.exclude,
        "**/dist/**",
        ...databaseTestFiles,
        ...pythonToolchainTestFiles,
      ],
    },
  }),
);
