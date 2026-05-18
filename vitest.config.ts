import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    maxWorkers: 3,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
