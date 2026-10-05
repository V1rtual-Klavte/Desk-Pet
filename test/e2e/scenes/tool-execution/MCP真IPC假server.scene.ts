import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SceneDef } from "../../../e2e/types"
import type { Entry } from "@earendil-works/pi-agent-core"
import { fakeText, fakeToolCall, installFakeProvider } from "../../../host/fake-provider"
import { setOverride } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { sessionEntries } from "../../../host/session-entries"

/**
 * 自定义 stdio MCP 服务器经**真 IPC**走完整生产链（te-29）。
 *
 * 覆盖目标是 MCP stdio 的执行级空白（旧登记：TS↔Rust 参数键接线没有走真 IPC 的端到端证据）：
 * 场景把一台**脚本假 server**（由本文件写出、单一定义点）挂进 `tools.mcp.servers`，
 * 借真实运行链完成 spawn → initialize 握手 → tools/list 发现 → enable_tools 取用 →
 * tools/call → 结果落条目，断言条目正文与夹具发出的字节**逐字一致**。
 *
 * 三件事只有真链路才能同时成立：
 * ① 工具名 `mcp_probe_echo_probe` 只可能来自真实 `tools/list` 的发现结果（假 server 现场应答）；
 * ② 结果正文是本文件构造、经夹具进程原样回传的 200KB 级载荷（>64KiB 控制帧，必然走
 *    mcp_read 整行字符串的既有 blob 物化路径）——宿主不接触这份构造，无法伪造；
 * ③ 夹具在每次应答前向 stdout 混一条非 JSON 调试行：链路必须跳过它而不断流
 *    （Rust 侧 `mcp_read` 的跳过语义在真 IPC 上的执行级证据）。
 *
 * 夹具脚本落在 `test/.tmp/mcp-real-ipc/`（测试产物边界内，每次 setup 幂等重写）。
 */

const SERVER = "probe"
/** `toToolDefs` 的命名规则：`mcp_<serverId>_<工具名>`。 */
const TOOL_NAME = `mcp_${SERVER}_echo_probe`
const CALL_ID = "mcp-real-ipc-call"
const ENABLE_CALL_ID = "enable-mcp-real-ipc"
const REPLY = "真 IPC 探针已经返回。"
const PAYLOAD_HEAD = "MCP-REAL-IPC-PROBE:"
const PAYLOAD_TAIL = ":PROBE-END"
const PROBE_CHUNK = "探针数据"
const BODY_REPEAT = 20_000
/** 夹具 stdout 上刻意混入的调试行（非 JSON）：链路必须跳过。 */
const NOISE_LINE = "probe-debug: 这一行不是 JSON"

/** 夹具将回传的载荷与整条 `result` 的字节（唯一构造点，夹具经 JSON 转义原样携带）。 */
const PAYLOAD = `${PAYLOAD_HEAD}${PROBE_CHUNK.repeat(BODY_REPEAT)}${PAYLOAD_TAIL}`
const EXPECTED_TEXT = JSON.stringify({ content: [{ type: "text", text: PAYLOAD }] })
/** mcp_read 的响应行是单条字符串：超过 64KiB 控制帧限额即走 blob 物化。 */
const FRAME_BOUNDARY_BYTES = 64 * 1024

/** 夹具源码：最小 stdio MCP server（错误路径不吞：解析失败即忽略该行）。 */
function fixtureSource(): string {
  return [
    'import { createInterface } from "node:readline"',
    "// 结果字节由场景文件注入（唯一构造点；夹具只负责原样回传）。",
    `const RESULT_JSON = ${JSON.stringify(EXPECTED_TEXT)}`,
    `const NOISE_LINE = ${JSON.stringify(NOISE_LINE)}`,
    "const rl = createInterface({ input: process.stdin })",
    "const reply = (id, resultJson) => {",
    "  // 每次应答前混入非 JSON 调试行（stdout）：链路必须跳过它而不断流。",
    '  process.stdout.write(NOISE_LINE + "\\n")',
    '  process.stdout.write(\'{"jsonrpc":"2.0","id":\' + JSON.stringify(id) + \',"result":\' + resultJson + "}\\n")',
    "}",
    'rl.on("line", line => {',
    "  let msg",
    "  try { msg = JSON.parse(line) } catch { return }",
    '  if (msg.method === "initialize") {',
    "    const version = typeof msg.params?.protocolVersion === \"string\" ? msg.params.protocolVersion : \"2024-11-05\"",
    '    reply(msg.id, JSON.stringify({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "deskpet-l4-probe", version: "1.0.0" } }))',
    '  } else if (msg.method === "notifications/initialized") {',
    "    // 无需应答。",
    '  } else if (msg.method === "tools/list") {',
    '    reply(msg.id, JSON.stringify({ tools: [{ name: "echo_probe", description: "L4 真 IPC 探针（脚本假 server）", inputSchema: { type: "object", properties: {} } }] }))',
    '  } else if (msg.method === "tools/call" && msg.params?.name === "echo_probe") {',
    "    reply(msg.id, RESULT_JSON)",
    "  }",
    "})",
    'rl.on("close", () => process.exit(0))',
    "",
  ].join("\n")
}

