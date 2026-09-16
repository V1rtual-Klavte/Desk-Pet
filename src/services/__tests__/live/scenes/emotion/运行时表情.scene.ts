import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"

/**
 * 运行时把 RUNTIME_DATA 的 emotion 变成表情效果。
 *
 * `情绪标签.scene.ts` 验证的是 `generateReply` 这个纯后处理入口；
 * 这条验证的是**它确实被接在 Agent Runtime 上** —— 回复里的 emotion 要一路走到
 * `ctx.output.effects`，中间断一环（比如 runtime 忘了把 runtimeData 交给 generator）
 * 单元场景是看不见的。
 *
 * 用 faux provider 固定回复，所以断言与模型表现无关。
 */
const scene: SceneDef = {
  meta: {
    caseId: "emotion-runtime-effect",
    module: "emotion",
    contractId: "em-06",
    description: "运行时把 RUNTIME_DATA emotion 映射为表情效果",
    depth: "deep",
    suite: "capability",
    tags: ["emotion", "runtime-data", "runtime"],
  },
  setup: async () => {
    installFakeProvider([
      fakeText("好开心呀！\n<RUNTIME_DATA>\nemotion: happy\n</RUNTIME_DATA>"),
      fakeText("嗯，我在听。\n<RUNTIME_DATA>\nemotion: 完全没见过的标签\n</RUNTIME_DATA>"),
    ])
  },
  turns: [
    {
      index: 1,
      description: "已知 emotion 映射为表情",
      userText: "今天太开心了！",
      checks: [
        { type: "expectReply", run: async ctx => {
          if (!ctx.output.reply.trim()) throw new Error("reply 为空")
          // 给用户看的文本里不能残留元数据
          if (ctx.output.reply.includes("RUNTIME_DATA")) throw new Error("RUNTIME_DATA 泄漏到用户可见文本")
        } },
        { type: "expectRuntimeEmotion", run: async ctx => {
          if (ctx.output.runtimeData?.emotionKey !== "happy") {
            throw new Error(`运行时未解析出 emotionKey: ${ctx.output.runtimeData?.emotionKey}`)
          }
          const effect = ctx.output.effects[ctx.output.effects.length - 1]
          if (!effect?.expression) throw new Error("emotion 没有产生带 expression 的效果")
        } },
      ],
    },
    {
      index: 2,
      description: "未知 emotion 走兜底而不是中断",
      userText: "随便聊两句",
      checks: [
        { type: "expectReply", run: async ctx => {
          if (!ctx.output.reply.trim()) throw new Error("reply 为空")
        } },
        { type: "expectRuntimeEmotion", run: async ctx => {
          // 模型给出未定义标签是常态，必须回落到默认表情而不是抛错或空效果
          const effect = ctx.output.effects[ctx.output.effects.length - 1]
          if (!effect?.expression) throw new Error("未识别的 emotion 没有回落到默认表情")
        } },
      ],
    },
  ],
}

export default scene
