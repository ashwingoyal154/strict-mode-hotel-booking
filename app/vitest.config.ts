import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
