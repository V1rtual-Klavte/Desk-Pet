import type { SceneDef } from "../../types"
import { generateReply } from "@/services/reply"

/**
 * RUNTIME_DATA 的 emotion 行到表情效果的映射。
 *
 * 早先这条场景走真实模型、断言「模型一定会在 RUNTIME_DATA 里写出 emotion」。
 * 实测模型并不配合：基线连跑 4 次全红，本机累计约 9 次里只成功 1 次 ——
 * 同一次回复里 `variables` 能正常解析，唯独 `emotion` 行常常缺失。
 * 那断言的是模型当天的表现，不是引擎契约，而且它一直红着，等于没有覆盖。
 *
 * 现在改成直接喂一段带 RUNTIME_DATA 的回复给 `generateReply`（纯后处理入口）：
 * 解析、剥离、情绪映射这三步都是引擎保证的，可以确定性断言。
 * 「真实模型是否愿意写 emotion 行」仍是未覆盖项，已记在计划 §3.5。
 */
const scene: SceneDef = {
  meta: {
    caseId: "emotion-runtime-tags",
    module: "emotion",
    contractId: "em-05",
    description: "RUNTIME_DATA 的 emotion 行解析并映射为表情",
    depth: "deep",
    suite: "capability",
    entry: "unit",
    tags: ["emotion", "runtime-data"],
  },
  turns: [{
    index: 1,
    description: "带 emotion 的回复走完解析与映射",
    userText: "今天太开心了！",
    checks: [{ type: "expectRuntimeEmotion", run: async () => {
      const result = await generateReply(
        "好开心呀！\n<RUNTIME_DATA>\nemotion: happy\n</RUNTIME_DATA>",
        null,
      )

      // emotion 行是内部元数据，处理完必须从用户可见文本里消失
      if (result.text.includes("RUNTIME_DATA")) throw new Error("RUNTIME_DATA 未被剥离")
      if (!result.text.includes("好开心")) throw new Error("正文被误删")
      if (result.emotionKey !== "happy") throw new Error(`emotionKey 未解析: ${result.emotionKey}`)
      // 拿到 key 还不够：必须真的映射成表情，否则表情链路依然是断的
      if (!result.expression) throw new Error("emotionKey 没有映射出 expression")

      // 没有 RUNTIME_DATA 时不能凭空造一个 emotion，也不能崩
      const plain = await generateReply("就是普通的一句话。", null)
      if (plain.emotionKey !== null) throw new Error(`无元数据时解析出了 emotion: ${plain.emotionKey}`)
      if (!plain.expression) throw new Error("兜底路径没有给出默认表情")
    } }],
  }],
}
export default scene
