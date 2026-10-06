// ==========================================
// RUNTIME_DATA 协议提醒的接线（结算挂起 → 下一回合注入 → 履约清除）—— L3
// ==========================================
//
// ar-25 的自述缺口：L2 只验证了状态函数、文案与 buildPrompt 的请求视图三件套，
// 「settleMainTurn 结算侧 mark/clear + 下一回合 buildPrompt 传参」这段接线没有场景覆盖。
// 本文件用 fake provider 驱动真实 agent loop（真会话落盘、真结算、真请求投影），只替换
// Provider —— 模型是否自觉写区块不是断言对象（脚本保证）；引擎在违约后有没有把提醒
// 送进下一回合的请求、履约后有没有停止送，才是。
//
// 观测面：自定义 streamFn 在每次请求进入 pi-ai 前抓下 `context.systemPrompt` —— 这是
// 「请求真的带了块」的最终事实（提醒经 buildPrompt 的 `ephemeral:runtime-data` 块进入
// kernel 的 systemPrompt，再由 Harness 作为 spec.systemPrompt 交给 agent loop）。
// 不能用 `installFakeProvider` 的 payloads：那组探针只记录 messages/tools，不含
// systemPrompt，拿它断言会变成真空断言。
//
// 空区块的**判定**语义（hasBlock：有区块、无内容也算履约）由 vp-23 的 L2 用例
// `variable-runtime-data-empty-block-fulfills` 覆盖；本文件补的是它的**接线**面：
// 空区块结算必须清除已挂起提醒、不产生写入、也不在下一回合重新注入。
//
// caseId 清单（新增，需在契约生成时登记 coverage，本批不动 test/contracts/**）：
//   · variable-runtime-data-reminder-wiring —— L3，建议新增 agent-runtime 的
//     integration 层覆盖点（ar-25 是 unit 层，只覆盖状态/文案/请求视图三件套）
//   · variable-runtime-data-reminder-empty-block-wiring —— L3，同一新覆盖点

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  fauxProvider,
  type Context,
  type FauxModelDefinition,
  type FauxResponseStep,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import type { StreamFn } from "@earendil-works/pi-agent-core"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText } from "../../host/fake-provider"
import { MemoryService } from "@/services/agent/memory"
import { flushConfig, setOverrides } from "@/services/config"
import { installPiRuntimeProviderForTest, runPiAgentTurn } from "@/services/engine/harness"
import type { PiAgentTurnOutput } from "@/services/engine/harness"
import { userInputMessage } from "@/services/engine/runtime"
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { switchPersonality } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import type { CardVariableDef } from "@/services/personality/types"
import { destroyPool, getPoolSnapshot, initVariablePool } from "@/services/personality/variable-pool"
import { RUNTIME_DATA_REMINDER_TEXT } from "@/services/reply"
import { createNewSession, initSessions } from "@/services/session"

const CARD_ID = "l3-runtime-data-reminder"
const VAR = "亲密"
const VIOLATION_TEXT = "今晚月色真美。"
const COMPLIANT_BODY = "好呀，今天也很开心。"
const EMPTY_BLOCK_BODY = "嗯嗯，知道了。"

/** 夹具卡：一个 llm 可写变量 —— 提醒的注入与检测都以「Card 声明了可写变量」为前提。 */
function cardMarkdown(): string {
  return `---
id: ${CARD_ID}
name: ${CARD_ID}
description: RUNTIME_DATA 提醒接线夹具
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
${VAR}:
  type: number
  initial: 0
  min: 0
  max: 10
  updateBy: llm
  reset: never
  description: 对主人的好感
\`\`\`
`
}

/** 非空履约区块：正文 + 逐行写入。 */
function compliantReply(): string {
  return [COMPLIANT_BODY, "<RUNTIME_DATA>", `${VAR}: 7`, "</RUNTIME_DATA>"].join("\n")
}

/** 空区块：有区块、无内容 —— 按实现语义这是履约（hasBlock=true），不是凭证。 */
function emptyBlockReply(): string {
  return [EMPTY_BLOCK_BODY, "<RUNTIME_DATA>", "</RUNTIME_DATA>"].join("\n")
}

