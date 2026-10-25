// ==========================================
// 评测运行器 — 纯校验与磁盘形状单元测试
// ==========================================
//
// runner.js 是开发脚本（scripts/），导出纯函数供这里钉住：Card 文件名/解析与产品
// loader 不漂移、CONFIG 覆盖落在正确层级、ready/控制通道/seed-report 的所有权校验
// 会拒绝错配。真正拉起宿主的 start/stop 由隔离根验收覆盖，不在 L2 里跑。
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { load as parseYaml } from "js-yaml"
import { describe, expect, it } from "vitest"
import { loadDataset } from "../../sim/desk-pet-chat/dataset.mjs"
// @ts-expect-error TS7016 —— Node 侧 ESM 工具没有声明文件，运行期形状由断言钉住。
import { buildSyntheticConfig } from "../../host/native/synthetic-config.mjs"
import { importUserCard, safeCardFileName as productSafeCardFileName } from "@/services/personality/loader"
// @ts-expect-error TS7016 —— 开发脚本没有声明文件，运行期形状由本文件的断言钉住。
import * as runner from "../../../scripts/sim-eval-run.mjs"

const dataset = loadDataset()
const entry = dataset.cases.find(candidate => candidate.caseId === "saturday-companionship")
if (!entry) throw new Error("缺少 anchor 用例 saturday-companionship")
const fixture = entry.fixture
const fixtureId = fixture.fixtureId
const fixtureHash = entry.binding.fixtureHash
const sessionId = fixture.initialSession.id
const messageCount = fixture.initialSession.messages.length
const userMessageCount = fixture.initialSession.messages.filter(message => message.role === "user").length
const memoryItemCount = fixture.initialMemory.length
const cardId = "xiaoxue"
const cardName = fixture.card

const expectedSeedFixture = {
  sessionId,
  messageCount,
  userMessageCount,
  memoryItemCount,
}

describe("Card 文件名与解析与产品 loader 保持一致", () => {
  const cardSamples = [
    `---\nid: 本体卡-小雪\nname: 本体卡-小雪\ndescription: 桌宠本体卡\nversion: 3\n---\n\n正文`,
    `---\nid: xue/xue\nname: "小雪 2"\nversion: not-a-number\n---\nbody`,
    `---\nid: no-name\ndescription: 没有 name 时回落到 id\n---\nbody`,
    `not a card`,
  ]

  it("safeCardFileName 对同一 id 得到同一文件名", () => {
    for (const id of ["本体卡-小雪", "a b/c:d*e", "abc_123-中文", ""]) {
      expect(runner.safeCardFileName(id)).toBe(productSafeCardFileName(id))
    }
  })

  it("parseCardMeta 与 importUserCard 得到同一 id/name/description/version", async () => {
    for (const raw of cardSamples) {
      const product = await importUserCard(raw)
      const meta = runner.parseCardMeta(raw)
      expect(meta).toMatchObject({
        id: product.id,
        name: product.name,
        description: product.description,
        version: product.version,
      })
      expect(meta.nameVar).toBe(product.nameVar)
    }
  })
})

describe("run-id 与运行根", () => {
  it("只接受小写字母/数字/短横线，最长 48 且不以短横线开头", () => {
    expect(runner.validateRunId("20261025-deadbeef")).toBe("20261025-deadbeef")
    expect(runner.validateRunId("a")).toBe("a")
    for (const invalid of ["", "A", "-a", "a b", "a/b", "a".repeat(49), undefined, 3]) {
      expect(() => runner.validateRunId(invalid)).toThrow(/run-id 不合法/)
    }
  })

  it("makeRunId 使用本地日期 + 随机后缀，运行根固定在 test/.tmp/sim-eval-<id>", () => {
    expect(runner.makeRunId(new Date(2026, 9, 25, 12), "deadbeef")).toBe("20261025-deadbeef")
    const repoRoot = join(tmpdir(), "desk-pet-repo")
    expect(runner.runDirFor("r1", repoRoot)).toBe(join(repoRoot, "test", ".tmp", "sim-eval-r1"))
    expect(() => runner.runDirFor("Bad Id", repoRoot)).toThrow(/run-id 不合法/)
  })
})

describe("运行期 CONFIG 覆盖", () => {
  it("Card/主动/静默了解落在 ai 下，Profile 落在顶层 appearance", () => {
    const overrides = runner.buildRunOverrides({ cardId: cardId, profileId: null })
    expect(overrides).toEqual({
      ai: {
        personality: { active: cardId },
        proactive: { frequency: "off" },
        silentAccess: { frequency: "off" },
      },
    })
    expect(overrides).not.toHaveProperty("appearance")
    expect(overrides.ai).not.toHaveProperty("appearance")

    const withProfile = runner.buildRunOverrides({ cardId: cardId, profileId: "profile2" })
    expect(withProfile.appearance).toEqual({ activeProfile: "profile2" })
  })

  it("缺少 Card id 直接失败", () => {
    expect(() => runner.buildRunOverrides({ cardId: "", profileId: null })).toThrow(/Card id/)
    expect(() => runner.buildRunOverrides({ cardId: "  ", profileId: null })).toThrow(/Card id/)
  })

  it("合并进合成 CONFIG 后层级正确，其余字段继承模板", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const text = buildSyntheticConfig({
      repoRoot,
      overrides: runner.buildRunOverrides({ cardId: cardId, profileId: "profile2" }),
    })
    const config = parseYaml(text) as any
    expect(config.ai.personality.active).toBe(cardId)
    expect(config.ai.proactive.frequency).toBe("off")
    expect(config.ai.silentAccess.frequency).toBe("off")
    expect(config.appearance.activeProfile).toBe("profile2")
    expect(config.ai.model).toBeTruthy()
  })
})

