import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Entry } from "@earendil-works/pi-agent-core"

import { setOverride } from "@/services/config"
import { continueInterruptedRun, discardInterruptedRun, getInterruptedRun, harnessSlots } from "@/services/engine/harness"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { disconnectAllMcpServers } from "@/services/tool/mcp"
import { fakeText, fakeToolCall, installFakeProvider } from "../../../host/fake-provider"
import { assistantTexts, countTexts, sessionEntries, sessionMessages } from "../../../host/session-entries"
import type { SceneDef } from "../../../e2e/types"

/**
 * 恢复时 MCP 借用失败的显式提示（FIX-61 的真场景）。
 *
 * ar-11 的自述缺口：既有场景是「同一准备入口的代理」（冷目录证明恢复路径自己重新准备
 * 能力），没有构造过「中断工具为 mcp_* 且本次服务器借不到」这条用户可见路径。本场景
 * 用受控本地 stdio 假 server 把它造出来：
 *
 * ① 首回合经真链路借用、发现并调用 `mcp_probe_hold_probe`；假 server 收到 `tools/call`
 *    后**永不应答**，工具在中断时保持 running（不依赖任何外部服务）；
 * ② 模拟进程被杀：直接关闭运行槽 —— 中断操作记录保留 running 的调用（会话文件里该调用由
 *    上游 pi 以带中断标记的错误结果收尾，「无结果」不成立，判据见 toolCallOutcome）；
 * ③ 中断期间能力漂移：`disconnectAllMcpServers` 复现「新进程连接表为空」（进程内模拟
 *    重启时 Node 的 MCP 管理器不会跟着死，必须显式断开），再把服务器命令换成不存在的
 *    可执行文件 —— 本次借用确定性地在宿主 spawn 处失败，进入 `unavailableMcp`；
 * ④ 继续中断运行：恢复路径必须给出**点名的显式原因**（服务器名 + 不可用 + 无法重放），
 *    把真实助手条目落盘并回传 reply，且不落上游通用文案「Tool … is unavailable」。
 *
 * 前置条件都单独断言（拒绝空断言式假通过）：假 server 必须真的收到过 tools/call；
 * 会话里必须有一条没有成功结果的 `mcp_*` 调用、中断操作记录里必须仍列着它 running；
 * 中断态必须在恢复失败后仍然暴露。
 *
 * 失败后中断态仍在是刻意的：用户还可以选择丢弃（本场景按丢弃清理，让后续回合照常可用，
 * 也证明失败没有把会话卡死）。丢弃不重放未知副作用。
 */

const SERVER = "probe"
/** `toToolDefs` 的命名规则：`mcp_<serverId>_<工具名>`。 */
const TOOL_NAME = `mcp_${SERVER}_hold_probe`
const RAW_TOOL = "hold_probe"
const FINAL_TEXT = "确认完成"
/** 上游 pi 的通用不可用文案片段：本路径必须不落它（显式原因取代它）。 */
const UPSTREAM_UNAVAILABLE_MARKER = "is unavailable"
/** 借用失败要用的、确定不存在的命令（宿主 mcp_spawn 在 spawn 处如实失败）。 */
const MISSING_COMMAND = "deskpet-e2e-missing-mcp-server"

/** 夹具脚本与调用标记的落点（测试产物边界内，每次 setup 幂等重写/清理）。 */
function fixtureDir(): string {
  // 锚点用 process.cwd()（= 仓库根，L4 由启动器在仓库根起 Node），不用 import.meta.url：
  // 场景会被打进 test/.tmp/native-host-e2e/main.mjs，届时相对路径会落到产物边界外
  // （与 MCP真IPC假server 场景同一锚点、同一理由）。
  return join(process.cwd(), "test", ".tmp", "mcp-restore-unavailable")
}
function scriptPath(): string {
  return join(fixtureDir(), "fake-server.mjs")
}
function markerPath(): string {
  return join(fixtureDir(), "called.json")
}

