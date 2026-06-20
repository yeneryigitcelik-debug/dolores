import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integration tests share one Postgres and write to the same tables.
    // Each isolates by workspace + cleans up, but recall() bumps last_accessed and
    // the importance/recency boost is timing-sensitive, so running test files
    // serially removes cross-file interference. Unit tests are unaffected.
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
