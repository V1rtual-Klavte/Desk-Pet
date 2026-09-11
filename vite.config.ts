import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { defineConfig, type Plugin } from "vite";

function yamlPlugin(): Plugin {
  return {
    name: "vite-plugin-yaml",
    transform(_code: string, id: string) {
      if (!id.endsWith(".yaml") && !id.endsWith(".yml")) return;

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
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        "layer-editor": resolve(__dirname, "layer-editor.html"),
      },
    },
  },
});
