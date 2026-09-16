import type { ModuleContract } from "../types"

export const agentRuntimeContract: ModuleContract = {
  module: "agent-runtime",
  sourceFiles: [
    "src/services/agent/runner.ts",
    "src/services/agent/memory/session-turn-store.ts",
    "src/services/agent/memory/queue-events.ts",
    "src/services/agent/memory/session-files.ts",
    "src/services/engine/runtime/queue.ts",
    "src/services/engine/runtime/agent-slot.ts",
    "src/services/engine/runtime/types.ts",
    "src/services/engine/preprocessor.ts",
    "src/services/engine/pi/runtime.ts",
    "src/services/session/manager.ts",
    "src/services/session/persistence.ts",
  ],
  generatedAt: "2026-09-16",
  sourceHash: "9be93336a5eae0189259aad236197c3eec7b69250d945dfc9e02634d07e39e0e",
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
    {
      id: "ar-04",
      feature: "会话 AgentSlot 生命周期",
      description: "主回合按 sessionId 持有 Agent、上下文、状态和 generation；会话切换不串历史，旧 generation 不能结束新 run",
      why: "模块级 Agent 引用和全局忙碌锁无法隔离不同会话，也会让迟到的异步清理释放后续回合",
      depth: "deep",
      scenarios: ["session-agent-slot-generation"],
    },
    {
      id: "ar-05",
      feature: "工具期间 steer 持久化投递",
      description: "工具执行期间的新输入先写 QueueEntry 和 queued turn，再调用 Pi steer；入口返回 queued，Agent 成功消费后才写 accepted/done，失败则隔离为 unknown_side_effect",
      why: "先调用 Pi 再落盘会在进程退出时丢失用户已经发出的方向调整",
      depth: "deep",
      scenarios: ["memory-steer-during-tool"],
    },
    {
      id: "ar-06",
      feature: "回合结束 followUp 持久化投递",
      description: "Agent 进入 settling 后的新输入以 followup 模式先持久化再投递，并保留正式回执",
      why: "自然结束边界继续使用 steer 会混淆 Pi 的队列语义并缺少可恢复状态",
      depth: "deep",
      scenarios: ["memory-followup-after-turn"],
    },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 6, requireBoundary: true, requireErrorPath: false },
}

export default agentRuntimeContract
