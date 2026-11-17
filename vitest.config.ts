import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    exclude: ["tests/integration/**"],
    // Some tests spawn python3 many times; avoid flakes on a loaded machine.
    testTimeout: 30_000,
  },
});
