import type { ModuleContract } from "../types"

export const agentRuntimeContract: ModuleContract = {
  module: "agent-runtime",
  sourceFiles: [
    "src/services/agent/runner.ts",
    "src/services/agent/memory/session-turn-store.ts",
    "src/services/engine/runtime/queue.ts",
    "src/services/engine/preprocessor.ts",
    "src/services/engine/pi/runtime.ts",
    "src/services/session/manager.ts",
    "src/services/session/persistence.ts",
  ],
  generatedAt: "2026-09-15",
  sourceHash: "d8a6e72fc1aee182c0d607432d88d397b724fad4709d2c5aecfd42a307ee131e",
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
    {
      id: "ar-03",
      feature: "后台队列消费",
      description: "当前回合结束后自动消费同会话 persisted/requeued 消息，通过 CAS 记录 queued 到 done 的 turn 状态，且不重复写入用户事实",
      why: "只持久化不 drain 会让忙碌期间的用户输入永久停留在队列中",
      depth: "deep",
      scenarios: ["queued-drain-after-turn"],
    },
  ],
  rules: { minScenarios: 3, minDeepScenarios: 3, requireBoundary: true, requireErrorPath: false },
}

export default agentRuntimeContract
