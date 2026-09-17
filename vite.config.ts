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
      // 官方一致性套件（@earendil-works/pi-agent-core/harness/session/testing）
      // 在模块顶层 import node:assert/strict；浏览器构建会把它 externalize 成
      // 「访问即抛错」的代理，连带整个 Live Test 窗口加载失败。这里换成只实现
      // 套件实际用到的断言的本地 shim：没有生产代码 import 这个内建模块，
      // 别名只影响 Live Test 依赖树，也不新增依赖。
      "node:assert/strict": resolve(__dirname, "src/services/__tests__/live/shims/node-assert-strict.ts"),
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
