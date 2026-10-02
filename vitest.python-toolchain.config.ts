import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";
import { pythonToolchainTestFiles } from "./vitest.npm.config.js";

// The unit tests the npm release scope leaves out. Together the two scopes make the unit scope, so
// CI runs each unit test once.
export default mergeConfig(
  baseConfig,
  defineConfig({ test: { include: pythonToolchainTestFiles } }),
);
