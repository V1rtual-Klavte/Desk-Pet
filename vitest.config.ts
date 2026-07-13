import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["src/**/__tests__/**/*.live.test.ts"],
    setupFiles: ["src/services/__tests__/helpers/setup.ts"],
    testTimeout: 30000,
  },
})
