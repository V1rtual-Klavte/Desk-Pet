import { defineConfig } from "vitest/config"
import path from "path"
import { readFileSync, existsSync } from "node:fs"
import { load } from "js-yaml"
import type { Plugin } from "vite"

function yamlPlugin(): Plugin {
  return {
    name: "vite-plugin-yaml",
    transform(_code: string, id: string) {
      if (!id.endsWith(".yaml") && !id.endsWith(".yml")) return

      // CONFIG.yaml → 若存在同目录 CONFIG-DEV.yaml 且 enabled=true，直接用 DEV 替换
      if (id.endsWith("CONFIG.yaml")) {
        const devPath = path.resolve(path.dirname(id), "CONFIG-DEV.yaml")
        if (existsSync(devPath)) {
          const devRaw = readFileSync(devPath, "utf-8")
          const devParsed = load(devRaw) as any
          if (devParsed?.enabled === true) {
            delete devParsed.enabled
            return {
              code: `export default ${JSON.stringify(devParsed)}`,
              map: null,
            }
          }
        }
      }

      const raw = readFileSync(id, "utf-8")
      const parsed = load(raw) as any
      return {
        code: `export default ${JSON.stringify(parsed)}`,
        map: null,
      }
    },
  }
}

export default defineConfig({
  plugins: [yamlPlugin()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/live/**/*.test.ts"],
    setupFiles: ["src/services/__tests__/live/setup.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
})
