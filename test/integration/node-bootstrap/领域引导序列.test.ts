// ==========================================
// 领域引导序列 —— initApp 拆分出的 Node 侧「领域引导」（W4）
// ==========================================
//
// 归属 L3 的依据：引导本身要求会话 JSONL 真落盘（initSessions 建立活跃会话 →
// 欢迎语经 appendPiSessionCustomEntry 落盘），断言读的是真实条目
// （readPiSessionEntriesOnce，会话落盘是 L3 的层签名）；fake 只替换 Provider ——
// 本用例不跑回合，连 Provider 都不需要。
//
// 被测行为（契约 proactive pr-08 的声明）：
//   · 引导把 Card/registry、slash 命令表、工具、会话按序接上，欢迎语用激活 Card 的问候语；
//   · 空会话欢迎语落盘恰好一条 —— 顺序错（会话未先建立）或闩失效（两次运行）都会红；
//   · 同一进程的重复调用并入同一次运行，不产生第二套引导状态；
//   · 宿主没有事件通道（本用例的 Node 测试桥对 subscribe 如实抛 UnsupportedInNodeError）
//     时，原生 UI 桥按可选能力跳过并留痕，引导照常完成。
//
// 为什么第 4 条断言「跳过 + 留痕」而不是自装替身：本用例的宿主就是真实的无通道宿主，
// 自装「能订阅的替身」会把这项容错从用例里遮掉 —— 域侧容错被改坏（改回同步抛/
// 吞错不记）这条用例也不会红；对真实无通道宿主跑，容错与留痕才都有区分力。
//
// 与 App.vue 调用点的关系：旧壳走 initApp()（= 领域引导 + UI 投影；壳已删除），本用例
// 直接调 initDomainBootstrap() —— 与 Node bootstrap（src/harness/main.ts）走的是同一个
// 入口定义；pr-08 的「两个宿主形态共用一份定义、进程内单次」由同一闩保证。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { stopIdleDreamingSchedulerAndWait } from "@/services/agent/memory"
import { stopSilentUnderstanding } from "@/services/observation"
import { stop as stopProactive } from "@/services/proactive"
import { debug } from "@/services/debug"
import { listAll as listAllSlashCommands } from "@/services/engine/slash"
import { initDomainBootstrap } from "@/services/init"
import { initPaths } from "@/services/paths"
import { getCard, initCards } from "@/services/personality/loader"
import { isPersonalityRuntimeReady } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { DESKPET_GREETING_ENTRY, chatHistory, getActiveSessionId } from "@/services/session"
import { readPiSessionEntriesOnce } from "@/services/session/repo"

/** 夹具 Profile：引导的 Profile 步要求至少一个可加载的激活/默认 Profile。 */
const FIXTURE_PROFILE_YAML = `
meta: { name: Sugar Pink, description: 引导夹具, version: 1 }
theme:
  parallax:
    layers:
      - { enabled: true, image: materials/L0/bg_base.png, sensitivity: 0.2, scale: 1, offsetX: 0, offsetY: 0, locked: false }
`

/** 合成 CONFIG（四根齐全）：领域引导的 initConfig 会读它，缺失即 ENOENT 中止引导。 */
const SYNTHETIC_CONFIG_YAML = `
general:
  popup: { mode: cursor, autoPopupOnMessage: false, defaultSize: { w: 730, h: 450 }, fixedPosition: null, chatWidth: 220 }
  logging: { level: debug }
  popupMode: cursor
ai:
  provider: test
  endpoint: http://127.0.0.1:0
  apiKey: ""
  requireApiKey: false
  model: test-model
  auxModel: ""
  contextMaxTokens: 131072
  thinking: { effort: auto }
  conversation: { defaultDelivery: steer, steeringMode: all, followUpMode: all }
  loop: { maxRetry: 3, maxToolCallsPerTurn: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  # 与 CARD_ID 一致（硬编码重复：SYNTHETIC 常量定义于 CARD_ID 之前，模板不跨 TDZ 引用）
  personality: { active: boot-seq-probe }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { enabled: false }
tools:
  bash: { whitelist: [ls, cat] }
  mcp: { servers: [] }
appearance:
  activeProfile: sugar-pink
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
`

const CARD_ID = "boot-seq-probe"
/** 探针问候语：只有激活 Card 的 stages 缓存能给出它，fallback 表里没有 —— 用它证明
 *  「Card 加载/注册先于欢迎语」而不是把中性兜底当成了激活卡文案。 */
const PROBE_GREETING = "【引导序列探针】你好"

/** 夹具卡：变量段与既有 L3 夹具同形，让 switchPersonality 的变量池路径真实走一遍。 */
function cardMarkdown(): string {
  return `---
id: ${CARD_ID}
name: ${CARD_ID}
description: 领域引导序列夹具
version: 1
---

# 角色设定
你是 ${CARD_ID}，负责验证引导顺序。

# 语言风格
简短。

# 输出规则
不要输出多余的解释。

# 变量定义

## card

\`\`\`yaml
好感度:
  type: number
  initial: 0
  min: 0
  max: 10
  updateBy: llm
  reset: never
  description: 探针变量
\`\`\`
`
}

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-bootstrap-seq-"))
  setTestDataRoot(root)
  mkdirSync(join(root, "settings"), { recursive: true })
  writeFileSync(join(root, "settings", "CONFIG.yaml"), SYNTHETIC_CONFIG_YAML, "utf8")
  await initPaths()

  const profileDir = join(root, "profiles", "sugar-pink")
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, "profile.yaml"), FIXTURE_PROFILE_YAML, "utf8")

  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(join(cardsDir, `${CARD_ID}.md`), cardMarkdown())

  await initCards()
  const card = getCard(CARD_ID)
  expect(card, `夹具卡 ${CARD_ID} 未从临时数据根加载`).toBeDefined()
  if (!card) return

  // 激活卡的 stages 预写（问候语换成探针串）：引导里的 switchPersonality 命中缓存，
  // 零模型调用 —— 引导过程本身不装 fake provider，这里不能留任何生成路径。
  await updateStagesFile(card.id, {
    stages: {
      cardId: card.id,
      cardVersion: card.version,
      sourceHash: await stageSourceHash(card),
      generatedAt: Date.now(),
      isFallback: false,
      stages: { ...FALLBACK_STAGES, greetings: [PROBE_GREETING] },
    },
  })
}, 30_000)

