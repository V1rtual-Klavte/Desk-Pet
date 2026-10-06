// ==========================================
// 亲密度提升 —— 从 test/e2e/scenes/variable-pool/亲密度提升.scene.ts 迁到 L3
// ==========================================
//
// 归属 L3 的依据：原场景 import 只到 `@/services/personality/registry`（不在 L2 禁入清单里，
// 按 import 判定本是 L2 候选），但它用 fake provider 驱动**完整 Pi agent loop**
// （admitInput → Provider 请求 → 回复后处理 → generateReply 解析 RUNTIME_DATA → 落池），
// 这条链路要真会话落盘（`@/services/session` / `@/services/engine/harness`），L2 装不下。
// 定向探针实测：本文件在 Node 适配层跑通、无 UnsupportedInNodeError。核对产品侧调用点，
// 经过的 IPC 面（会话 JSONL 的 file_read/file_write/file_append/file_rename/file_info/
// file_list/file_exists/dir_create、人格与 stages 的 personality_file_*、会话 UI 状态、
// 技能指纹 skill_catalog_fingerprint、记忆 init_memory_files、日志 log_messages/set_log_config）
// 都在适配层的可复现命令表里；`bash_exec` / `tool_permit_*` 等 Rust 专属命令只在真的调用
// 工具时才经过 —— 本测试的脚本回复是纯文本，不调用工具。
//
// 被测的仍是 vp-04 那条链路：**模型一旦发出 RUNTIME_DATA 请求，引擎必须原样写对**。
// 与 L4 旧场景的差别只有一处：真实模型换成脚本化的 fake provider —— 「模型自不自觉写」
// 本来就不是本场景的断言对象（原场景注释自己也这么写），fake 只替换 Provider，
// 其余走真实链路。
//
// 审视结论（契约「审计线索」表两条，均「修正后搬」）：
// - `亲密度提升:105` D5：原 setup 只筛定义了「亲密度」的卡，第 3 轮却断言「心情」——
//   用户 Card 只定义其一即前提失效假红（随包默认卡里只有 angelkawaii 同时定义两者）。
//   **修正**：夹具卡同时定义两个变量，并在运行前断言两者都进了池子；前提不成立就在
//   开头红，而不是等第 3 轮在「变量不存在」上炸。
// - `亲密度提升:41-42` D9：原收尾守卫只要求「整场任一次写入」且不区分变量 —— 只写了
//   「心情」时名为 affection 的场景仍绿，亲密度链路一轮都没验证。
//   **修正**：写入按变量分别计数，收尾守卫逐变量断言（亲密度 2 次 / 心情 1 次）。
//   原场景为真实模型保留的「模型不必每轮都写」容差在 fake provider 下不再需要 ——
//   脚本保证每轮都请求写入，逐轮断言因此收紧到精确值。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { MemoryService } from "@/services/agent/memory"
import { flushConfig, setOverrides } from "@/services/config"
import { runPiAgentTurn } from "@/services/engine/harness"
import { userInputMessage } from "@/services/engine/runtime"
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { switchPersonality } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { destroyPool, getPoolSnapshot } from "@/services/personality/variable-pool"
import { getActiveSessionId, initSessions } from "@/services/session"

const CARD_ID = "e2e-affection"
const AFFECTION = "亲密度"
const MOOD = "心情"

/**
 * 夹具卡：**同时**定义亲密度与心情（D5 修正）。变量名与类型对齐真实卡形态 ——
 * 亲密度是带范围约束的 number，心情是枚举 string，写入路径的两种类型都被覆盖。
 */
function cardMarkdown(): string {
  return `---
id: ${CARD_ID}
name: ${CARD_ID}
description: 亲密度提升夹具
version: 1
---

# 角色设定
你是 ${CARD_ID}，会记住和主人的每一次互动。

# 语言风格
简短、亲近。

# 输出规则
不要输出多余的解释。

# 变量定义

## card

\`\`\`yaml
${AFFECTION}:
  type: number
  initial: 0
  min: 0
  max: 10
  updateBy: llm
  reset: never
  description: 对主人的好感
${MOOD}:
  type: string
  initial: 平静
  enum: ["平静", "开心"]
  updateBy: llm
  reset: never
  description: 当前心情
\`\`\`
`
}

interface Round {
  userText: string
  /** 给用户看的正文部分（RUNTIME_DATA 之外） */
  body: string
  /** 脚本请求写入的变量名与请求值 —— 脚本是本测试唯一的 oracle */
  name: string
  requested: string
  type: "number" | "string"
}

const ROUNDS: Round[] = [
  { userText: "请在回复末尾用 RUNTIME_DATA 区块把亲密度设为 3。", body: "好呀，我把亲密度记下来了。", name: AFFECTION, requested: "3", type: "number" },
  { userText: "再用 RUNTIME_DATA 把亲密度改成 5。", body: "亲密度再升一点，现在是 5 啦。", name: AFFECTION, requested: "5", type: "number" },
  { userText: "再用 RUNTIME_DATA 把心情设为 开心。", body: "心情变得很开心。", name: MOOD, requested: "开心", type: "string" },
]

