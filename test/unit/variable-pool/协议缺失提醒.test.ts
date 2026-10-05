// ==========================================
// RUNTIME_DATA 协议缺失检测与提醒状态 —— L2
// ==========================================
//
// 检测面：`generateReply` 在「结算正文缺区块 + Card 声明了 updateBy=llm 变量 + 本轮具备
// 写入资格」时回传 `runtimeDataMissing`；提醒面：会话级 mark/clear 状态供 Harness 在
// 下一回合注入一句提醒（接线在 engine/harness/runtime.ts，L2 不 import 该模块）。
//
// 模型「漏发区块」这一半是模型行为，L2 不复现；这里验证的是引擎侧的判定与状态：
// 条件齐全才判违约，任一条件缺失都不打扰。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { buildPrompt } from "@/services/context"
import {
  clearRuntimeDataMissing,
  generateReply,
  hasLlmWritableCardVars,
  hasRuntimeDataReminder,
  markRuntimeDataMissing,
  RUNTIME_DATA_REMINDER_TEXT,
} from "@/services/reply"
import type { CardVariableDef, PersonalityCard } from "@/services/personality/types"
import { destroyPool, getPoolSnapshot, initVariablePool } from "@/services/personality/variable-pool"

const CARD_ID = "l2-runtime-data-protocol"

/** 模型可写变量的声明（检测要触发的前提之一）。 */
const LLM_DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
]

/** 有变量但没有 llm 可写目标：不该因缺区块打扰模型。 */
const READONLY_DEFS: CardVariableDef[] = [
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "系统只读", updateBy: "system", reset: "never" },
]

/** 检测只读 `sections.variableDefs`；其余字段给 buildPrompt 能消费的空值，按既有夹具写法收窄。 */
function cardWith(defs: CardVariableDef[]): PersonalityCard {
  return {
    id: CARD_ID,
    sections: {
      roleSetting: "", languageStyle: "", outputRules: "", whenText: "",
      mustRules: { all: [], toolRelated: [] }, variableDefs: defs,
    },
  } as unknown as PersonalityCard
}

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-runtime-data-reminder-"))
  setTestDataRoot(root)
  destroyPool()
})

afterEach(() => {
  destroyPool()
  rmSync(root, { recursive: true, force: true })
})

describe("RUNTIME_DATA 协议缺失检测", () => {
  it("缺区块且有 llm 可写变量时判定为违约 [variable-runtime-data-missing-detect]", async () => {
    initVariablePool({ cardId: CARD_ID, variableDefs: LLM_DEFS })

    const result = await generateReply("今晚月色真美。", cardWith(LLM_DEFS))

    expect(result.runtimeDataMissing, "缺区块 + 可写变量必须判违约，否则提醒永远不会挂起").toBe(true)
    // 违约回合不产生写入：没有区块就没有变量来源，池里仍是初始值。
    expect(getPoolSnapshot().card["亲密"]?.value).toBe(0)
    expect(result.text).not.toContain("RUNTIME_DATA")
  })

  it("带 RUNTIME_DATA 区块时不判违约且变量正常落池 [variable-runtime-data-present]", async () => {
    initVariablePool({ cardId: CARD_ID, variableDefs: LLM_DEFS })

    const raw = ["好呀，今天也很开心。", "<RUNTIME_DATA>", "亲密: 7", "</RUNTIME_DATA>"].join("\n")
    const result = await generateReply(raw, cardWith(LLM_DEFS))

    expect(result.runtimeDataMissing, "有区块就是履约，判违约会让提醒持续骚扰").toBe(false)
    // 独立证据：同一份正文确实走完了写入链路（区块被解析而不是被忽略）。
    expect(getPoolSnapshot().card["亲密"]?.value).toBe(7)
    expect(result.text).not.toContain("RUNTIME_DATA")
  })

  it("Card 没有 llm 可写变量时不判违约 [variable-runtime-data-no-llm-vars]", async () => {
    initVariablePool({ cardId: CARD_ID, variableDefs: READONLY_DEFS })

    const result = await generateReply("今天好累。", cardWith(READONLY_DEFS))

    expect(hasLlmWritableCardVars(cardWith(READONLY_DEFS)), "夹具前提：这张卡确实没有可写目标").toBe(false)
    expect(result.runtimeDataMissing, "没有可写变量时缺区块没有后果，不该打扰").toBe(false)
  })

  it("本轮不具备写入资格（主动表达/卡已过期）时不判违约 [variable-runtime-data-not-applied]", async () => {
    initVariablePool({ cardId: CARD_ID, variableDefs: LLM_DEFS })

    const result = await generateReply("自言自语。", cardWith(LLM_DEFS), { applyRuntimeData: false })

    expect(result.runtimeDataMissing, "不写变量的回合不能按协议违约处理").toBe(false)
  })
})

describe("RUNTIME_DATA 提醒状态", () => {
  it("提醒按会话记挂与清除，互不串会话 [variable-runtime-data-reminder-state]", () => {
    const sessionA = "reminder-state-session-a"
    const sessionB = "reminder-state-session-b"

    expect(hasRuntimeDataReminder(sessionA)).toBe(false)
    markRuntimeDataMissing(sessionA)
    expect(hasRuntimeDataReminder(sessionA)).toBe(true)
    expect(hasRuntimeDataReminder(sessionB), "会话隔离：别的会话违约不能提醒这个会话").toBe(false)

    clearRuntimeDataMissing(sessionA)
    expect(hasRuntimeDataReminder(sessionA)).toBe(false)
  })

  it("提醒文案点名协议区块，否则模型无法照做 [variable-runtime-data-reminder-text]", () => {
    expect(RUNTIME_DATA_REMINDER_TEXT).toContain("RUNTIME_DATA")
    expect(RUNTIME_DATA_REMINDER_TEXT).toContain("区块")
  })

  it("提醒只在传入时进入回合上下文块 [variable-runtime-data-reminder-block]", () => {
    const card = cardWith(LLM_DEFS)
    const base = {
      thinkingEffort: "low" as const, tools: [],
      contextMaxTokens: 32_000, maxOutputTokens: 1_024,
      v1rtualInstructions: "", skillsPromptBlock: "", dynamicPrompt: "变量池文本",
    }
    const withReminder = buildPrompt({ ...base, runtimeDataReminder: RUNTIME_DATA_REMINDER_TEXT }, card, getPoolSnapshot())
    const block = withReminder.blocks.find(item => item.blockId === "ephemeral:runtime-data")
    expect(block, "传入提醒时必须产出一个可审计的上下文块").toBeDefined()
    expect(block?.text).toBe(RUNTIME_DATA_REMINDER_TEXT)
    expect(withReminder.systemPrompt, "提醒块必须真的进请求视图").toContain(RUNTIME_DATA_REMINDER_TEXT)

    const withoutReminder = buildPrompt(base, card, getPoolSnapshot())
    expect(withoutReminder.blocks.some(item => item.blockId === "ephemeral:runtime-data"), "没有提醒时不该凭空出现提醒块").toBe(false)
    expect(withoutReminder.systemPrompt).not.toContain(RUNTIME_DATA_REMINDER_TEXT)
  })
})
