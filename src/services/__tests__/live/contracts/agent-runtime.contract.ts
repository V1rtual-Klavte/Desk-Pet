import type { ModuleContract } from "../types"

export const agentRuntimeContract: ModuleContract = {
  module: "agent-runtime",
  sourceFiles: ["src/services/agent/runner.ts", "src/services/agent/pi/runtime.ts"],
  generatedAt: "2026-09-09",
  sourceHash: "6a80be50a7279a855acedc5f5ee05f8e4c1e771ff59db56b952fd842b1b5331b",
  coverage: [
    {
      id: "ar-01",
      feature: "生产消息入口",
      description: "sendMessage 完整经过预处理、会话持久化、Pi runtime 和 UI 回复写入",
      why: "直接调用 Pi runtime 不能证明桌宠实际聊天入口仍然可用",
      depth: "deep",
      scenarios: ["production-chat-entry"],
    },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}

export default agentRuntimeContract
