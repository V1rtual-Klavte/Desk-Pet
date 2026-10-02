// ==========================================
// 提示文案 —— 从 test/e2e/scenes/memory/提示文案.scene.ts 迁到 L3
// ==========================================
//
// 动态提示的文案此前散在三处（context/builder、engine/harness/runtime、engine/harness/model-gateway）：
// 改一处就分叉，而且没有任何断言拦它。这个测试钉住「只有一处定义」这件事本身。
//
// 当前时间的落位：它此前拼在 `composeDynamicPrompt` 末尾、落在 dynamic:runtime 块里。
// 但 system prompt 整体排在会话正文之前，任何每回合变化的内容留在那里都会让前缀缓存
// 断在正文上游 —— 整个会话正文每轮重新计费。现在它改由 `createTurnNoteMessage` 作为尾随
// 瞬时消息附在请求视图最末，**system prompt 里一个字符都不该有**。这个测试同时钉住
// 「动态提示只剩池正文 + 强度后缀」与「注记的形状与瞬时身份」。
//
// 归 L3 的理由：注记的生产者是 `@/services/engine/harness`（会带出 runtime 的 IPC 依赖）。
import { describe, expect, it } from "vitest"

import { buildPrompt, CHAT_THINKING_HINTS, ONE_SHOT_LOW_EFFORT_HINT, composeDynamicPrompt, currentTimeNote, estimateContextTokens } from "@/services/context"
import { createTurnNoteMessage } from "@/services/engine/harness"
import { isTransientInputMessage, TURN_NOTE_CUSTOM_TYPE } from "@/services/engine/runtime"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import type { VariablePool } from "@/services/personality/variable-pool"

/** 最小变量池：这里校验的是拼接口径，池正文内容不参与断言。 */
const POOL: VariablePool = { system: {}, card: {}, interaction: {} }

/** 时间片段的格式与定长（26 字符）是断言对象本身，这里按形态写死，不复用生产实现。 */
const TIME_NOTE_PATTERN = /^\[当前时间\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]$/
const TIME_NOTE_LENGTH = 26
const TIME_MARKER = "[当前时间]"
/** 允许的墙上时钟漂移：覆盖跨分钟边界与调度延迟，但排除「固定串 / 旧时间」。 */
const TIME_DRIFT_TOLERANCE_MS = 90_000

