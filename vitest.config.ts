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

/**
 * L2/L3 的宿主桥安装点。`@/services/host` 的取用口只认 bootstrap 注入（无懒默认、
 * 无降级链），而 vitest 没有 bootstrap —— 由这个 setupFiles 在每个测试文件运行前
 * 注入「Node 测试宿主的桥」：`test/host/node-host-bridge.ts` 直接调用
 * test/host/node-ipc.ts 的命令面，不经过 `@tauri-apps/*`、也不是真宿主连接
 * （为什么、以及数据根不在那里设，见 install-node-bridge.ts 文件头）。
 * 两个 project 共用同一常量：安装点只有一份定义，路径不写两遍。
 */
const nodeHostSetupFiles = [resolve(__dirname, "test/host/install-node-bridge.ts")];

export default defineConfig({
  // 快层测试会 import `@/services/config` 等产品链路模块，它们直接 import `.yaml`。
  // 缺这个插件时 YAML 解析失败，表现是「一 import 配置就红」。
  plugins: [yamlPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // 宿主桥（test/host/node-host-bridge.ts）已不再经过这里：它直接调用
      // node-ipc 的命令面。这三条别名只服务于**尚未迁移**的旧说明符直连
      // （L4 场景 / memory 适配器 / host 观测设施与少量 L2/L3 用例里的
      // `@tauri-apps/api/*` import，清单见交付报告）。迁移完成前删掉别名会让这些
      // import 落到真 `@tauri-apps/api`（Node 下不可用；包删除后直接解析失败），
      // 所以删除别名必须与消费者迁移在同一改动里完成。
      //
      // 适配层本身：test/host/node-ipc.ts 按 Rust `#[tauri::command]` 签名逐条复现
      // IPC 命令的 Node 等价实现，node-path.ts / node-event.ts 分别顶替 path / event。
      // 只复现机制、不做策略：路径裁决、Bash 基线与许可配额等 Rust 专有命令命中即抛
      // UnsupportedInNodeError（见 test/host/unsupported.ts），让相应场景明确留在 L4。
      "@tauri-apps/api/core": resolve(__dirname, "test/host/node-ipc.ts"),
      "@tauri-apps/api/path": resolve(__dirname, "test/host/node-path.ts"),
      "@tauri-apps/api/event": resolve(__dirname, "test/host/node-event.ts"),
      // node:assert/strict 的别名已删除：vitest 两个 project 都是 node 环境，内建模块
      // 直接解析，无需 shim；唯一在 vitest 树里的消费者（pi 官方一致性套件）拿到真实
      // 内建实现只会更严格。shim 本体与 vite.config.ts 的别名保留 —— 那是原生 bundle
      // 的依赖树（evaluation 的 L4 场景），不在 vitest 配置的职责里。
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
          setupFiles: nodeHostSetupFiles,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: nodeHostSetupFiles,
        },
      },
    ],
  },
});
