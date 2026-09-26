import { buildPrompt, CHAT_THINKING_HINTS, composeDynamicPrompt, estimateContextTokens, ONE_SHOT_LOW_EFFORT_HINT } from "@/services/context"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import type { VariablePool } from "@/services/personality/variable-pool"
import type { SceneDef } from "../../types"

/** 最小变量池：这里校验的是拼接口径，池正文内容不参与断言。 */
const POOL: VariablePool = { system: {}, card: {}, interaction: {} }

/** 时间片段的格式与定长（26 字符）是断言对象本身，这里按形态写死，不复用生产实现。 */
const TIME_NOTE_PATTERN = /\[当前时间\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]$/
const TIME_NOTE_LENGTH = 26
const TIME_MARKER = "[当前时间]"
/** 允许的墙上时钟漂移：覆盖跨分钟边界与调度延迟，但排除「固定串 / 旧时间」。 */
const TIME_DRIFT_TOLERANCE_MS = 90_000

/** 取末尾的时间片段，并按「它是现在的时刻」判定（分钟精度）。 */
function takeTimeNote(composed: string, what: string): string {
  const match = composed.match(TIME_NOTE_PATTERN)
  if (!match) throw new Error(`${what} 末尾不是定长时间片段: ${JSON.stringify(composed)}`)
  const note = match[0]
  if (note.length !== TIME_NOTE_LENGTH) {
    throw new Error(`${what} 的时间片段不是 ${TIME_NOTE_LENGTH} 字符（实际 ${note.length}）: ${JSON.stringify(note)}`)
  }
  // 本地时间口径与生产实现一致（两边都用本机时区的年月日时分）。
  const digits = note.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
  if (!digits) throw new Error(`${what} 的时间片段无法解析: ${JSON.stringify(note)}`)
  const at = new Date(
    Number(digits[1]), Number(digits[2]) - 1, Number(digits[3]), Number(digits[4]), Number(digits[5]),
  ).getTime()
  const drift = Math.abs(at - Date.now())
  if (drift > TIME_DRIFT_TOLERANCE_MS) {
    throw new Error(`${what} 的时间片段不是当前时刻（漂移 ${Math.round(drift / 1000)}s）: ${JSON.stringify(note)}`)
  }
  return note
}

// 动态提示的文案此前散在三处（context/builder、engine/pi/runtime、engine/pi/model-gateway）：
// 改一处就分叉，而且没有任何断言拦它。这个场景钉住「只有一处定义」这件事本身，
// 以及决策 12 加进来的「末尾定长当前时间」（分钟精度、排在最后、只进动态层）的拼接口径。
export const 提示文案: SceneDef = {
  meta: {
    caseId: "memory-prompt-composition",
    module: "memory",
    contractId: "mm-29",
    description: "动态提示只有一处拼接（变量池正文 + 强度后缀 + 末尾定长当前时间）：时间片段进 dynamic:runtime 块、不进静态前缀；一次性调用的低强度兜底提示是另一个常量",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "context", "boundary"],
  },
  turns: [{
    index: 1,
    description: "校验拼接口径、时间片段的形态与层次归属、两个用途的文案差异与 buildPrompt 的真实接线",
    userText: "校验动态提示文案的唯一定义点。",
    checks: [{
      type: "expectDynamicPromptSingleDefinition",
      run: async () => {
        const poolText = formatPoolForPrompt(POOL)

        // 1. 拼接口径：low/high 各带自己的后缀，其余档位只追加时间片段 —— 三档都是
        //    「池正文 [+ 强度后缀] + 换行 + 定长时间片段」，时间排在末尾（前缀缓存收益留给池正文）。
        const low = composeDynamicPrompt(poolText, "low")
        const lowNote = takeTimeNote(low, "low 档")
        if (low !== `${poolText}${CHAT_THINKING_HINTS.low}\n${lowNote}`) {
          throw new Error(`低强度提示拼接不正确: ${JSON.stringify(low)}`)
        }
        const high = composeDynamicPrompt(poolText, "high")
        const highNote = takeTimeNote(high, "high 档")
        if (high !== `${poolText}${CHAT_THINKING_HINTS.high}\n${highNote}`) {
          throw new Error(`高强度提示拼接不正确: ${JSON.stringify(high)}`)
        }
        for (const effort of ["auto", "medium"] as const) {
          const composed = composeDynamicPrompt(poolText, effort)
          const note = takeTimeNote(composed, `${effort} 档`)
          if (composed !== `${poolText}\n${note}`) {
            throw new Error(`${effort} 档位只应追加时间片段: ${JSON.stringify(composed)}`)
          }
          if (composed.length !== poolText.length + 1 + TIME_NOTE_LENGTH) {
            throw new Error(`${effort} 档位的时间片段不是定长: ${composed.length} 字符`)
          }
        }

        // 2. 两个用途的文案必须不同：一次性调用是「端点不认 reasoning_effort」的兜底，
        //    聊天提示是回合的强度指令，合并会让其中一边失去自己的语义。
        if (ONE_SHOT_LOW_EFFORT_HINT === CHAT_THINKING_HINTS.low) {
          throw new Error("一次性调用的低强度提示与聊天提示相同，两个用途的语义被合并了")
        }
        if (estimateContextTokens(ONE_SHOT_LOW_EFFORT_HINT) <= 0) {
          throw new Error("一次性调用的低强度提示估算为 0 token")
        }
        // 一次性调用不出现时间片段：`completePiText` 对系统提示只做一件事 —— 非推理模型 + low
        // 时追加这个常量，它自身不带时间片段；时间片段的唯一生产者是 composeDynamicPrompt。
        if (ONE_SHOT_LOW_EFFORT_HINT.includes(TIME_MARKER)) {
          throw new Error("一次性调用的兜底提示里出现了时间片段，一次性请求会被注入当前时间")
        }

        // 3. 接线与层次：常量被真实消费（不是死导出），且时间片段落在 dynamic 层的运行时块里，
        //    static 前缀（缓存身份）里不能出现它。
        const built = buildPrompt({
          thinkingEffort: "high",
          tools: [],
          contextMaxTokens: 131_072,
          candyInstructions: "",
          userProfileText: "",
          skillsPromptBlock: "",
        }, null, POOL)
        if (!built.systemPrompt.includes(CHAT_THINKING_HINTS.high)) {
          throw new Error("buildPrompt 的系统提示没有消费 CHAT_THINKING_HINTS.high")
        }
        const dynamicBlock = built.blocks.find(block => block.blockId === "dynamic:runtime")
        if (!dynamicBlock) throw new Error("buildPrompt 没有产出 dynamic:runtime 块")
        takeTimeNote(dynamicBlock.text, "dynamic:runtime 块")
        for (const block of built.blocks) {
          if (block.layer === "static" && block.text.includes(TIME_MARKER)) {
            throw new Error(`时间片段进了静态块 ${block.blockId}（静态成分必须保持不变）`)
          }
        }
        if (built.staticPrefix.includes(TIME_MARKER)) {
          throw new Error("时间片段进了 staticPrefix（静态前缀是缓存身份的一部分，不能每回合变化）")
        }
      },
    }],
  }],
}

export default 提示文案
