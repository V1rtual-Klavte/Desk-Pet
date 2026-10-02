// ==========================================
// 切换失败回滚 —— 从 test/e2e/scenes/personality-card/切换失败回滚.scene.ts 迁到 L3
// ==========================================
//
// 归属 L3 的理由（按 import 判定）：场景 import `@/services/engine/harness`（测试 provider 装载点），
// 该入口在规则 6 的 IPC 模块清单里，照搬进 L2 会当场命中 —— 它依赖 pi 侧一次性文本调用链，
// 本身就是集成级的（契约的 L2/L3 判据「跑不跑 agent loop」之外，import 决定了它不能进 L2）。
//
// 切换失败的原子性（VAR-02）。
//
// 真实可达的失败点是阶段文案：`switchPersonality` 先 `ensureStagesReady`
// （磁盘缓存未命中 → 一次性 LLM 生成），生成不可用时整次切换失败。
// 失败不得留下部分应用：activeId、变量注册表与变量池都必须与失败前逐项一致。
//
// 注册表被单列不是凑数：改动前回滚只还原池、不还原注册表，切换失败后后续写入
// 会按目标卡的 schema 校验、Prompt 里的变量元数据整块消失。所以目标卡刻意选一张
// **变量定义不同**的卡 —— 一旦目标卡的 schema 泄漏进注册表，名字比对立刻红。
//
// 审视结论：照搬（断言对象是产品产出的 activeId / 注册表 / 变量池 / 失败原因，
// 逐条能区分对错实现）。与原场景的唯一差异：夹具自己写数据根，目标卡的阶段文案
// 缓存**从不创建**（原场景靠标准 setup 的临时根 + file_remove 达到同一前提）。
import type { StreamFn } from "@earendil-works/pi-agent-core"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { installFakeProvider, fakeText } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { installPiRuntimeProviderForTest } from "@/services/engine/harness"
import { getCard, initCards } from "@/services/personality/loader"
import {
  getActiveCard,
  getActivePersonalityId,
  listPersonalities,
  switchPersonality,
} from "@/services/personality/registry"
import { FALLBACK_STAGES, clearStagesCache, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { destroyPool, getPoolSnapshot, getVariableRegistry } from "@/services/personality/variable-pool"

/** 两张变量定义不同的 Card：目标卡的 schema 一旦泄漏进注册表，名字比对立刻红 */
function cardMarkdown(id: string, varName: string): string {
  return `---
id: ${id}
name: ${id}
description: 切换回滚夹具
version: 1
---

# 角色设定
你是 ${id}，说话简短。

# 语言风格
简短、直接。

# 输出规则
不要输出多余的解释。

# 变量定义

## card

\`\`\`yaml
${varName}:
  type: number
  initial: 1
  min: 0
  max: 10
  updateBy: llm
  reset: never
  description: ${varName}
\`\`\`
`
}

/** 失败点计数：模块级持有，让「模型侧不可用」的夹具不必写进 it 体（规则 4 只放行测试体外的夹具 throw） */
const providerCalls = { count: 0 }

/**
 * 模型侧不可用：一次性文本调用直接抛错（阶段文案生成的失败吞进 null，
 * 由 ensureStagesReady 转成「阶段文案生成失败」）。
 */
function unavailableStream(counter: { count: number }): StreamFn {
  return (() => {
    counter.count += 1
    throw new Error("模拟阶段文案生成不可用")
  }) as StreamFn
}

let root = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-personality-card-"))
  setTestDataRoot(root)
  providerCalls.count = 0
  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(join(cardsDir, "card-a.md"), cardMarkdown("card-a", "只属于A"))
  writeFileSync(join(cardsDir, "card-b.md"), cardMarkdown("card-b", "只属于B"))

  await initCards()
  const active = getCard("card-a")
  if (!active) throw new Error("夹具卡 card-a 未从临时数据根加载")

  // 激活卡的阶段文案缓存预先写好：夹具的激活不该去调模型（失败点留给目标卡）
  await updateStagesFile(active.id, {
    stages: {
      cardId: active.id, cardVersion: active.version,
      sourceHash: await stageSourceHash(active),
      generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES,
    },
  })
  const activated = await switchPersonality(active.id)
  expect(activated.ok, `夹具激活失败: ${activated.error ?? "(无原因)"}`).toBe(true)
})

afterEach(() => {
  destroyPool()
  clearStagesCache()
  rmSync(root, { recursive: true, force: true })
})

describe("切换失败回滚", () => {
  it("切换失败不产生部分应用：activeId、变量注册表与变量池保持失败前状态 [card-switch-failure-rollback]", async () => {
    const active = getActiveCard()
    expect(active, "夹具激活后必须有激活的 Card").not.toBeNull()
    if (!active) return

    const others = listPersonalities().filter(card => card.id !== active.id)
    const target = others.find(card =>
      JSON.stringify(card.sections.variableDefs) !== JSON.stringify(active.sections.variableDefs))
    expect(target, "没有变量定义不同的第二张 Card，注册表断言失去区分度").toBeDefined()
    if (!target) return

    const activeIdBefore = getActivePersonalityId()
    const registryBefore = JSON.stringify(getVariableRegistry())
    const poolBefore = JSON.stringify(getPoolSnapshot())
    const targetDefNames = target.sections.variableDefs.map(def => def.name)

    // 目标卡没有可用的阶段文案缓存（夹具从不写它）：命中缓存就不会去调模型，失败点也就不成立。
    // 模型侧不可用：一次性文本调用直接抛错（阶段文案生成的失败吞进 null，
    // 由 ensureStagesReady 转成「阶段文案生成失败」）
    const fake = installFakeProvider([fakeText("这条响应不会被消费")])
    const restoreOverride = installPiRuntimeProviderForTest({
      model: fake.model,
      streamFn: unavailableStream(providerCalls),
    })
    let result: Awaited<ReturnType<typeof switchPersonality>>
    try {
      result = await switchPersonality(target.id)
    } finally {
      restoreOverride()
      fake.restore()
    }

    // 失败点必须是本场景要钉的那一条：否则「切换失败」可能只是卡根本不存在
    expect(providerCalls.count, "切换没有走到阶段文案生成，失败点不是模型不可用").toBeGreaterThan(0)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("阶段文案生成失败")

    // 失败后的状态与失败前逐项一致
    expect(getActivePersonalityId()).toBe(activeIdBefore)
    expect(getActiveCard()?.id).toBe(active.id)
    expect(JSON.stringify(getVariableRegistry())).toBe(registryBefore)
    expect(JSON.stringify(getPoolSnapshot())).toBe(poolBefore)
    expect(getPoolSnapshot().system.activeCardId).toBe(active.id)
    // 目标卡的 schema 一个都不该出现在注册表里（注册表整体相等已蕴含，单列为了可读的失败信息）
    const namesAfter = getVariableRegistry().map(def => def.name)
    expect(namesAfter.filter(name => targetDefNames.includes(name))).toEqual([])
  })
})
