import type { ModuleContract } from "../types"

export const toolExecutionContract: ModuleContract = {
  module: "tool-execution",
  sourceFiles: [
    "src/services/engine/pi/runtime.ts",
    "src/services/tool/router.ts",
    "src/services/tool/registry.ts",
    "src/services/tool/local/pi-tools.ts",
    "src/services/tool/pi/harness-adapter.ts",
    "src/services/tool/pi/tauri-execution-env.ts",
    "src/services/safety/checker.ts",
    "src/services/reply/generator.ts",
  ],
  generatedAt: "2026-09-14",
  sourceHash: "4f6c3f16ad5eda5a7d21bd1a176f30a07c27aeefb1357c8cfdf131678f3a9279",
  coverage: [
    { id: "te-08", feature: "真 LLM 多工具调用", description: "真实 LLM 对话中先后调用多个工具", why: "端到端工具链验证", depth: "deep", scenarios: ["tool-system-info"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}
