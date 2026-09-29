import { buildPrompt, CHAT_THINKING_HINTS, composeDynamicPrompt, currentTimeNote, estimateContextTokens, ONE_SHOT_LOW_EFFORT_HINT } from "@/services/context"
import { createTurnNoteMessage } from "@/services/engine/pi"
import { isTransientInputMessage, TURN_NOTE_CUSTOM_TYPE } from "@/services/engine/runtime"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import type { VariablePool } from "@/services/personality/variable-pool"
import type { SceneDef } from "../../../host/types"

/** 最小变量池：这里校验的是拼接口径，池正文内容不参与断言。 */
const POOL: VariablePool = { system: {}, card: {}, interaction: {} }

/** 时间片段的格式与定长（26 字符）是断言对象本身，这里按形态写死，不复用生产实现。 */
const TIME_NOTE_PATTERN = /^\[当前时间\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]$/
const TIME_NOTE_LENGTH = 26
const TIME_MARKER = "[当前时间]"
/** 允许的墙上时钟漂移：覆盖跨分钟边界与调度延迟，但排除「固定串 / 旧时间」。 */
const TIME_DRIFT_TOLERANCE_MS = 90_000

/** 按「它是现在的时刻」判定时间片段（分钟精度），并核对定长。 */
function checkTimeNote(note: string, what: string): void {
  if (!TIME_NOTE_PATTERN.test(note)) {
    throw new Error(`${what} 不是定长时间片段: ${JSON.stringify(note)}`)
  }
  if (note.length !== TIME_NOTE_LENGTH) {
    throw new Error(`${what} 不是 ${TIME_NOTE_LENGTH} 字符（实际 ${note.length}）: ${JSON.stringify(note)}`)
  }
  // 本地时间口径与生产实现一致（两边都用本机时区的年月日时分）。
  const digits = note.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
  if (!digits) throw new Error(`${what} 无法解析: ${JSON.stringify(note)}`)
  const at = new Date(
    Number(digits[1]), Number(digits[2]) - 1, Number(digits[3]), Number(digits[4]), Number(digits[5]),
  ).getTime()
  const drift = Math.abs(at - Date.now())
  if (drift > TIME_DRIFT_TOLERANCE_MS) {
    throw new Error(`${what} 不是当前时刻（漂移 ${Math.round(drift / 1000)}s）: ${JSON.stringify(note)}`)
  }
}