describe("提示文案", () => {
  it("动态提示只有一处拼接，当前时间由尾随瞬时注记承载 [memory-prompt-composition]", () => {
    const poolText = formatPoolForPrompt(POOL)

    // 0. 价值钉：拼接的「有后缀」性质不能靠常量自证 —— hint 改成空串时
    //    `pool + hint === pool` 会让下面的相等断言转绿。先钉住两档后缀非空且互不相同。
    expect(CHAT_THINKING_HINTS.low.length, "low 档的强度后缀是空串：拼接断言会退化成恒真").toBeGreaterThan(0)
    expect(CHAT_THINKING_HINTS.high.length, "high 档的强度后缀是空串：拼接断言会退化成恒真").toBeGreaterThan(0)
    expect(CHAT_THINKING_HINTS.high, "两档的强度后缀被合并成同一个").not.toBe(CHAT_THINKING_HINTS.low)

    // 1. 拼接口径：low/high 各带自己的后缀，其余档位原样返回池正文。
    //    三档都**不带**时间片段 —— 时间不在 system prompt 里（见下方第 3 步）。
    expect(composeDynamicPrompt(poolText, "low"), `低强度提示拼接不正确`)
      .toBe(`${poolText}${CHAT_THINKING_HINTS.low}`)
    expect(composeDynamicPrompt(poolText, "high"), `高强度提示拼接不正确`)
      .toBe(`${poolText}${CHAT_THINKING_HINTS.high}`)
    for (const effort of ["auto", "medium"] as const) {
      expect(composeDynamicPrompt(poolText, effort), `${effort} 档位应原样返回池正文`).toBe(poolText)
    }
    for (const effort of ["low", "high", "auto", "medium"] as const) {
      expect(composeDynamicPrompt(poolText, effort), `${effort} 档位的动态提示里出现了时间片段（它不该再进 system prompt）`)
        .not.toContain(TIME_MARKER)
    }

    // 2. 时间片段的唯一生产者仍是 currentTimeNote，形态与定长不变。
    const note = currentTimeNote()
    expect(note, `currentTimeNote() 不是定长时间片段: ${JSON.stringify(note)}`).toMatch(TIME_NOTE_PATTERN)
    expect(note.length, `currentTimeNote() 不是 ${TIME_NOTE_LENGTH} 字符（实际 ${note.length}）`).toBe(TIME_NOTE_LENGTH)
    // 本地时间口径与生产实现一致（两边都用本机时区的年月日时分）。
    const digits = note.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
    expect(digits, `currentTimeNote() 无法解析: ${JSON.stringify(note)}`).not.toBeNull()
    const at = new Date(
      Number(digits![1]), Number(digits![2]) - 1, Number(digits![3]), Number(digits![4]), Number(digits![5]),
    ).getTime()
    expect(Math.abs(at - Date.now()), `currentTimeNote() 不是当前时刻（漂移 ${Math.round(Math.abs(at - Date.now()) / 1000)}s）`)
      .toBeLessThanOrEqual(TIME_DRIFT_TOLERANCE_MS)

    // 3. 注记的形状与瞬时身份：模型看得到内容，但它既不是会话历史也不是用户事实。
    //    `isTransientInputMessage` 认它，transcript/ephemeral 的归属才不会把它算进历史行。
    // 结构化视图：`customType`/`details` 只存在于 AgentMessage 的 custom 变体上，
    // 直接读联合类型要先把形态摊平（与 `isTransientInputMessage` 的入参口径一致）。
    const message = createTurnNoteMessage(note) as {
      role?: unknown
      customType?: unknown
      content?: unknown
      details?: { eligibleForTranscript?: unknown; eligibleForMemory?: unknown } | undefined
    }
    expect({ role: message.role, customType: message.customType }, "注记不是预期的自定义消息")
      .toEqual({ role: "custom", customType: TURN_NOTE_CUSTOM_TYPE })
    expect(message.content, "注记正文与 currentTimeNote() 不一致").toBe(note)
    expect(message.details?.eligibleForTranscript, "注记可以被写进会话历史（eligibleForTranscript 不是 false）").toBe(false)
    expect(message.details?.eligibleForMemory, "注记可以成为用户事实（eligibleForMemory 不是 false）").toBe(false)
    expect(isTransientInputMessage(message), "注记没有被判为瞬时输入，它的 token 会被算进会话历史行").toBe(true)

    // 4. 两个用途的文案必须不同：一次性调用是「端点不认 reasoning_effort」的兜底，
    //    聊天提示是回合的强度指令，合并会让其中一边失去自己的语义。
    expect(ONE_SHOT_LOW_EFFORT_HINT, "一次性调用的低强度提示与聊天提示相同，两个用途的语义被合并了")
      .not.toBe(CHAT_THINKING_HINTS.low)
    expect(estimateContextTokens(ONE_SHOT_LOW_EFFORT_HINT), "一次性调用的低强度提示估算为 0 token").toBeGreaterThan(0)
    // 一次性调用不出现时间片段：`completePiText` 对系统提示只做一件事 —— 非推理模型 + low
    // 时追加这个常量，它自身不带时间片段。
    expect(ONE_SHOT_LOW_EFFORT_HINT, "一次性调用的兜底提示里出现了时间片段，一次性请求会被注入当前时间")
      .not.toContain(TIME_MARKER)

    // 5. 接线与层次：常量被真实消费（不是死导出），且 buildPrompt 产出的任何一块
    //    ——含动态块本身——都不含时间片段。
    const built = buildPrompt({
      thinkingEffort: "high",
      tools: [],
      contextMaxTokens: 131_072,
      candyInstructions: "",
      skillsPromptBlock: "",
    }, null, POOL)
    expect(built.systemPrompt, "buildPrompt 的系统提示没有消费 CHAT_THINKING_HINTS.high").toContain(CHAT_THINKING_HINTS.high)
    expect(built.blocks.some(block => block.blockId === "dynamic:runtime"), "buildPrompt 没有产出 dynamic:runtime 块").toBe(true)
    for (const block of built.blocks) {
      expect(block.text, `时间片段进了块 ${block.blockId}（它只能作为尾随瞬时消息出现）`).not.toContain(TIME_MARKER)
    }
    expect(built.staticPrefix, "时间片段进了 staticPrefix（静态前缀是缓存身份的一部分，不能每回合变化）").not.toContain(TIME_MARKER)
    expect(built.systemPrompt, "时间片段仍留在 system prompt 里：前缀缓存会断在会话正文上游").not.toContain(TIME_MARKER)
    expect(built.turnDynamic).not.toContain(TIME_MARKER)
  })
})