interface CapturedRequest {
  systemPrompt: string
}

/**
 * fake provider + 请求视图抓取（唯一目的：把 `context.systemPrompt` 留下来）。
 *
 * `installFakeProvider` 的 payloads 不含 systemPrompt，这里按它的最小装配自建一份：
 * 响应脚本仍走 pi-ai 的 faux，真实 agent/tool loop 照常执行。
 */
function installCapturingProvider(responses: FauxResponseStep[], definition?: FauxModelDefinition): {
  requests: CapturedRequest[]
  restore: () => void
} {
  const fake = fauxProvider({
    api: "faux",
    provider: "deskpet-fake",
    models: [definition ?? { id: "deskpet-fake", name: "Desk-Pet Fake" }],
  })
  fake.setResponses(responses)
  const model = fake.getModel()
  if (!model) throw new Error("fake provider 未创建 model")
  const requests: CapturedRequest[] = []
  const restore = installPiRuntimeProviderForTest({
    model,
    streamFn: ((requestModel: Model<any>, context: Context, options?: SimpleStreamOptions) => {
      requests.push({ systemPrompt: context.systemPrompt ?? "" })
      return fake.provider.streamSimple(requestModel, context, options)
    }) as StreamFn,
  })
  return { requests, restore }
}

/** 一次真实回合：与 L4 runner 的 runtime 分支同生命周期（投递前落盘、结束后回写正文）。 */
async function runTurn(sessionId: string, userText: string): Promise<PiAgentTurnOutput> {
  return runPiAgentTurn({
    sessionId,
    userText,
    userPrompt: userInputMessage(userText, ""),
    unansweredCount: 0,
    isActiveMessage: false,
  })
}

let root = ""
let cardDefs: CardVariableDef[] = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-runtime-data-reminder-l3-"))
  setTestDataRoot(root)
  await initPaths()

  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(join(cardsDir, `${CARD_ID}.md`), cardMarkdown())

  // 计划门禁钉在关闭（出厂 `ai.plan.enabled` 为 true）：用户文本若命中复杂度关键词，
  // 计划段会额外消费一次 fake 响应、把回合脚本错位（L4 standard-setup 有同款钉位）。
  setOverrides({ "ai.plan.enabled": false })
  await flushConfig()

  const card = await loadCard(CARD_ID)
  expect(card, `夹具卡 ${CARD_ID} 未从临时数据根加载`).toBeDefined()
  if (!card) return
  cardDefs = card.sections.variableDefs

  // 阶段文案缓存预先写好：夹具激活不该去调模型（fake 响应要留给回合脚本）。
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

afterAll(() => {
  destroyPool()
  if (root) rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // 池子按夹具定义重置：断言「履约回合写入到什么值 / 空区块不写入」需要已知初值。
  destroyPool()
  initVariablePool({ cardId: CARD_ID, variableDefs: cardDefs })
})

