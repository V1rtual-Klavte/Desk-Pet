import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { yamlPlugin } from "./vite-yaml-plugin";

export default defineConfig({
  // 快层测试会 import `@/services/config` 等产品链路模块，它们直接 import `.yaml`。
  // 缺这个插件时 YAML 解析失败，表现是「一 import 配置就红」。
  plugins: [yamlPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // L2/L3 用 Node 适配层顶替 Tauri IPC。分开三条是因为 pi 的子路径
      // 导出与主入口的解析路径不同，只写包名会漏掉子路径。
      //
      // 注意：test/host/node-ipc.ts / node-path.ts / node-event.ts 目前**尚不存在**
      // （由后续任务创建）。别名只是路径映射，指向不存在的文件不会在配置加载时
      // 报错；但如果某个测试真的 import 到其中一条，运行时会立刻报「模块不存在」
      // —— 这是预期行为，不是配置坏了。
      "@tauri-apps/api/core": resolve(__dirname, "test/host/node-ipc.ts"),
      "@tauri-apps/api/path": resolve(__dirname, "test/host/node-path.ts"),
      "@tauri-apps/api/event": resolve(__dirname, "test/host/node-event.ts"),
      "node:assert/strict": resolve(__dirname, "test/host/shims/node-assert-strict.ts"),
    },
  },
  test: {
    // caseId 收集器接在**根级**而不是 project 上：`reporters` 是 vitest 的运行级选项
    // （vitest 5 的 NonProjectOptions，project 配置不接受它）。收集器按
    // `testCase.project.name` 分桶，两个 project（unit / integration）各写各的
    // `test/reports/caseids-<project>.json`。
    reporters: ["default", resolve(__dirname, "test/host/caseid-reporter.ts")],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
