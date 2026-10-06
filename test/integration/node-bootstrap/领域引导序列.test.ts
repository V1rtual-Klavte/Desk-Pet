// ==========================================
// 领域引导序列 —— initApp 拆分出的 Node 侧「领域引导」（W4）
// ==========================================
//
// 归属 L3 的依据：引导本身要求会话 JSONL 真落盘（initSessions 建立活跃会话 →
// 欢迎语经 appendPiSessionCustomEntry 落盘），断言读的是真实条目
// （readPiSessionEntriesOnce，会话落盘是 L3 的层签名）；本用例不跑回合，不需要 Provider。
// 唯一的夹具替身是主动台账的只读查询（见下方 vi.mock 的说明）：L3 没有该后端，
// 不打平它，「空会话」前提会被读取失败的提示消息破坏，欢迎语链整条测不到。
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
import { computeLogLevel } from "@/services/config"
import { getLogLevel } from "@/services/logger"
import { stopSilentUnderstanding } from "@/services/observation"
import { stop as stopProactive } from "@/services/proactive"
import { debug } from "@/services/debug"
import { listAll as listAllSlashCommands } from "@/services/engine/slash"
import { initDomainBootstrap } from "@/services/init"
import { initPaths } from "@/services/paths"
import { getActivePersonalityId, pickActiveGreeting } from "@/services/personality"
import { loadCard } from "@/services/personality/loader"
import { isPersonalityRuntimeReady } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { DESKPET_GREETING_ENTRY, chatHistory, getActiveSessionId } from "@/services/session"
import { readPiSessionEntriesOnce } from "@/services/session/repo"

// 夹具替身（只在**这一条只读查询**上）：L3 宿主没有主动台账（SQLite 归 Rust，
// `proactive_query` 在 Node 适配层按 unsupported.ts 的分类调用即抛）。领域引导的
// `initSessions → activateSession → reconcileActiveReceipts` 会查一次台账；查询失败被
// `loadMessagesFromSession` 如实归到「会话正文读取失败」，并把那条系统提示推进会话视图 ——
// 「空会话」的前提因此被打破，引导的欢迎语步会被跳过（首跑红点根因，不是欢迎语链本身坏了）。
// 这里返回本宿主真实的台账状态（空：L3 产生不了任何主动尝试），让夹具回到产品全新安装的
// 空会话形态；写侧（change/claim/settle/reconcile）不替身，保持「调用即抛」。
vi.mock("@/services/proactive/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/proactive/ipc")>()
  return {
    ...actual,
    query: async () => ({ tasks: [], attempts: [], revision: 0 }),
  }
})

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
  loop: { maxRetry: 3, subAgentRounds: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  # 与 CARD_ID 一致（硬编码重复：SYNTHETIC 常量定义于 CARD_ID 之前，模板不跨 TDZ 引用）
  personality: { active: boot-seq-probe }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
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

  const card = await loadCard(CARD_ID)
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
    expect(debug.registeredTools.length, "前置：工具列表在引导前已非空").toBe(0)
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
    expect(debug.registeredTools.length, "工具注册没有先于 Debug 状态刷新").toBeGreaterThan(0)

    // 引导期日志级别：initConfig() 之后即在引导内应用（`init.ts` 的 applyLogLevel()）——
    // 不应用则级别停在 logger 保守默认 info，主动链路（scanner/observation 等）的 debug
    // 证据会静默丢失。判据用运行期派生值本身：本用例宿主 runtimeMode=development →
    // computeLogLevel()="debug" ≠ 默认 "info"，去掉引导里的 applyLogLevel() 这里会红。
    expect(getLogLevel(), "引导期没有应用真实日志级别（computeLogLevel 的派生值未注入 logger）").toBe(computeLogLevel())

    const sessionId = getActiveSessionId()
    expect(sessionId, "会话初始化没有建立活跃会话").not.toBe("")
    // 夹具前提（带问候语的引导环境）：引导必须真的激活探针卡，且它的 stages 缓存已装载 ——
    // 否则下面对「欢迎语来源」的断言会退化成对中性兜底的断言。拾取链不成立就报红，
    // 而不是像旧版那样把「没写欢迎语」也放行（那会让整条落盘链没有断言）。
    expect(getActivePersonalityId(), "引导没有激活探针卡，夹具前提（带问候语的引导环境）不成立").toBe(CARD_ID)
    expect(pickActiveGreeting(), "探针卡的问候语在引导后不可拾取（stages 缓存未装载）").toBe(PROBE_GREETING)

    // 无 run 会话的宿主条目落盘（node-bootstrap 路径的硬断言）：引导建立的活跃会话没有槽、
    // 没有 run，欢迎语仍必须**真落盘**恰好一条，且正文来自激活 Card 的问候语
    // （探针串只可能来自激活卡的 stages 缓存，中性兜底表里没有它）。
    // 旧版按「磁盘或视图」软计数（`<= 1`）——「只在视图、磁盘没有」也算通过，正是要补的洞。
    const greetings = await readPiSessionEntriesOnce(sessionId, { customType: DESKPET_GREETING_ENTRY, order: "asc" })
    expect(greetings.length, "欢迎语没有落盘恰好一条（无 run 会话的宿主条目也必须持久）").toBe(1)
    const greetingEntry = greetings[0]
    expect(greetingEntry?.type, "欢迎语条目不是 custom 条目（落盘形态被改坏）").toBe("custom")
    expect(
      greetingEntry?.type === "custom" ? (greetingEntry.data as { text?: string } | undefined)?.text : undefined,
      "落盘的欢迎语不是激活 Card 的问候语（落到了中性兜底或别的来源）",
    ).toBe(PROBE_GREETING)
    // 视图侧不得重复推送同一句（重载由读模型从条目带回；推两次会让用户看到两遍）。
    const inView = chatHistory.filter((message) => (message as { text?: string }).text?.includes(PROBE_GREETING))
    expect(inView.length, "欢迎语在会话视图里重复推送").toBeLessThanOrEqual(1)
  })
})