/** 夹具脚本的绝对路径（test/.tmp 在产物边界内）。 */
function fixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "..", "..", "..", ".tmp", "mcp-real-ipc", "fake-server.mjs")
}

function archivedToolText(entry: Entry, toolCallId: string): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined
  if (entry.message.toolCallId !== toolCallId) return undefined
  return entry.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n")
}

let provider: ReturnType<typeof installFakeProvider> | undefined

export const MCP真IPC假server: SceneDef = {
  meta: {
    caseId: "tool-mcp-real-ipc-bridge",
    module: "tool-execution",
    contractId: "te-29",
    description: "脚本假 server 经真 IPC 借用到结果落盘：发现→取用→调用全链通过，非 JSON 行被跳过，>64KiB 结果行经 blob 物化后逐字一致",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["tool-execution", "mcp", "production-entry", "boundary"],
    // MCP 工具在发现侧就是 DANGER（sf-21）：默认安全模式下走确认，场景按 approve 放行。
    confirmPolicy: "approve",
  },
  setup: async () => {
    const script = fixturePath()
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, fixtureSource(), "utf8")
    // 自定义服务器走 stdio；includeTools 收窄到探针工具（借用成功即注册该工具）。
    setOverride("tools.mcp.servers", [{
      name: SERVER,
      transport: "stdio",
      command: "node",
      args: [script],
      enabled: true,
      includeTools: ["echo_probe"],
    }])
    await initChat()
    provider = installFakeProvider([
      // MCP 工具默认不进请求（按回合动态激活）：先经取用入口启用再调用它。
      fakeToolCall("enable_tools", { names: [TOOL_NAME] }, ENABLE_CALL_ID),
      fakeToolCall(TOOL_NAME, {}, CALL_ID),
      fakeText(REPLY),
    ])
  },
  turns: [{
    index: 1,
    description: "真 IPC：借用→发现→取用→调用→巨型结果逐字落条目",
    userText: "调用那个真 IPC 探针工具。",
    checks: [{
      type: "expectMcpRealIpcBridge",
      run: async ctx => {
        if (ctx.output.failure) throw new Error(`回合失败: ${JSON.stringify(ctx.output.failure)}`)
        if (!ctx.output.reply.includes(REPLY)) {
          throw new Error(`回合没有被真实驱动到脚本回复（fake provider 脚本错位）: ${JSON.stringify(ctx.output.reply)}`)
        }
        if (EXPECTED_TEXT.length <= FRAME_BOUNDARY_BYTES) {
          throw new Error(`探针体量不足（${EXPECTED_TEXT.length} 字节级），跨帧边界断言不成立`)
        }
        if (!provider) throw new Error("fake provider 未安装（场景前提失效）")

        // ① 真实发现→取用→调用：工具名只可能来自假 server 现场应答的 tools/list。
        const call = ctx.toolHistory.find(item => item.toolName === TOOL_NAME)
        if (!call || call.status !== "done") {
          throw new Error(`MCP 工具没有经真链路执行完成: ${JSON.stringify(ctx.toolHistory)}`)
        }
        // 唯一有区分力的通道事实是「请求真的到达了确认通道」（DANGER→ask，场景 approve 放行）。
        if (!ctx.confirms.some(record => record.toolName === TOOL_NAME)) {
          throw new Error(`MCP 工具没有留下确认记录: ${JSON.stringify(ctx.confirms)}`)
        }

        // ② 结果字节逐字一致：条目正文 = 本文件构造、经夹具进程原样回传的载荷。
        //    夹具在应答前混入的非 JSON 行若没被跳过，链路会在读侧卡住/报错，这里就不可能成立。
        const entries = await sessionEntries()
        const entry = entries.find(item => item.type === "message" && item.message.role === "toolResult"
          && item.message.toolCallId === CALL_ID)
        if (!entry || entry.type !== "message") throw new Error("会话条目缺少这条 MCP 结果")
        const archived = archivedToolText(entry, CALL_ID)
        if (archived !== EXPECTED_TEXT) {
          throw new Error(`条目正文与夹具字节不一致: ${archived?.length ?? 0} 字符（应为 ${EXPECTED_TEXT.length}）`)
        }
        // 独立判据（不依赖上面期望串的构造）：载荷头尾标记必须都在正文里，且正文确实超过帧边界。
        if (!archived.startsWith(`{"content":[{"type":"text","text":"${PAYLOAD_HEAD}`)) {
          throw new Error(`条目正文开头不是夹具载荷头: ${JSON.stringify(archived.slice(0, 60))}`)
        }
        if (!archived.endsWith(`${PAYLOAD_TAIL}"}]}`)) {
          throw new Error(`条目正文结尾不是夹具载荷尾: ${JSON.stringify(archived.slice(-40))}`)
        }
        if (archived.length <= FRAME_BOUNDARY_BYTES) {
          throw new Error(`条目正文没有跨过 64KiB 帧边界（${archived.length} 字符）——blob 路径未被真实走到`)
        }
      },
    }],
  }],
}

export default MCP真IPC假server