/** 夹具源码：最小 stdio MCP server；tools/call 记标记后不回答（工具保持 running）。 */
function fixtureSource(): string {
  return [
    'import { createInterface } from "node:readline"',
    'import { writeFileSync } from "node:fs"',
    "// 标记落点由场景经 args[2] 传入（唯一定义点在场景的 markerPath()）。",
    "const MARKER = process.argv[2]",
    "const rl = createInterface({ input: process.stdin })",
    "const reply = (id, resultJson) => {",
    '  process.stdout.write(\'{"jsonrpc":"2.0","id":\' + JSON.stringify(id) + \',"result":\' + resultJson + "}\\n")',
    "}",
    'rl.on("line", line => {',
    "  let msg",
    "  try { msg = JSON.parse(line) } catch { return }",
    '  if (msg.method === "initialize") {',
    '    const version = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05"',
    '    reply(msg.id, JSON.stringify({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "deskpet-l4-hold", version: "1.0.0" } }))',
    '  } else if (msg.method === "tools/list") {',
    '    reply(msg.id, JSON.stringify({ tools: [{ name: "hold_probe", description: "L4 恢复借用失败探针（tools/call 永不回答）", inputSchema: { type: "object", properties: {} } }] }))',
    '  } else if (msg.method === "tools/call") {',
    "    // 调用确实到达了假 server（真实链路证据）；此后不回答，中断时工具保持 running。",
    "    writeFileSync(MARKER, JSON.stringify({ tool: msg.params?.name }))",
    "  }",
    "})",
    'rl.on("close", () => process.exit(0))',
    "",
  ].join("\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 有界等待：条件成立即返回，超时抛错（带等待对象名，失败原因可诊断）。 */
async function waitFor(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(100)
  }
  throw new Error(`等待超时：${what}`)
}

interface RawToolCallPart {
  type?: string
  id?: string
  name?: string
}

/**
 * 会话里某个工具「被调用过、且没有以成功结果收尾」的证据（恢复前提的会话侧判据）。
 *
 * 不能用「完全没有 toolResult」当判据：本场景的中断由关闭运行槽模拟，上游 pi 在中断收尾时
 * 会给 in-flight 调用补一条带中断标记的错误结果（isError=true）——「无结果」在这条路径上
 * 永远不成立。真实前提是「调用进了会话、且从未产生成功结果」；「仍被记着 running」由中断
 * 操作记录单独断言（见 setup 的有界等待）。
 */
function toolCallOutcome(entries: Entry[], toolName: string): { calls: number; successResults: number } {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== "message") continue
    const message = entry.message
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content as RawToolCallPart[]) {
      if (part?.type === "toolCall" && part.id && part.name === toolName) ids.add(part.id)
    }
  }
  let successResults = 0
  for (const entry of entries) {
    if (entry.type !== "message") continue
    const message = entry.message
    if (message.role !== "toolResult") continue
    if (typeof message.toolCallId !== "string" || !ids.has(message.toolCallId)) continue
    if (message.isError !== true) successResults += 1
  }
  return { calls: ids.size, successResults }
}

/** 前提不成立时的条目概览：角色 + 工具调用/结果身份与结果性质，失败原因可直接定位（不靠猜）。 */
function entryDigest(entries: Entry[]): string {
  return entries.map(entry => {
    if (entry.type !== "message") return entry.type
    const message = entry.message
    if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "no-id"
      const text = Array.isArray(message.content)
        ? message.content.map(part => part.type === "text" ? part.text : "").join("").slice(0, 24)
        : String(message.content ?? "").slice(0, 24)
      return `toolResult(${id},isError=${String(message.isError)},${JSON.stringify(text)})`
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message.role
    const calls = (message.content as RawToolCallPart[])
      .filter(part => part?.type === "toolCall")
      .map(part => `${part.name ?? "?"}#${part.id ?? "?"}`)
    return calls.length > 0 ? `assistant[${calls.join(",")}]` : `assistant(${message.stopReason})`
  }).join("; ")
}

