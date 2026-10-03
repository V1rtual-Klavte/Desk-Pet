import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { yamlPlugin } from "./vite-yaml-plugin";

export default defineConfig({
  plugins: [vue(), yamlPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // 官方一致性套件（@earendil-works/pi-agent-core/harness/session/testing）
      // 在模块顶层 import node:assert/strict；浏览器构建会把它 externalize 成
      // 「访问即抛错」的代理，连带整个 E2E 窗口加载失败。这里换成只实现
      // 套件实际用到的断言的本地 shim：没有生产代码 import 这个内建模块，
      // 别名只影响 E2E 依赖树，也不新增依赖。
      "node:assert/strict": resolve(__dirname, "test/host/shims/node-assert-strict.ts"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    // A Live batch must keep the same loaded code; HMR would reset its trace cursor mid-trial.
    hmr: process.env.DESKPET_E2E === "1" ? false : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  build: {
    // 只列产品窗口。test-e2e.html 不进 build input：E2E 全程由 `tauri dev` 走 devUrl，
    // Vite dev server 服务根目录下所有 HTML，不需要它出现在产物里；而 release 构建下
    // `lib.rs` 的 `cfg!(debug_assertions) && is_e2e()` 恒为 false，e2e 窗口永不创建，
    // 打进去就是纯死重（实测 463 KB，占前端 JS 的 24%）。
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        "layer-editor": resolve(__dirname, "layer-editor.html"),
      },
    },
  },
});
