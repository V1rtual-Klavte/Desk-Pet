// ==========================================
// Live Test Scene: 亲密度提升 → Card变量 LLM写入
// ==========================================
import type { SceneDef } from "../types"

export const 亲密度提升: SceneDef = {
  meta: {
    module: "variable-pool", contractId: "vp-04",
    description: "用户夸奖 → LLM 更新亲密度和心情",
    depth: "deep", tags: ["variable-pool", "card", "var_write"],
  },
  turns: [
    {
      index: 1, description: "用户夸奖", userText: "你今天好可爱呀！",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply || ctx.output.reply.length === 0) throw new Error("reply 为空"); } },
        { type: "expectEmotion", run: async (ctx) => {
          const key = (ctx.output as any).emotionKey || (ctx.output.reply.match(/\[emo:(\w+)\]/)?.[1])
          if (!key) throw new Error("没有情绪标签")
          if (!["happy","chu","shy","smile"].some(k => key === k || key.includes(k))) throw new Error(`emotionKey=${key} 不在预期范围`)
        }},
        { type: "expectVar_亲密度_after_praise", run: async (ctx) => {
          const v = ctx.pool.card["亲密度"]
          if (!v) throw new Error("亲密度变量不存在")
          if (typeof v.value !== "number") throw new Error("亲密度不是数字")
          if (v.value < 3) throw new Error(`亲密度=${v.value} 应 >= 3(初始值)`)
          if (v.updatedBy !== "llm") throw new Error(`亲密度 updatedBy=${v.updatedBy} 应为 llm`)
        }},
      ],
    },
    {
      index: 2, description: "继续夸奖", userText: "真的超级可爱！最喜欢你了！",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply || ctx.output.reply.length === 0) throw new Error("reply 为空"); } },
        { type: "expectVar_亲密度_continue", run: async (ctx) => {
          const v = ctx.pool.card["亲密度"]
          if (!v || typeof v.value !== "number") throw new Error("亲密度无效")
          if (v.value < 4) throw new Error(`亲密度=${v.value} 连续夸奖后应更高`)
        }},
      ],
    },
    {
      index: 3, description: "泼冷水", userText: "其实也就一般般吧",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply || ctx.output.reply.length === 0) throw new Error("reply 为空"); } },
        { type: "expectVar_心情_change", run: async (ctx) => {
          const v = ctx.pool.card["心情"]
          if (!v) throw new Error("心情变量不存在")
          if (typeof v.value !== "string" || v.value.length === 0) throw new Error("心情无效")
        }},
      ],
    },
  ],
}
export default 亲密度提升