describe("宿主 ready.json 所有权", () => {
  const runDir = join(tmpdir(), "desk-pet-sim-eval-ready")
  const dataRoot = join(runDir, "data")
  const pid = 4321
  const ready = {
    schemaVersion: 1,
    generation: "gen-1",
    pid,
    runDir,
    dataRoot,
    controlDir: join(dataRoot, "logs", "sim", "control"),
    runtimeMode: "development",
    startedAt: "2026-10-25T10:00:00.000Z",
  }

  it("同一进程、同一运行根、development 模式才通过", () => {
    expect(runner.validateHostReady(ready, { runDir, pid })).toBe(ready)
  })

  it("pid、运行根、数据根、控制目录、模式与 schema 任一错配都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["schema", { ...ready, schemaVersion: 2 }, /schemaVersion/],
      ["missing field", { ...ready, controlDir: "" }, /缺少字段 controlDir/],
      ["pid", { ...ready, pid: 1 }, /pid=1 与本次子进程/],
      ["pid shape", { ...ready, pid: 0 }, /pid 非法/],
      ["runDir", { ...ready, runDir: join(tmpdir(), "other") }, /runDir 与本次运行根不一致/],
      ["dataRoot", { ...ready, dataRoot: join(runDir, "elsewhere") }, /dataRoot 不在运行根下/],
      ["controlDir", { ...ready, controlDir: join(dataRoot, "logs", "sim", "other") }, /controlDir 与数据根不同源/],
      ["runtimeMode", { ...ready, runtimeMode: "production" }, /runtimeMode=production/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateHostReady(value, { runDir, pid }), label).toThrow(pattern)
    }
  })
})

describe("控制通道 ready 装载摘要", () => {
  const runDir = join(tmpdir(), "desk-pet-sim-eval-ready")
  const expected = {
    generation: "gen-1",
    hostPid: 4321,
    runDir,
    cardId,
    fixtureId,
    fixtureHash,
    ...expectedSeedFixture,
  }
  const event = {
    type: "ready",
    sessionId,
    cardId,
    generation: expected.generation,
    hostPid: expected.hostPid,
    runDir,
    seed: {
      fixtureId,
      fixtureHash,
      sessionId,
      messageCount,
      memoryItemIds: ["m1", "m2", "m3", "m4"],
      status: "seeded",
    },
  }

  it("同一宿主、同一运行根、同一 fixture 与装载结果才通过", () => {
    expect(runner.assertBridgeReady(event, expected)).toBe(event.seed)
    expect(() => runner.assertBridgeReady({ ...event, seed: { ...event.seed, status: "reused" } }, expected)).not.toThrow()
  })

  it("generation/hostPid/runDir/Card/fixture/会话/计数/状态任一错配都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["type", { ...event, type: "message" }, /不是对象/],
      ["generation", { ...event, generation: "gen-2" }, /generation/],
      ["hostPid", { ...event, hostPid: 1 }, /hostPid/],
      ["runDir", { ...event, runDir: join(tmpdir(), "other") }, /runDir/],
      ["cardId", { ...event, cardId: "other" }, /cardId/],
      ["seed missing", { ...event, seed: null }, /缺少装载摘要/],
      ["fixtureId", { ...event, seed: { ...event.seed, fixtureId: "other" } }, /fixtureId/],
      ["fixtureHash", { ...event, seed: { ...event.seed, fixtureHash: "sha256:other" } }, /fixtureHash/],
      ["sessionId", { ...event, seed: { ...event.seed, sessionId: "other" } }, /不是 fixture 会话/],
      ["messageCount", { ...event, seed: { ...event.seed, messageCount: messageCount - 1 } }, /消息数/],
      ["memoryItemIds", { ...event, seed: { ...event.seed, memoryItemIds: ["m1"] } }, /初始记忆条数/],
      ["status", { ...event, seed: { ...event.seed, status: "pending" } }, /装载状态/],
      ["active session", { ...event, sessionId: "other" }, /活跃会话不是 fixture 会话/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.assertBridgeReady(value, expected), label).toThrow(pattern)
    }
  })
})

