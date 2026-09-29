// ==========================================
// 子代理工具面 —— 从 test/e2e/scenes/tool-execution/子代理工具面.scene.ts 迁到 L3
// ==========================================
//
// 子代理不派生（te-23）：`runPiSubAgent` 按工具自己声明的 `policy.execution.isolation
// !== "delegate"` 过滤，派生型工具不下放；子代理自身再用固定白名单（pi-read +
// local-system-info + pi-bash）收窄。本用例从 `runForkAgent` 这条真实 fork 通路观察两件事：
//
// ① **发出去的请求里到底有哪些工具** —— 白名单三项，且没有任何派生型工具；
// ② **模型硬要调用派生型工具会怎样** —— 工具表里没有它，该调用被判为「不可用」而不是执行，
//    所以子运行不会派生第二个子运行（请求数停在两次就是这条结论的观测：真执行会再打一次模型）。
//
//    「不可用」的文案按解析点分两种：Pi 内核先用冻结的工具表解析（表外名字在这里就被挡下，
//    本文案是 `Tool "<name>" is unavailable`），宿主 `beforeTool` 里那条「工具 <name> 不可用」
//    要工具能过 Pi 的表、却不在宿主冻结的 `toolsByName` 里才走到。本场景的工具面在进 Pi 之前
//    就收窄了，所以看到的是前者 —— 断言因此只钉「如实报告了不可用」这个行为事实（工具名 +
//    不可用/unavailable 语义的词，中英均可），不钉某一家的具体文案。
//
// 工具名不写死：白名单按 id 从注册表取名字、派生集合按 `isolation === "delegate"` 从注册表现取 ——
// 写死名字会把工具身份抄成第二个定义点（与契约的判定口径一致）。
//
// 归属 L3（不是 L2）的理由：import `@/services/tool` 与 `@/services/agent/sub-agent`
// （工具 barrel 会带出执行许可，规则 6 的 L2 禁入清单）。
//
// 与 L4 原场景的差异（如实登记）：原场景 setup 里的响应脚本还带上场景回合的收尾回复，
// 迁到 L3 后不再驱动那条回合（它只是宿主入口的陪跑），脚本只保留子运行消费的两条。
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { initChat } from "@/services/agent/runner"
import { runForkAgent } from "@/services/agent/sub-agent"
import { getTool, listAll } from "@/services/tool"
import { registerDefaultTools } from "@/services/tool/registry"

const TASK = "看一下当前环境。"
const SUBAGENT_REPLY = "子代理完成"
/** 子代理白名单的三个 id（声明在 `agent/sub-agent.ts`）。 */
const SUB_AGENT_TOOL_IDS = ["pi-read", "local-system-info", "pi-bash"]
/**
 * 「不可用」判定的语言无关形状：宿主 `beforeTool` 是「工具 <name> 不可用」，Pi 内核
 * （`prepareToolCall`，先于宿主 hook 运行）是 `Tool "<name>" is unavailable` —— 两种文案
 * 都是「没有执行、如实报告不可用」这个事实的载体，断言只钉事实不钉文案。
 * 不用 `g` 标志：带 `lastIndex` 的正则跨次调用有状态。
 */
const UNAVAILABLE_PATTERN = /unavailable|不可用/i

let root = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-subagent-"))
  setTestDataRoot(root)
  // L4 宿主的标准 setup 负责注册默认工具；L3 没有这层兜底，白名单工具的注册源必须自己补齐。
  await registerDefaultTools()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 请求里发出去的工具名。 */
function payloadToolNames(tools: readonly unknown[] | undefined): string[] {
  return (tools ?? []).map(raw => String((raw as { name?: unknown }).name ?? "")).filter(Boolean)
}

/** 请求里的工具结果正文，按工具名索引（`toolResult` 消息是工具面的回执）。 */
function payloadToolResults(messages: readonly unknown[]): Map<string, string> {
  const texts = new Map<string, string>()
  for (const raw of messages) {
    const message = raw as { role?: string; toolName?: string; content?: unknown }
    if (message.role !== "toolResult" || typeof message.toolName !== "string") continue
    const content = Array.isArray(message.content)
      ? message.content.map(part => {
        const block = part as { type?: string; text?: string }
        return block?.type === "text" ? String(block.text ?? "") : ""
      }).join("\n")
      : String(message.content ?? "")
    texts.set(message.toolName, content)
  }
  return texts
}