let resumedReply: string | undefined
let resumedFailure: { kind?: string; message?: string } | undefined
let resumedEntryTexts: string[] = []
let interruptedSeen = false
let interruptedAfterFailedResume = false
let interruptedAfterDiscard = true

export const 恢复MCP借用失败: SceneDef = {
  meta: {
    caseId: "runtime-resume-mcp-unavailable",
    module: "agent-runtime",
    contractId: "ar-11",
    description: "中断工具为 mcp_* 且本次服务器借不到时，继续中断运行以点名的显式原因失败：真实助手条目落盘、reply 返回、不落上游通用不可用文案，失败后中断态仍留给用户选择",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "recovery", "mcp", "error", "boundary"],
    // MCP 工具在发现侧就是 DANGER（sf-21）：默认安全模式下走确认，场景按 approve 放行。
    confirmPolicy: "approve",
  },
  setup: async () => {
    rmSync(markerPath(), { force: true })
    mkdirSync(dirname(scriptPath()), { recursive: true })
    writeFileSync(scriptPath(), fixtureSource(), "utf8")
    // 自定义服务器走 stdio；includeTools 收窄到探针工具（借用成功即注册该工具）。
    // 标记落点必须经 args 交给夹具：夹具在 tools/call 分支写它，argv[2] 缺失会在
    // 首次调用时抛 ERR_INVALID_ARG_TYPE、连接断开，等待只会等到超时。
    setOverride("tools.mcp.servers", [{
      name: SERVER,
      transport: "stdio",
      command: "node",
      args: [scriptPath(), markerPath()],
      enabled: true,
      includeTools: [RAW_TOOL],
    }])

    await initChat()
    // 夹具初始化（Card/stages）先完成再装 Provider：初始化不该消费回合脚本。
    installFakeProvider([
      // MCP 工具默认不进请求（按回合动态激活）：先经取用入口启用再调用它。
      fakeToolCall("enable_tools", { names: [TOOL_NAME] }, "mcp-resume-enable"),
      fakeToolCall(TOOL_NAME, {}, "mcp-resume-hold"),
      fakeText(FINAL_TEXT),
    ])
    const sessionId = getActiveSessionId()

    // ① 首回合：真借用 → 发现 → 取用 → 调用；假 server 收到调用后保持 running。
    const firstTurn = sendMessage("调用那个会一直卡住的 MCP 工具。")
    await waitFor("假 MCP server 收到 tools/call（工具进入执行）", () => existsSync(markerPath()))
    // 模拟进程被杀：不 abort，直接关闭运行槽 —— 中断操作记录保留 in-flight 的工具调用。
    await harnessSlots.reset()
    await firstTurn.catch(() => undefined)

    // 中断操作必须真的记着这条 mcp_* running 工具（恢复分支的输入；不成立就明确红在前提上）。
    interruptedSeen = (await getInterruptedRun(sessionId)) !== undefined
    await waitFor("中断操作记录里出现 running 的 mcp 工具", async () => {
      const names = await harnessSlots.peek(sessionId)?.pendingInterruptedToolNames()
      return (names ?? []).includes(TOOL_NAME)
    })

    // ② 中断期间能力漂移。先断掉进程内残留的 MCP 连接：本场景在同一个 Node 进程里模拟
    //    重启，而真实重启后管理器是空的 —— 不断开的话 acquire 会命中保活连接、借得到。
    await disconnectAllMcpServers()
    //    再把命令换成不存在的可执行文件：本次借用确定性地在宿主 spawn 处失败。
    setOverride("tools.mcp.servers", [{
      name: SERVER,
      transport: "stdio",
      command: MISSING_COMMAND,
      enabled: true,
      includeTools: [RAW_TOOL],
    }])

    // ③ 继续中断运行：借用失败必须在准备阶段被显式判定，不进入重放。
    const resumed = await continueInterruptedRun(sessionId)
    resumedReply = resumed?.reply
    resumedFailure = resumed?.failure
    // 「条目落盘」的读取放在验收轮：pi lane 的消息到驱动/关闭边界才写进 JSONL，
    // 恢复刚返回时读会话文件看不到本次追加（实测连中断标记都还没落），这里读只会读到空。

    // 失败后中断态仍在（用户还能选择丢弃）；本场景按丢弃清理，让后续回合照常可用。
    interruptedAfterFailedResume = (await getInterruptedRun(sessionId)) !== undefined
    await discardInterruptedRun(sessionId)
    interruptedAfterDiscard = (await getInterruptedRun(sessionId)) !== undefined
  },
  turns: [{
    index: 1,
    description: "核对借用失败以显式原因收口：条目落盘、reply 返回、无上游通用文案、中断态归属正确",
    userText: "确认一下刚才的处理。",
    checks: [{
      type: "expectResumeFailsWithExplicitMcpUnavailableReason",
      run: async () => {
        // ── 前提：假 server 真的收到过 mcp_* 调用，且会话里这条调用没有结果 ──
        const marker = JSON.parse(readFileSync(markerPath(), "utf8")) as { tool?: string }
        if (marker.tool !== RAW_TOOL) {
          throw new Error(`假 server 收到的调用不是探针工具（前提不成立）: ${JSON.stringify(marker)}`)
        }
        const entriesNow = await sessionEntries()
        // 到这一轮为止的助手正文（含恢复路径落盘的显式原因）：落盘证据在验收轮读，见 setup ③ 的注释。
        resumedEntryTexts = assistantTexts(await sessionMessages())
        const outcome = toolCallOutcome(entriesNow, TOOL_NAME)
        if (outcome.calls === 0) {
          throw new Error(`会话里没有 ${TOOL_NAME} 的调用条目，「中断工具为 mcp_*」前提不成立｜条目概览: ${entryDigest(entriesNow)}`)
        }
        if (outcome.successResults > 0) {
          throw new Error(`${TOOL_NAME} 有成功结果，不是被中断的未完成调用（前提不成立）｜条目概览: ${entryDigest(entriesNow)}`)
        }
        if (!interruptedSeen) throw new Error("关闭运行槽后没有暴露中断运行")

        // ── 显式原因：点名服务器、说明不可用与无法重放 ──
        if (!resumedReply) throw new Error("继续中断运行没有返回结果")
        if (!resumedReply.includes(`MCP 服务器 ${SERVER}`)) {
          throw new Error(`恢复失败原因没有点名服务器 ${SERVER}: ${JSON.stringify(resumedReply)}`)
        }
        if (!resumedReply.includes("不可用") || !resumedReply.includes("无法重放")) {
          throw new Error(`恢复失败原因没有说清「不可用 / 无法重放」: ${JSON.stringify(resumedReply)}`)
        }
        if (!resumedFailure || resumedFailure.kind !== "unknown") {
          throw new Error(`恢复失败没有按能力不足收口: ${JSON.stringify(resumedFailure)}`)
        }
        if (resumedFailure.message !== resumedReply) {
          throw new Error(`failure.message 与 reply 不一致（两处文案分叉）: ${JSON.stringify(resumedFailure.message)}`)
        }

        // ── 真实助手条目落盘且恰好一次；不落上游通用文案 ──
        if (countTexts(resumedEntryTexts, resumedReply) !== 1) {
          throw new Error(`显式原因没有恰好落一条助手条目: ${JSON.stringify(resumedEntryTexts)}｜条目概览: ${entryDigest(entriesNow)}`)
        }
        if (resumedEntryTexts.some(text => text.includes(UPSTREAM_UNAVAILABLE_MARKER))) {
          throw new Error(`会话里落了上游通用不可用文案: ${JSON.stringify(resumedEntryTexts)}`)
        }

        // ── 状态归属：失败后中断态仍在（留给用户丢/弃决定），丢弃后才清除 ──
        if (!interruptedAfterFailedResume) throw new Error("借用失败后中断态被静默吞掉（用户失去丢弃出口）")
        if (interruptedAfterDiscard) throw new Error("丢弃之后中断态仍在")
      },
    }],
  }],
}

export default 恢复MCP借用失败
