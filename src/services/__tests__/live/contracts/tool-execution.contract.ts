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
    "src/services/agent/provider.ts",
  ],
  generatedAt: "2026-09-15",
  sourceHash: "aeb42b1bd6d980d4ac3691e8ae93bf8d2e027871a0dc0831676aafffcfb95070",
  coverage: [
    { id: "te-08", feature: "真 LLM 多工具调用", description: "真实 LLM 对话中先后调用多个工具", why: "端到端工具链验证", depth: "deep", scenarios: ["tool-system-info"] },
    { id: "te-09", feature: "Provider 网络边界", description: "Provider 拒绝非 HTTP 协议并限制响应体", why: "避免网络策略绕过和内存失控", depth: "shallow", scenarios: ["tool-provider-network-boundary"] },
    { id: "te-10", feature: "工具取消错误码", description: "已取消的工具调用不进入 handler 且返回稳定错误码", why: "取消必须可观测且不可产生副作用", depth: "shallow", scenarios: ["tool-cancelled"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}