describe("子代理工具面", () => {
  it("子代理工具面只有白名单三项、派生型工具不下放，硬调派生型工具只得到「不可用」 [tool-subagent-tool-surface]", async () => {
    // 前提一：白名单的三个 id 都已注册（取名字而不是抄名字）。
    const whitelistNames = SUB_AGENT_TOOL_IDS.map(id => {
      const tool = getTool(id)
      expect(tool, `子代理白名单工具未注册: ${id}`).toBeDefined()
      return tool!.name
    })
    // 前提二：注册表里确实有派生型工具 —— 否则「剥离」这半没有可观测对象。
    const delegateNames = listAll().filter(tool => tool.policy.execution.isolation === "delegate").map(tool => tool.name)
    expect(delegateNames.length, "注册表里没有 isolation=delegate 的派生型工具，剥离断言没有前提").toBeGreaterThan(0)

    await initChat()
    const provider = installFakeProvider([
      // 子代理的第一条回复就是一次派生型工具调用：它不该被执行（真执行会再打一次模型）。
      fakeToolCall(delegateNames[0]!, { task: "再派生一个子代理" }, "subagent-delegate-call"),
      fakeText(SUBAGENT_REPLY),
    ])
    const fork = await runForkAgent({ task: TASK })
    // 子运行自己的请求：fork 跑完立刻切片，场景回合的请求（本层没有）不会混进来。
    const subAgentPayloads = [...provider.payloads]
    const sortedWhitelist = [...whitelistNames].sort()

    // ① 子运行恰好发出两次请求：模型第一条是工具调用，第二条是拿到（被挡下的）结果后的收尾。
    //    多出来的请求只可能来自「派生型工具真的执行了」——真执行会再打一次模型。
    expect(subAgentPayloads.length, "子运行的请求数不是两次（派生型工具可能真的执行了）").toBe(2)

    // ② 工具面：白名单三项，一个不多一个不少，且没有任何派生型工具。
    const first = subAgentPayloads[0]
    expect(first, "没有捕获到子运行的第一条请求").toBeDefined()
    const sent = payloadToolNames(first?.tools)
    expect(sent.length, "子运行的请求里没有携带任何工具声明").toBeGreaterThan(0)
    expect([...sent].sort().join(","), `子代理工具面不是白名单三项: ${JSON.stringify([...sent].sort())}`).toBe(sortedWhitelist.join(","))
    for (const name of delegateNames) {
      expect(sent, `派生型工具被下放给子代理: ${name}`).not.toContain(name)
    }

    // ③ 硬调派生型工具：冻结的工具表里没有它 → 该调用得到「不可用」的回执，不是执行。
    //    回执里必须同时有工具名与「不可用」语义的词 —— 只断言「有错误」会把别的失败也算通过，
    //    只断言某一家文案又会把上游换词误判成产品回归。
    const follow = subAgentPayloads[1]
    expect(follow, "没有捕获到子运行的第二条请求").toBeDefined()
    const results = payloadToolResults(follow?.messages ?? [])
    const blocked = results.get(delegateNames[0]!)
    expect(blocked, `子运行的请求里没有派生型工具调用的回执: ${JSON.stringify([...results.keys()])}`).toBeDefined()
    expect(blocked ?? "", `派生型工具调用没有落到「工具不可用」: ${JSON.stringify((blocked ?? "").slice(0, 120))}`).toMatch(UNAVAILABLE_PATTERN)
    expect(blocked ?? "", "不可用回执没有点名派生型工具").toContain(delegateNames[0]!)

    // ④ 子运行本身正常收尾，回复来自脚本的第二条响应（执行了工具就会错位）。
    expect(fork.success, `子运行没有成功收尾: ${fork.error ?? "<无原因>"}`).toBe(true)
    expect(fork.reply, `子运行回复与脚本错位（工具可能真的执行了）: ${JSON.stringify(fork.reply)}`).toContain(SUBAGENT_REPLY)
  })
})
