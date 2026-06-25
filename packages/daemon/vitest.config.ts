import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The ingest worker claims jobs ACROSS tenants (EPIC J), so worker tests and
    // route tests share one Postgres queue. Run test files serially to avoid one
    // file's worker processing another file's jobs mid-assertion. Same rationale
    // as @dolores/core's config.
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