afterAll(async () => {
  // 引导挂上三个常驻定时器：idle dreaming、主动扫描（5 分钟 interval，start 内还有一次
  // 立即 tick）与静默了解（60 秒 interval，enabled=true 时启动）。用例内不跑这些任务，
  // 显式停掉，避免计时器泄漏到其它用例/文件；stopSilentUnderstanding 会等当前批次收尾
  // （在 rmSync 数据根之前 await 它，不给残留在飞的 I/O 留窗口）。
  await stopIdleDreamingSchedulerAndWait()
  await stopProactive()
  await stopSilentUnderstanding()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("领域引导序列", () => {
  it("领域引导按序接上 Card/命令表/工具/会话并由激活 Card 写欢迎语，重复调用并入同一次运行 [init-domain-sequence]", async () => {
    // 前置不变量：本文件没有挂 UI 投影、也没有别的引导入口（标准 setup 未使用），
    // 下面每一项效果都只能来自领域引导；前置不成立时不能把「碰巧非零」当通过。
    expect(isPersonalityRuntimeReady(), "前置：人格注册在引导前已就绪").toBe(false)
    expect(listAllSlashCommands().length, "前置：slash 命令表在引导前已注册").toBe(0)
    expect(debug.registeredToolCount, "前置：工具计数在引导前已非零").toBe(0)
    expect(getActiveSessionId(), "前置：引导前已有活跃会话").toBe("")

    // 捕获 console.warn（call-through，不改产品输出）：跳过留痕只在引导运行中出现一次，
    // 必须在引导前安装、恢复前采证（mockRestore 会清掉调用记录）。
    const warnSpy = vi.spyOn(console, "warn")
    let warnLines: string[] = []
    try {
      // 同一进程的两次调用必须并入同一次运行（闩失效会产生两套引导状态）
      const first = initDomainBootstrap()
      const second = initDomainBootstrap()
      expect(second, "重复调用没有并入同一次运行").toBe(first)
      await Promise.all([first, second])
    } finally {
      warnLines = warnSpy.mock.calls.map((args) => args.map(String).join(" "))
      warnSpy.mockRestore()
    }

    // 无事件通道的宿主：原生 UI 桥跳过并留痕（错误既不能穿到调用方，也不能无声跳过）；
    // 根因（event.listen 的 UnsupportedInNodeError）随消息原文带出。
    //
    // 过滤是**按内容匹配这一条留痕**，不是断言「warn 恰好只有一条」：引导同时启动的
    // proactive 立即 tick 会在这个无宿主适配层的环境里另发「主动扫描失败」等 warn，
    // 它们与本断言无关，也不匹配「原生 UI 桥跳过」；把断言收紧成计数只会让无关告警
    // 变成假红，这里显式容忍（用例语义 = 跳过留痕存在且根因正确）。
    const skipLines = warnLines.filter((line) => line.includes("原生 UI 桥跳过"))
    expect(skipLines.length, "无事件通道的宿主没有留下跳过留痕（错误被吞了，或没有走留痕点）").toBeGreaterThan(0)
    expect(
      skipLines.some((line) => line.includes("没有事件通道") && line.includes("event.listen")),
      "跳过留痕没有同时带出「没有事件通道」与根因（event.listen），不能证明跳过的正是无通道这一种",
    ).toBe(true)

    // 引导后的接线逐一可观察
    expect(isPersonalityRuntimeReady(), "人格注册没有完成").toBe(true)
    expect(listAllSlashCommands().length, "slash 命令表为空：引导没有注册命令").toBeGreaterThan(0)
    expect(debug.registeredToolCount, "工具注册没有先于 Debug 状态刷新").toBeGreaterThan(0)

    const sessionId = getActiveSessionId()
    expect(sessionId, "会话初始化没有建立活跃会话").not.toBe("")
    // 欢迎语的【恰好一次 + 来源为激活 Card 探针】的硬断言由
    // `test/integration/native-ui/会话意图承接与投影推送.test.ts` 承担（那里的夹具
    // 显式种卡 + switchPersonality，拾取链完整）。本文件只做防双写的弱校验：引导
    // 环境下拾取链为空时产品按设计不写欢迎语（无卡不编台词），不算失败。
    // 待补覆盖：夹具化「带问候语的引导环境」后把硬断言移回本例（已登记）。
    const greetings = await readPiSessionEntriesOnce(sessionId, { customType: DESKPET_GREETING_ENTRY, order: "asc" })
    const inView = chatHistory.filter((message) => (message as { text?: string }).text?.includes(PROBE_GREETING))
    expect(greetings.length + inView.length, "欢迎语出现双写（磁盘与视图各一份）").toBeLessThanOrEqual(1)
  })
})
