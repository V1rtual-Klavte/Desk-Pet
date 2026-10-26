// ==========================================
// direct-seed 装载计划 — 纯校验单元测试
// ==========================================
//
// 计划由执行器写下的 seed.json 驱动：这里只固定「什么样的 fixture 能被装载」，
// 不触磁盘与产品服务。真实写入链路由 E2E / 隔离根验收覆盖。
import { describe, expect, it } from "vitest"
import { loadDataset } from "../../sim/desk-pet-chat/dataset.mjs"
import { buildDirectSeedPlan } from "../../../src/services/sim/direct-seed-plan"

const dataset = loadDataset()
const entry = dataset.cases.find(candidate => candidate.caseId === "saturday-companionship")
if (!entry) throw new Error("缺少 anchor 用例 saturday-companionship")
const fixture = entry.fixture

function cloneFixture(): any {
  return structuredClone(fixture)
}

/** 复刻执行器 prepare 写下的 seed.json 形状。 */
function seed(overrides: Record<string, any> = {}): any {
  return {
    schemaVersion: 1,
    fixtureId: fixture.fixtureId,
    fixtureHash: entry!.binding.fixtureHash,
    card: { name: fixture.card, activeId: "xiaoxue" },
    profile: { activeId: fixture.profile === "default" ? null : fixture.profile },
    fixture: cloneFixture(),
    ...overrides,
  }
}

function assertInvalid(raw: unknown, pattern: RegExp): void {
  expect(() => buildDirectSeedPlan(raw)).toThrow(pattern)
}

