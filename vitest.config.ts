import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
