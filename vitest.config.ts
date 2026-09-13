import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests boot a real HTTP server (and, from P1 on, a real browser).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