describe("RUNTIME_DATA 提醒接线", () => {
  it("违约挂起 → 下一回合请求带提醒块 → 履约清除 [variable-runtime-data-reminder-wiring]", async () => {
    // 每个用例一条全新会话：提醒的挂起状态按会话收敛，跨用例复用会把上一条的
    // 违约状态带进来（上一用例最后一个回合的正文决定它的去留）。
    const sessionId = (await createNewSession()).id
    const provider = installCapturingProvider([
      fakeText(VIOLATION_TEXT),
      fakeText(compliantReply()),
      fakeText("嗯。"),
    ])
    try {
      // ① 违约回合：缺区块 + 有可写变量 + 具备写入资格 → 结算侧必须挂起提醒。
      const first = await runTurn(sessionId, "说点什么呢。")
      expect(first.failure, `违约回合以失败结束: ${first.failure?.message ?? "(无失败)"}`).toBeUndefined()
      expect(getPoolSnapshot().card[VAR]?.value, "违约回合不该产生变量写入").toBe(0)

      // ② 下一回合的请求必须真的带提醒：断言的是交给 provider 的 systemPrompt，
      //    不是状态函数（把 buildPrompt 传参删掉这条立即红）。
      const second = await runTurn(sessionId, "再来一句。")
      expect(second.failure, `履约回合以失败结束: ${second.failure?.message ?? "(无失败)"}`).toBeUndefined()
      expect(provider.requests.length, "两回合应各发出一次请求").toBe(2)
      expect(
        provider.requests[1].systemPrompt,
        "上一回合违约后，下一回合请求没有携带 RUNTIME_DATA 提醒",
      ).toContain(RUNTIME_DATA_REMINDER_TEXT)
      // 反向判据：没有任何挂起时提醒块不该出现（否则提醒会变成每回合常驻）。
      expect(
        provider.requests[0].systemPrompt,
        "无挂起状态的回合请求也带了提醒（提醒被无条件注入）",
      ).not.toContain(RUNTIME_DATA_REMINDER_TEXT)

      // 独立证据：带区块的履约确实走完了写入链（提醒不是「发了但回合没被解析」）。
      expect(second.runtimeData?.variables[VAR], "引擎没有解析出履约回合的变量写入").toBe("7")
      expect(getPoolSnapshot().card[VAR]?.value, "履约回合的变量没有落池").toBe(7)

      // ③ 履约后提醒必须停止：再下一回合的请求不得再带（clear 没接上这条立即红）。
      const third = await runTurn(sessionId, "然后呢。")
      expect(third.failure, `第三回合以失败结束: ${third.failure?.message ?? "(无失败)"}`).toBeUndefined()
      expect(provider.requests.length, "三回合应各发出一次请求").toBe(3)
      expect(
        provider.requests[2].systemPrompt,
        "履约之后提醒仍在注入（clear 未接在结算侧）",
      ).not.toContain(RUNTIME_DATA_REMINDER_TEXT)
    } finally {
      provider.restore()
    }
  }, 60_000)

  it("空区块结算清除已挂起提醒且不写入 [variable-runtime-data-reminder-empty-block-wiring]", async () => {
    const sessionId = (await createNewSession()).id
    const provider = installCapturingProvider([
      fakeText(VIOLATION_TEXT),
      fakeText(emptyBlockReply()),
      fakeText("嗯。"),
    ])
    try {
      // 判定语义（空区块 = 履约）由 vp-23 的 L2 用例覆盖；这里验接线：
      // 上一回合违约挂起 → 本回合空区块结算后必须清除、且不产生写入。
      const first = await runTurn(sessionId, "说点什么呢。")
      expect(first.failure, `违约回合以失败结束: ${first.failure?.message ?? "(无失败)"}`).toBeUndefined()

      const second = await runTurn(sessionId, "再来一句。")
      expect(second.failure, `空区块回合以失败结束: ${second.failure?.message ?? "(无失败)"}`).toBeUndefined()
      expect(getPoolSnapshot().card[VAR]?.value, "空区块回合产生了变量写入").toBe(0)
      expect(provider.requests.length, "两回合应各发出一次请求").toBe(2)
      expect(
        provider.requests[1].systemPrompt,
        "违约后的下一回合请求没有携带提醒（空区块用例的前置未成立）",
      ).toContain(RUNTIME_DATA_REMINDER_TEXT)

      // 清除的判定：再下一回合的请求不再带提醒（空区块若被当成违约，提醒会重新挂起）。
      const third = await runTurn(sessionId, "然后呢。")
      expect(third.failure, `第三回合以失败结束: ${third.failure?.message ?? "(无失败)"}`).toBeUndefined()
      expect(provider.requests.length, "三回合应各发出一次请求").toBe(3)
      expect(
        provider.requests[2].systemPrompt,
        "空区块回合被当成违约：提醒被重新挂起并再次注入",
      ).not.toContain(RUNTIME_DATA_REMINDER_TEXT)
    } finally {
      provider.restore()
    }
  }, 60_000)
})