function replyOf(round: Round): string {
  return [round.body, "<RUNTIME_DATA>", `${round.name}: ${round.requested}`, "</RUNTIME_DATA>"].join("\n")
}

/**
 * RUNTIME_DATA 里的字符串值可带引号，而 `batchWriteVars` 的 `coerceValue` 会把成对引号
 * 剥掉再落池；比较前对齐这一步，否则两边打印一模一样却判不相等。
 */
function normalize(requested: string): string {
  const trimmed = requested.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return quoted ? quoted[2] : trimmed
}

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-variable-pool-"))
  setTestDataRoot(root)
  await initPaths()

  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(join(cardsDir, `${CARD_ID}.md`), cardMarkdown())

  // 计划门禁钉在关闭：出厂配置 `ai.plan.enabled` 为 true，用户文本若命中复杂度关键词，
  // 计划段会额外消费一次 fake 响应、把三轮脚本错位。L4 侧同一场景也跑在
  // standard-setup 的计划关闭基线上。L3 没有那层兜底，这里显式钉住（写盘落在临时根内）。
  setOverrides({ "ai.plan.enabled": false })
  await flushConfig()

  const card = await loadCard(CARD_ID)
  expect(card, `夹具卡 ${CARD_ID} 未从临时数据根加载`).toBeDefined()
  if (!card) return

  // 激活卡的阶段文案缓存预先写好：夹具激活不该去调模型（fake 响应要留给三个回合）
  await updateStagesFile(card.id, {
    stages: {
      cardId: card.id, cardVersion: card.version,
      sourceHash: await stageSourceHash(card),
      generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES,
    },
  })
  const switched = await switchPersonality(card.id)
  expect(switched.ok, `夹具激活失败: ${switched.error ?? "(无原因)"}`).toBe(true)

  await MemoryService.init()
  await initSessions()
}, 30_000)

afterAll(async () => {
  destroyPool()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("亲密度提升", () => {
  it("fake 模型发出 RUNTIME_DATA → 引擎按 def 写入变量池 [variable-affection-praise]", async () => {
    const sessionId = getActiveSessionId()
    expect(sessionId, "initSessions 之后必须有活跃会话").not.toBe("")

    // 前提守卫（D5 修正）：两个变量都必须在池子里 —— 夹具卡缺定义时在开头红，
    // 不让第 3 轮的断言在「变量不存在」上假红
    const names = Object.keys(getPoolSnapshot().card)
    expect(names).toEqual(expect.arrayContaining([AFFECTION, MOOD]))

    const provider = installFakeProvider(ROUNDS.map(round => fakeText(replyOf(round))))
    /** 按变量分别计数的写入（D9 修正）：每条都经完整断言后才 +1 */
    const writesByVariable = new Map<string, number>()
    try {
      for (const [index, round] of ROUNDS.entries()) {
        const roundLabel = `第 ${index + 1} 轮`
        const output = await runPiAgentTurn({
          sessionId,
          userText: round.userText,
          userPrompt: userInputMessage(round.userText, ""),
          unansweredCount: 0,
          isActiveMessage: false,
        })

        // 模型请求已被引擎解析出来 —— 解析丢掉时这里就红，不用等池子
        const requested = output.runtimeData?.variables[round.name]
        expect(requested, `${roundLabel}：引擎没有解析出 ${round.name} 的 RUNTIME_DATA 请求`).toBeDefined()
        expect(normalize(requested ?? ""), `${roundLabel}：解析出的请求值与脚本不一致`).toBe(round.requested)

        // 请求值真的落到了池子里，来源是 llm —— 期望值取脚本（独立 oracle），不取引擎自报
        const state = getPoolSnapshot().card[round.name]
        expect(state, `${roundLabel}：${round.name} 不在变量池里`).toBeDefined()
        expect(typeof state?.value, `${roundLabel}：${round.name} 的值类型`).toBe(round.type)
        expect(state?.value, `${roundLabel}：${round.name} 的池内值与模型的请求值不一致`)
          .toBe(round.type === "number" ? Number(round.requested) : round.requested)
        expect(state?.updatedBy, `${roundLabel}：${round.name} 的写入来源`).toBe("llm")

        // RUNTIME_DATA 是内部元数据：用户正文照常，区块本身不得出现在回复里
        expect(output.reply).toContain(round.body)
        expect(output.reply).not.toContain("RUNTIME_DATA")

        writesByVariable.set(round.name, (writesByVariable.get(round.name) ?? 0) + 1)
      }
    } finally {
      provider.restore()
    }

    // 收尾守卫（D9 修正）：逐变量对账 —— 「只写了心情」不再能让亲密度链路空转通过
    expect(writesByVariable.get(AFFECTION), "亲密度一次都没有被验证到写入").toBe(2)
    expect(writesByVariable.get(MOOD), "心情的写入没有被验证").toBe(1)
  }, 60_000)
})
