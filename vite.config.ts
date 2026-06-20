import vue from "@vitejs/plugin-vue";
import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { load } from "js-yaml";
import { defineConfig, type Plugin } from "vite";

function yamlPlugin(): Plugin {
  return {
    name: "vite-plugin-yaml",
    transform(_code: string, id: string) {
      if (!id.endsWith(".yaml") && !id.endsWith(".yml")) return;

      // CONFIG.yaml → 若存在同目录 CONFIG-DEV.yaml 且 enabled=true，直接用 DEV 替换
      if (id.endsWith("CONFIG.yaml")) {
        const devPath = resolve(dirname(id), "CONFIG-DEV.yaml");
        if (existsSync(devPath)) {
          const devRaw = readFileSync(devPath, "utf-8");
          const devParsed = load(devRaw) as any;
          if (devParsed?.enabled === true) {
            delete devParsed.enabled;
            console.log("[Config] 使用 CONFIG-DEV.yaml 替换 CONFIG.yaml");
            return {
              code: `export default ${JSON.stringify(devParsed)}`,
              map: null,
            };
          }
        }
      }

      const raw = readFileSync(id, "utf-8");
      const parsed = load(raw) as any;
      return {
        code: `export default ${JSON.stringify(parsed)}`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [vue(), yamlPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
});