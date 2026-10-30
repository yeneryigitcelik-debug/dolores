import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Schema bootstrap changes roles, policies and vector indexes. Integration
    // files share one disposable database and must not migrate it concurrently.
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
