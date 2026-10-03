import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { yamlPlugin } from "./vite-yaml-plugin";

/**
 * 重试入口（scripts/run-vitest-with-retry.mjs）需要**机器可读**的逐用例结果才能
 * 比对两次运行、定位波动用例，因此经这个环境变量注入 json reporter 的输出路径。
 * 为什么不在入口脚本里用 CLI `--reporter=json`：CLI 会**整体替换** reporters 清单，
 * 把 caseId 收集器（即 L2/L3 各层的契约门禁）一起挤掉；在这里按需追加，reporter
 * 清单只有一份定义，普通运行（不设置该变量）的行为一个字都不变。
 */
const retryJsonOutput = process.env.DESKPET_VITEST_JSON_OUT;

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
      // 适配层已存在：test/host/node-ipc.ts 按 Rust `#[tauri::command]` 签名逐条复现
      // IPC 命令的 Node 等价实现，node-path.ts / node-event.ts 分别顶替 path / event。
      // 只复现机制、不做策略：路径裁决、Bash 基线与许可配额等 Rust 专有命令命中即抛
      // UnsupportedInNodeError（见 test/host/unsupported.ts），让相应场景明确留在 L4。
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
    reporters: [
      "default",
      resolve(__dirname, "test/host/caseid-reporter.ts"),
      ...(retryJsonOutput ? [["json", { outputFile: retryJsonOutput }]] : []),
    ],
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
