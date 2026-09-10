import type { ModuleContract } from "../types"

export const toolExecutionContract: ModuleContract = {
  module: "tool-execution",
  sourceFiles: [
    "src/services/agent/pi/runtime.ts",
    "src/services/tool/router.ts",
    "src/services/tool/registry.ts",
    "src/services/tool/local/pi-tools.ts",
    "src/services/tool/pi/harness-adapter.ts",
    "src/services/tool/pi/tauri-execution-env.ts",
    "src/services/safety/checker.ts",
    "src/services/reply/generator.ts",
  ],
  generatedAt: "2026-09-10",
  sourceHash: "c171aee1a3df370d84ed8208dfc7c84217a9ab3e7bf16aee05aa02230a2fdc32",
  coverage: [
    { id: "te-08", feature: "真 LLM 多工具调用", description: "真实 LLM 对话中先后调用多个工具", why: "端到端工具链验证", depth: "deep", scenarios: ["tool-system-info"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}
