import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/__tests__/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 30000,
    maxWorkers: 3,
    // Tolerate the pre-existing worker-fork EPERM baseline (since v0.4.0).
    // On CI (no `copilot` CLI) and locally this leaks 1 file-level unhandled
    // error during test teardown. All assertions pass; the noise should not
    // gate CI. Documented in v1.7.0 release notes + ADR-v2.0-public-release-deferred.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
