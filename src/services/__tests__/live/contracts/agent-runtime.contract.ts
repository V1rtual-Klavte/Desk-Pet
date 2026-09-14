import type { ModuleContract } from "../types"

export const agentRuntimeContract: ModuleContract = {
  module: "agent-runtime",
  sourceFiles: [
    "src/services/agent/runner.ts",
    "src/services/engine/preprocessor.ts",
    "src/services/engine/pi/runtime.ts",
    "src/services/session/manager.ts",
    "src/services/session/persistence.ts",
  ],
  generatedAt: "2026-09-14",
  sourceHash: "7d0c12f9321b664be3f744e913a4c851a6ad7d0ed8202045151b2e7d80f40b3a",
  coverage: [
    {
      id: "ar-01",
      feature: "生产消息入口",
      description: "sendMessage 完整经过预处理、Markdown 会话持久化、Pi runtime 和 UI 回复写入；重启读取不丢失正文",
      why: "直接调用 Pi runtime 不能证明桌宠实际聊天入口仍然可用",
      depth: "deep",
      scenarios: ["production-chat-entry"],
    },
    {
      id: "ar-02",
      feature: "队列化生产入口",
      description: "sendMessage 先写 queued 事件，再 dispatch Pi，并写入 accepted ack",
      why: "崩溃恢复和重复请求依赖 queued 事实先于副作用落盘",
      depth: "deep",
      scenarios: ["queued-before-dispatch"],
    },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}

export default agentRuntimeContract
