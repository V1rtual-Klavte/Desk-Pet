import type { SceneDef } from "../../types"
import { initChat } from "@/services/agent/runner"
import { getActiveCard, getActivePersonalityId } from "@/services/personality/registry"

/**
 * 真·生产入口：走 `sendMessage()` 跑完整链路（预处理 → Card → Prompt → Pi → 回复生成）。
 *
 * 这条是 personality-card 契约里唯一驱动真实模型与生产入口的场景。
 * Card 的解析细节由 `卡片解析.scene.ts` 的 unit 场景覆盖，这里负责回答
 * 那些 unit 场景回答不了的问题：**加载好的 Card 是否真的接进了生产回合**。
 */
const scene: SceneDef = {
  meta: {
    caseId: "card-production-turn",
    module: "personality-card",
    contractId: "pc-08",
    description: "生产入口下的激活 Card",
    depth: "deep",
    suite: "capability",
    entry: "production",
    tags: ["personality-card", "capability"],
  },
  // 必须初始化会话：`sendMessage` 第一步就要把 queued 事件落盘，
  // 而 standardSetup 每个场景都会清掉会话文件。少了这一步，
  // 失败信息长成「queued 事件落盘失败」，看起来像持久化坏了，其实是会话根本没建。
  setup: async () => { await initChat() },
  turns: [{
    index: 1,
    description: "sendMessage 走完生产链路",
    userText: "你好，用一句话说明你是谁。",
    checks: [{ type: "expectProductionTurn", run: async ctx => {
      if (!ctx.output.reply.trim()) throw new Error("生产入口没有返回回复")

      // 回合跑完 Card 不能丢：getActiveCard 抛错或变 null 意味着运行时把人设弄丢了
      const card = getActiveCard()
      if (!card) throw new Error("生产回合结束后激活 Card 消失")
      if (getActivePersonalityId() !== card.id) throw new Error("activeId 与激活 Card 不一致")

      // 会话确实推进了，说明回复是真的走完链路写回去的，而不是短路返回
      if (ctx.memory.sessionTurnCount < 1) throw new Error("生产回合没有写入会话记录")
    } }],
  }],
}

export default scene
