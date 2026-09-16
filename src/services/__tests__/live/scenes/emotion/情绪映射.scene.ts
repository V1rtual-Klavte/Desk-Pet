import type { SceneDef } from "../../types"
import { formatEmotionForPrompt, parseEmotionMappings, resolveEmotion } from "@/services/personality/emotion"

/**
 * 情绪映射的三个纯函数（解析 / 解析结果查询 / prompt 格式化）零运行时依赖：
 * 不碰 Tauri、不读磁盘、不需要 Provider。
 *
 * 因此统一 `entry: "unit"` —— 让它们去跑一次真实 LLM 只会把「正则写对没有」
 * 这件事的成功率绑到网络上。真正端到端的部分由 em-05 的 `emotion-runtime-tags` 负责。
 */
const unit = (caseId: string, contractId: string, description: string, run: () => void): SceneDef => ({
  meta: {
    caseId,
    module: "emotion",
    contractId,
    description,
    depth: "shallow",
    suite: "capability",
    entry: "unit",
    tags: ["emotion", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description,
    userText: "检查情绪映射。",
    checks: [{ type: "expectEmotion", run: async () => run() }],
  }],
})

/** 真实 Card 里「情绪表达」区块的形态：说明行以 `- ` 开头，映射行靠缩进 */
const CARD_EMOTION_BLOCK = [
  "- 回复末尾附加 `<RUNTIME_DATA>` 区块，emotion 行必填，系统会自动剥离",
  "- 可用标签及映射（key → 表情 ID, 音效 key）：",
  "  happy → smile, —",
  "  chu → chu, reply",
  "  sleepy → sleepy",
  "",
  "这一行没有箭头，应该被忽略",
].join("\n")

export const 情绪映射解析 = unit("emotion-map-resolve", "em-01", "resolveEmotion 按 card 映射解析", () => {
  const mappings = parseEmotionMappings(CARD_EMOTION_BLOCK)

  // card 里定义的 key 必须命中 card 自己的表达与音效
  const chu = resolveEmotion("chu", mappings)
  if (chu.expression !== "chu") throw new Error(`chu 的 expression 应为 chu，实际 ${chu.expression}`)
  if (chu.sound !== "reply") throw new Error(`chu 的 sound 应为 reply，实际 ${chu.sound}`)

  // card 映射优先于系统默认表：happy 在两边都有，取 card 的
  const happy = resolveEmotion("happy", mappings)
  if (happy.expression !== "smile") throw new Error(`happy 的 expression 应为 smile，实际 ${happy.expression}`)

  // 空映射数组时也不能崩，仍走系统默认表
  if (resolveEmotion("chu", []).expression !== "chu") throw new Error("空映射时未回落到系统默认表")
})

export const 情绪映射兜底 = unit("emotion-map-fallback", "em-02", "resolveEmotion 未识别 key 的兜底", () => {
  // 1) 未传 key：直接给最中性的结果，不查表
  const empty = resolveEmotion(null, [])
  if (empty.expression !== "smile" || empty.sound !== null) {
    throw new Error(`null key 应回落到 smile/null，实际 ${empty.expression}/${empty.sound}`)
  }

  // 2) card 没定义但属于系统默认表：命中默认表，不是最终兜底
  const known = resolveEmotion("angry", [])
  if (known.expression !== "gaoo") throw new Error(`系统默认表未命中 angry，实际 ${known.expression}`)

  // 3) 两边都没有：回落到 smile/null，而不是抛错或返回 undefined
  const unknown = resolveEmotion("完全不存在的标签", [])
  if (unknown.expression !== "smile" || unknown.sound !== null) {
    throw new Error(`未知 key 应回落到 smile/null，实际 ${unknown.expression}/${unknown.sound}`)
  }
})

export const 情绪映射解析格式 = unit("emotion-map-parse", "em-03", "parseEmotionMappings 解析 card 格式", () => {
  const mappings = parseEmotionMappings(CARD_EMOTION_BLOCK)

  // 说明行（以 "- " 开头）与无箭头行都要被丢掉，只剩三条真实映射
  if (mappings.length !== 3) {
    throw new Error(`应解析出 3 条映射，实际 ${mappings.length}: ${JSON.stringify(mappings)}`)
  }

  const byKey = new Map(mappings.map(m => [m.key, m]))
  // 破折号代表「无音效」，要归一成 null 而不是字符串
  if (byKey.get("happy")?.sound !== null) throw new Error("happy 的 — 未归一为 null")
  if (byKey.get("chu")?.sound !== "reply") throw new Error("chu 的音效未解析")
  // 省略音效字段时按同一规则补 null
  if (byKey.get("sleepy")?.sound !== null) throw new Error("缺省音效未归一为 null")
  if (byKey.get("sleepy")?.expression !== "sleepy") throw new Error("sleepy 的表情未解析")

  // 空输入与全噪音输入都应得到空数组，而不是抛错
  if (parseEmotionMappings("").length !== 0) throw new Error("空输入应得到空数组")
  if (parseEmotionMappings("没有箭头的行\n- 说明行").length !== 0) throw new Error("无映射行应得到空数组")
})

export const 情绪映射提示词 = unit("emotion-map-prompt", "em-04", "formatEmotionForPrompt 生成 RUNTIME_DATA 规则", () => {
  // 空映射是必须覆盖的边界：没有可用标签时不注入任何文本
  if (formatEmotionForPrompt([]) !== "") throw new Error("空映射应返回空字符串")

  const text = formatEmotionForPrompt(parseEmotionMappings(CARD_EMOTION_BLOCK))
  for (const required of ["<RUNTIME_DATA>", "emotion", "happy", "chu", "sleepy"]) {
    if (!text.includes(required)) throw new Error(`规则文本缺少 ${required}`)
  }
  // 有音效的标签把音效并进括号，无音效的只留表情
  if (!text.includes("chu(chu,reply)")) throw new Error(`带音效的标签格式不对: ${text}`)
  if (!text.includes("happy(smile)")) throw new Error(`无音效的标签不应出现多余分隔: ${text}`)
})
