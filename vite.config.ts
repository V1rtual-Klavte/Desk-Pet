import { resolve } from "node:path";
import { defineConfig } from "vite";
import { yamlPlugin } from "./vite-yaml-plugin";

// Vite 在本仓只剩一个消费者：`test/host/native/build.mjs` 的 `viteBuild()`（configFile
// 指向本文件），把 L4 场景/契约打成 Node 单文件 bundle。产品窗口、dev server 与端口
// 真相源随旧壳一并删除：没有 HTML 入口，也没有任何进程监听 HTTP 端口（Live 宿主由
// 启动脚本直接 spawn native-host，经私有测试通道通信）。本文件保留的插件与别名是
// 该 SSR bundle 的构建输入；若将来重新引入 dev server，端口需要当场定义新的单一来源。
export default defineConfig({
  plugins: [yamlPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
