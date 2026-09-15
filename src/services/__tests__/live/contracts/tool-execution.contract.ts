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
  generatedAt: "2026-09-14",
  sourceHash: "9e6901c0481b3f118a28eea91e1a09508af9d08ccca06ae61151808d8837c947",
  coverage: [
    { id: "te-08", feature: "真 LLM 多工具调用", description: "真实 LLM 对话中先后调用多个工具", why: "端到端工具链验证", depth: "deep", scenarios: ["tool-system-info"] },
    { id: "te-09", feature: "Provider 网络边界", description: "Provider 拒绝非 HTTP 协议并限制响应体", why: "避免网络策略绕过和内存失控", depth: "shallow", scenarios: ["tool-provider-network-boundary"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}
