import type { ModuleContract } from "../types"

export const agentRuntimeContract: ModuleContract = {
  module: "agent-runtime",
  sourceFiles: ["src/services/agent/runner.ts", "src/services/agent/pi/runtime.ts"],
  generatedAt: "2026-09-09",
  sourceHash: "b4bfbc356d1c0557bde37ba91743737c037b0590e62cffadf9603ddb9e8a6df9",
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