describe("direct-seed 装载计划", () => {
  it("真实 fixture 生成计划：Card、Profile、会话与用户来源顺序", () => {
    const plan = buildDirectSeedPlan(seed())

    expect(plan.fixtureId).toBe(fixture.fixtureId)
    expect(plan.fixtureHash).toBe(entry!.binding.fixtureHash)
    expect(plan.card).toEqual({ name: "本体卡-小雪", activeId: "xiaoxue" })
    expect(plan.profileId).toBeNull()
    expect(plan.clockMs).toBe(Date.parse(fixture.clock))
    expect(plan.session.id).toBe(fixture.initialSession.id)
    expect(plan.session.title).toBe(fixture.initialSession.title)
    expect(plan.session.messages.map(message => message.key)).toEqual(
      fixture.initialSession.messages.map(message => message.id),
    )
    expect(plan.session.messages.map(message => message.role)).toEqual(
      fixture.initialSession.messages.map(message => message.role),
    )

    const expectedSources = fixture.initialSession.messages
      .map((message, index) => ({ message, seq: index + 1 }))
      .filter(({ message }) => message.role === "user")
      .map(({ message, seq }) => ({
        key: message.id,
        seq,
        content: message.content,
        atMs: Date.parse(message.at),
      }))
    expect(plan.sourceMessages).toEqual(expectedSources)
    expect(plan.sourceMessages).toHaveLength(7)

    expect(plan.memory.map(item => item.key)).toEqual(fixture.initialMemory.map(item => item.id))
    expect(plan.memory).toHaveLength(4)
  })

  it("card / session 作用域补上作用域 id，user 作用域不带 scopeId", () => {
    const raw = seed()
    raw.fixture.initialMemory[0].scope = "card"
    raw.fixture.initialMemory[1].scope = "session"

    const plan = buildDirectSeedPlan(raw)
    expect(plan.memory[0]).toMatchObject({ scope: "card", scopeId: "xiaoxue" })
    expect(plan.memory[1]).toMatchObject({ scope: "session", scopeId: raw.fixture.initialSession.id })
    expect(plan.memory[2]).not.toHaveProperty("scopeId")
  })

  it("fixture.profile=default 必须与 activeId=null 配对，具名 Profile 原样带出", () => {
    const named = seed()
    named.fixture.profile = "profile2"
    named.profile.activeId = "profile2"
    expect(buildDirectSeedPlan(named).profileId).toBe("profile2")

    const defaultMismatch = seed()
    defaultMismatch.profile.activeId = "profile2"
    assertInvalid(defaultMismatch, /fixture\.profile=default/)

    const namedNull = seed()
    namedNull.fixture.profile = "profile2"
    namedNull.profile.activeId = null
    assertInvalid(namedNull, /必须为 null/)
  })

  it("消息时间必须非递减，固定时钟不得早于最后一条消息（相等允许）", () => {
    const regression = seed()
    regression.fixture.initialSession.messages[2].at = "2026-10-24T08:59:00+08:00"
    assertInvalid(regression, /时间倒退/)

    const lastAt = fixture.initialSession.messages[fixture.initialSession.messages.length - 1]!.at
    expect(() => buildDirectSeedPlan(seed({ fixture: { ...cloneFixture(), clock: lastAt } }))).not.toThrow()

    const earlyClock = seed()
    earlyClock.fixture.clock = "2026-10-24T11:24:00+08:00"
    assertInvalid(earlyClock, /早于最后一条/)
  })

  it("记忆只接受用户口述，来源必须是初始会话里的用户消息", () => {
    const assistantOrigin = seed()
    assistantOrigin.fixture.initialMemory[0].origin = "assistant"
    assertInvalid(assistantOrigin, /只装载用户口述事实/)

    const otherSession = seed()
    otherSession.fixture.initialMemory[0].source.sessionId = "another-session"
    assertInvalid(otherSession, /来源会话不是初始会话/)

    const assistantMessage = seed()
    assistantMessage.fixture.initialMemory[0].source.messageId = "fixture-msg-assistant-name"
    assertInvalid(assistantMessage, /只能以用户消息为来源/)

    const missingMessage = seed()
    missingMessage.fixture.initialMemory[0].source.messageId = "fixture-msg-missing"
    assertInvalid(missingMessage, /引用了不存在的消息/)
  })

  it("记忆有效期必须严格正区间；validUntil 为空表示长期有效", () => {
    const zeroLength = seed()
    zeroLength.fixture.initialMemory[0].validUntil = zeroLength.fixture.initialMemory[0].validFrom
    assertInvalid(zeroLength, /validUntil 必须晚于 validFrom/)

    const backwards = seed()
    backwards.fixture.initialMemory[0].validUntil = "2026-10-24T08:00:00+08:00"
    assertInvalid(backwards, /validUntil 必须晚于 validFrom/)

    const openEnded = seed()
    openEnded.fixture.initialMemory[0].validUntil = null
    expect(buildDirectSeedPlan(openEnded).memory[0]!.validUntilMs).toBeNull()
  })

  it("重复的消息 id / 记忆 id 会被拒绝", () => {
    const duplicateMessage = seed()
    duplicateMessage.fixture.initialSession.messages[1].id = duplicateMessage.fixture.initialSession.messages[0].id
    assertInvalid(duplicateMessage, /消息 id 重复/)

    const duplicateMemory = seed()
    duplicateMemory.fixture.initialMemory[1].id = duplicateMemory.fixture.initialMemory[0].id
    assertInvalid(duplicateMemory, /记忆 id 重复/)
  })

  it("Card 名称、fixtureId、schemaVersion 与装载模式必须自洽", () => {
    assertInvalid(seed({ card: { name: "别的卡", activeId: "xiaoxue" } }), /fixture\.card 与 seed\.json\.card\.name 不一致/)
    assertInvalid(seed({ fixtureId: "another-fixture" }), /fixture\.fixtureId 与 seed\.json 不一致/)

    const oldFixture = seed()
    oldFixture.fixture.schemaVersion = 2
    assertInvalid(oldFixture, /fixture schemaVersion=2/)

    const oldSeed = seed()
    oldSeed.schemaVersion = 2
    assertInvalid(oldSeed, /seed\.json schemaVersion=2/)

    const badHash = seed()
    badHash.fixtureHash = "sha256:not-a-hash"
    assertInvalid(badHash, /不是 sha256:<hex>/)

    const realChain = seed()
    realChain.fixture.loading.mode = "real-chain"
    assertInvalid(realChain, /loading\.mode 必须是 direct-seed/)

    assertInvalid(seed({ card: { name: "本体卡-小雪", activeId: "" } }), /seed\.json\.card\.activeId/)
  })
})