describe("seed.json 与 runner 状态同源", () => {
  const expected = {
    fixtureId,
    fixtureHash,
    cardName,
    cardId,
    profileId: null,
    ...expectedSeedFixture,
  }
  const seed = {
    schemaVersion: 1,
    fixtureId,
    fixtureHash,
    card: { name: cardName, activeId: cardId },
    profile: { activeId: null },
    fixture,
  }

  it("prepare 写下的 fixture/Card/Profile/会话/计数一致才通过", () => {
    expect(runner.validateSeedFile(seed, expected)).toBe(seed)
  })

  it("fixture/Card/Profile/会话/计数任一被改写都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["schema", { ...seed, schemaVersion: 2 }, /schemaVersion/],
      ["fixtureId", { ...seed, fixtureId: "other" }, /fixtureId 与 runner\.json/],
      ["fixtureHash", { ...seed, fixtureHash: "sha256:other" }, /fixtureHash 与 runner\.json/],
      ["card name", { ...seed, card: { ...seed.card, name: "other" } }, /Card 名称/],
      ["card id", { ...seed, card: { ...seed.card, activeId: "other" } }, /Card id/],
      ["profile missing", { ...seed, profile: {} }, /profile\.activeId/],
      ["profile", { ...seed, profile: { activeId: "profile2" } }, /Profile 与 runner\.json/],
      ["fixture missing", { ...seed, fixture: null }, /缺少 fixture/],
      ["inner fixtureId", { ...seed, fixture: { ...fixture, fixtureId: "other" } }, /fixture\.fixtureId 不一致/],
      [
        "fixture content",
        {
          ...seed,
          fixture: {
            ...fixture,
            initialSession: {
              ...fixture.initialSession,
              messages: fixture.initialSession.messages.map((message, index) =>
                index === 0 ? { ...message, content: `${message.content}（被改写）` } : message,
              ),
            },
          },
        },
        /fixture 内容与 runner\.json/,
      ],
      ["session", { ...seed, fixture: { ...fixture, initialSession: { ...fixture.initialSession, id: "other" } } }, /初始会话/],
      [
        "messages",
        { ...seed, fixture: { ...fixture, initialSession: { ...fixture.initialSession, messages: fixture.initialSession.messages.slice(1) } } },
        /消息数/,
      ],
      ["memory", { ...seed, fixture: { ...fixture, initialMemory: [] } }, /初始记忆数/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateSeedFile(value, expected), label).toThrow(pattern)
    }
  })
})

describe("seed-report.json 所有权", () => {
  const expected = {
    fixtureId,
    fixtureHash,
    generation: "gen-1",
    hostPid: 4321,
    ...expectedSeedFixture,
  }
  const report = {
    schemaVersion: 1,
    status: "seeded",
    fixtureId,
    fixtureHash,
    sessionId,
    sessionTitle: fixture.initialSession.title,
    messageCount,
    userMessageCount,
    memoryKeys: fixture.initialMemory.map(item => item.id),
    memoryItemIds: ["m1", "m2", "m3", "m4"],
    sourceCount: userMessageCount,
    revision: 2,
    generation: "gen-1",
    hostPid: 4321,
    seededAt: "2026-10-25T10:00:01.000Z",
  }

  it("同一宿主、同一 fixture、完整装载才通过", () => {
    expect(runner.validateSeedReport(report, expected)).toBe(report)
  })

  it("状态、计数、记忆清单与宿主归属任一错配都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["schema", { ...report, schemaVersion: 2 }, /schemaVersion/],
      ["status", { ...report, status: "reused" }, /期望 seeded/],
      ["fixtureId", { ...report, fixtureId: "other" }, /fixtureId/],
      ["fixtureHash", { ...report, fixtureHash: "sha256:other" }, /fixtureHash/],
      ["sessionId", { ...report, sessionId: "other" }, /会话与 fixture/],
      ["generation", { ...report, generation: "gen-2" }, /generation/],
      ["hostPid", { ...report, hostPid: 1 }, /hostPid/],
      ["messageCount", { ...report, messageCount: messageCount - 1 }, /消息数/],
      ["userMessageCount", { ...report, userMessageCount: userMessageCount - 1 }, /用户消息数/],
      ["sourceCount", { ...report, sourceCount: userMessageCount - 1 }, /来源数/],
      ["revision", { ...report, revision: -1 }, /revision/],
      ["memoryKeys", { ...report, memoryKeys: ["only-one"] }, /记忆键数/],
      ["memoryItemIds", { ...report, memoryItemIds: [] }, /记忆条数/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateSeedReport(value, expected), label).toThrow(pattern)
    }
  })
})

describe("控制通道日志读取", () => {
  it("忽略半行/坏行，取最后一条 ready", () => {
    const events = runner.readJsonl(
      '{"type":"ready","n":1}\nnot-json\n{"type":"message"}\n{"type":"ready","n":2}\n',
    )
    expect(events).toHaveLength(3)
    expect(runner.latestBridgeReady(events)).toMatchObject({ type: "ready", n: 2 })
    expect(runner.latestBridgeReady([{ type: "message" }])).toBeUndefined()
  })
})