// 动态提示的文案此前散在三处（context/builder、engine/pi/runtime、engine/pi/model-gateway）：
// 改一处就分叉，而且没有任何断言拦它。这个场景钉住「只有一处定义」这件事本身。
//
// 当前时间的落位在本轮变更：它此前拼在 `composeDynamicPrompt` 末尾、落在 dynamic:runtime
// 块里。但 system prompt 整体排在会话正文之前，任何每回合变化的内容留在那里都会让前缀缓存
// 断在正文上游 —— 整个会话正文每轮重新计费。现在它改由 `createTurnNoteMessage` 作为尾随
// 瞬时消息附在请求视图最末，**system prompt 里一个字符都不该有**。这个场景同时钉住
// 「动态提示只剩池正文 + 强度后缀」与「注记的形状与瞬时身份」。
export const 提示文案: SceneDef = {
  meta: {
    caseId: "memory-prompt-composition",
    module: "memory",
    contractId: "mm-29",
    description: "动态提示只有一处拼接（变量池正文 + 强度后缀，不含时间）；当前时间改由尾随瞬时注记承载，system prompt 内不得出现它；注记是 custom 消息且按瞬时输入归类；一次性调用的低强度兜底提示是另一个常量",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "context", "boundary"],
  },
  turns: [{
    index: 1,
    description: "校验拼接口径、时间片段的形态与取用点、注记的瞬时身份，以及 buildPrompt 产出的 system prompt 不含时间",
    userText: "校验动态提示文案的唯一定义点。",
    checks: [{
      type: "expectDynamicPromptSingleDefinition",
      run: async () => {
        const poolText = formatPoolForPrompt(POOL)

        // 1. 拼接口径：low/high 各带自己的后缀，其余档位原样返回池正文。
        //    三档都**不带**时间片段 —— 时间不在 system prompt 里（见下方第 3 步）。
        if (composeDynamicPrompt(poolText, "low") !== `${poolText}${CHAT_THINKING_HINTS.low}`) {
          throw new Error(`低强度提示拼接不正确: ${JSON.stringify(composeDynamicPrompt(poolText, "low"))}`)
        }
        if (composeDynamicPrompt(poolText, "high") !== `${poolText}${CHAT_THINKING_HINTS.high}`) {
          throw new Error(`高强度提示拼接不正确: ${JSON.stringify(composeDynamicPrompt(poolText, "high"))}`)
        }
        for (const effort of ["auto", "medium"] as const) {
          if (composeDynamicPrompt(poolText, effort) !== poolText) {
            throw new Error(`${effort} 档位应原样返回池正文: ${JSON.stringify(composeDynamicPrompt(poolText, effort))}`)
          }
        }
        for (const effort of ["low", "high", "auto", "medium"] as const) {
          if (composeDynamicPrompt(poolText, effort).includes(TIME_MARKER)) {
            throw new Error(`${effort} 档位的动态提示里出现了时间片段（它不该再进 system prompt）`)
          }
        }

        // 2. 时间片段的唯一生产者仍是 currentTimeNote，形态与定长不变。
        checkTimeNote(currentTimeNote(), "currentTimeNote()")

        // 3. 注记的形状与瞬时身份：模型看得到内容，但它既不是会话历史也不是用户事实。
        //    `isTransientInputMessage` 认它，transcript/ephemeral 的归属才不会把它算进历史行。
        const note = currentTimeNote()
        // 结构化视图：`customType`/`details` 只存在于 AgentMessage 的 custom 变体上，
        // 直接读联合类型要先把形态摊平（与 `isTransientInputMessage` 的入参口径一致）。
        const message = createTurnNoteMessage(note) as {
          role?: unknown
          customType?: unknown
          content?: unknown
          details?: { eligibleForTranscript?: unknown; eligibleForMemory?: unknown } | undefined
        }
        if (message.role !== "custom" || message.customType !== TURN_NOTE_CUSTOM_TYPE) {
          throw new Error(`注记不是预期的自定义消息: ${JSON.stringify({ role: message.role, customType: message.customType })}`)
        }
        if (message.content !== note) throw new Error("注记正文与 currentTimeNote() 不一致")
        if (message.details?.eligibleForTranscript !== false) throw new Error("注记可以被写进会话历史（eligibleForTranscript 不是 false）")
        if (message.details?.eligibleForMemory !== false) throw new Error("注记可以成为用户事实（eligibleForMemory 不是 false）")
        if (!isTransientInputMessage(message)) {
          throw new Error("注记没有被判为瞬时输入，它的 token 会被算进会话历史行")
        }

        // 4. 两个用途的文案必须不同：一次性调用是「端点不认 reasoning_effort」的兜底，
        //    聊天提示是回合的强度指令，合并会让其中一边失去自己的语义。
        if (ONE_SHOT_LOW_EFFORT_HINT === CHAT_THINKING_HINTS.low) {
          throw new Error("一次性调用的低强度提示与聊天提示相同，两个用途的语义被合并了")
        }
        if (estimateContextTokens(ONE_SHOT_LOW_EFFORT_HINT) <= 0) {
          throw new Error("一次性调用的低强度提示估算为 0 token")
        }
        // 一次性调用不出现时间片段：`completePiText` 对系统提示只做一件事 —— 非推理模型 + low
        // 时追加这个常量，它自身不带时间片段。
        if (ONE_SHOT_LOW_EFFORT_HINT.includes(TIME_MARKER)) {
          throw new Error("一次性调用的兜底提示里出现了时间片段，一次性请求会被注入当前时间")
        }

        // 5. 接线与层次：常量被真实消费（不是死导出），且 buildPrompt 产出的任何一块
        //    ——含动态块本身——都不含时间片段。
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
        if (!built.blocks.some(block => block.blockId === "dynamic:runtime")) {
          throw new Error("buildPrompt 没有产出 dynamic:runtime 块")
        }
        for (const block of built.blocks) {
          if (block.text.includes(TIME_MARKER)) {
            throw new Error(`时间片段进了块 ${block.blockId}（它只能作为尾随瞬时消息出现）`)
          }
        }
        if (built.staticPrefix.includes(TIME_MARKER)) {
          throw new Error("时间片段进了 staticPrefix（静态前缀是缓存身份的一部分，不能每回合变化）")
        }
        if (built.systemPrompt.includes(TIME_MARKER) || built.turnDynamic.includes(TIME_MARKER)) {
          throw new Error("时间片段仍留在 system prompt 里：前缀缓存会断在会话正文上游")
        }
      },
    }],
  }],
}

export default 提示文案
