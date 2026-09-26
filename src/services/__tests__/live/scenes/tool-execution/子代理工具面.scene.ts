import type { SceneDef } from "../../types"
import { runForkAgent } from "@/services/agent/sub-agent"
import { getTool, listAll } from "@/services/tool"
import { initChat } from "@/services/agent/runner"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"

/**
 * 子代理工具面：不派生（te-23）。
 *
 * 决策 16 的剥离点在 `runPiSubAgent`：按工具自己声明的 `policy.execution.isolation !== "delegate"` 过滤，
 * 派生型工具不下放；子代理自身再用固定白名单（`pi-read` + `local-system-info` + `pi-bash`）收窄。
 * 本场景从 `runForkAgent` 这条真实 fork 通路观察两件事：
 *
 * ① **发出去的请求里到底有哪些工具** —— 白名单三项，且没有任何派生型工具；
 * ② **模型硬要调用派生型工具会怎样** —— 内核只从冻结的 `toolsByName` 解析，表外名字得到「工具不可用」，
 *    所以子运行不会派生第二个子运行（请求数停在两次就是这条结论的观测：真执行会再打一次模型）。
 *
 * 工具名不写死：白名单按 id 从注册表取名字、派生集合按 `isolation === "delegate"` 从注册表现取 ——
 * 写死名字会把工具身份抄成第二个定义点（与契约的判定口径一致）。
 */
const TASK = "看一下当前环境。"
const SUBAGENT_REPLY = "子代理完成"
const TURN_REPLY = "核对完成"
/** 子代理白名单的三个 id（声明在 `agent/sub-agent.ts`）。 */
const SUB_AGENT_TOOL_IDS = ["pi-read", "local-system-info", "pi-bash"]
const UNAVAILABLE_MARK = "不可用"

let provider: ReturnType<typeof installFakeProvider> | undefined
let fork: Awaited<ReturnType<typeof runForkAgent>> | undefined
/** 子运行自己的请求。场景回合的请求在 setup 之后才发生，这里跑完 fork 立刻切片，不混进来。 */
let subAgentPayloads: NonNullable<typeof provider>["payloads"] = []
/** 注册表里声明的派生型工具名（供 fake 脚本发出一次真实调用）。 */
let delegateNames: string[] = []
/** 子代理白名单解析出的工具名。 */
let whitelistNames: string[] = []

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

export const 子代理工具面: SceneDef = {
  meta: {
    caseId: "tool-subagent-tool-surface", module: "tool-execution", contractId: "te-23",
    description: "子代理的工具面只有 pi-read + local-system-info + pi-bash，派生型工具不下放；模型硬调派生型工具只会得到「工具不可用」，不会执行",
    depth: "deep", suite: "regression", entry: "runtime", tags: ["tool-execution", "subagent", "boundary", "error"],
  },
  setup: async () => {
    // 前提一：白名单的三个 id 都已注册（取名字而不是抄名字）。
    whitelistNames = SUB_AGENT_TOOL_IDS.map(id => {
      const tool = getTool(id)
      if (!tool) throw new Error(`子代理白名单工具未注册: ${id}`)
      return tool.name
    })
    // 前提二：注册表里确实有派生型工具 —— 否则「剥离」这半没有可观测对象。
    delegateNames = listAll().filter(tool => tool.policy.execution.isolation === "delegate").map(tool => tool.name)
    if (delegateNames.length === 0) throw new Error("注册表里没有 isolation=delegate 的派生型工具，剥离断言没有前提")

    await initChat()
    provider = installFakeProvider([
      // 子代理的第一条回复就是一次派生型工具调用：它不该被执行（真执行会再打一次模型）。
      fakeToolCall(delegateNames[0]!, { task: "再派生一个子代理" }, "subagent-delegate-call"),
      fakeText(SUBAGENT_REPLY),
      fakeText(TURN_REPLY),
    ])
    fork = await runForkAgent({ task: TASK })
    subAgentPayloads = [...(provider?.payloads ?? [])]
  },
  turns: [{
    index: 1,
    description: "核对子运行请求里的工具面与派生型工具的实际归宿",
    userText: "核对子代理的工具面。",
    checks: [{
      type: "expectSubAgentToolSurface",
      run: async () => {
        if (!fork) throw new Error("场景前置缺失：fork 没有跑起来")
        if (provider === undefined) throw new Error("场景前置缺失：fake provider 未安装")
        const sortedWhitelist = [...whitelistNames].sort()

        // ① 子运行恰好发出两次请求：模型第一条是工具调用，第二条是拿到（被挡下的）结果后的收尾。
        //    多出来的请求只可能来自「派生型工具真的执行了」——真执行会再打一次模型。
        if (subAgentPayloads.length !== 2) {
          throw new Error(`子运行的请求数不是两次（派生型工具可能真的执行了）: ${subAgentPayloads.length}`)
        }

        // ② 工具面：白名单三项，一个不多一个不少，且没有任何派生型工具。
        const first = subAgentPayloads[0]
        if (!first) throw new Error("没有捕获到子运行的第一条请求")
        const sent = payloadToolNames(first.tools)
        if (sent.length === 0) throw new Error("子运行的请求里没有携带任何工具声明")
        const sentSorted = [...sent].sort()
        if (sentSorted.join(",") !== sortedWhitelist.join(",")) {
          throw new Error(`子代理工具面不是白名单三项: ${JSON.stringify(sentSorted)} vs ${JSON.stringify(sortedWhitelist)}`)
        }
        for (const name of delegateNames) {
          if (sent.includes(name)) throw new Error(`派生型工具被下放给子代理: ${name}`)
        }

        // ③ 硬调派生型工具：内核冻结的工具表里没有它 → 该调用得到「工具不可用」，不是执行。
        const follow = subAgentPayloads[1]
        if (!follow) throw new Error("没有捕获到子运行的第二条请求")
        const results = payloadToolResults(follow.messages)
        const blocked = results.get(delegateNames[0]!)
        if (blocked === undefined) {
          throw new Error(`子运行的请求里没有派生型工具调用的回执: ${JSON.stringify([...results.keys()])}`)
        }
        if (!blocked.includes(UNAVAILABLE_MARK) || !blocked.includes(delegateNames[0]!)) {
          throw new Error(`派生型工具调用没有落到「工具不可用」: ${JSON.stringify(blocked.slice(0, 120))}`)
        }

        // ④ 子运行本身正常收尾，回复来自脚本的第二条响应（执行了工具就会错位）。
        if (!fork.success) throw new Error(`子运行没有成功收尾: ${fork.error ?? "<无原因>"}`)
        if (!fork.reply.includes(SUBAGENT_REPLY)) {
          throw new Error(`子运行回复与脚本错位（工具可能真的执行了）: ${JSON.stringify(fork.reply)}`)
        }
      },
    }],
  }],
}

export default 子代理工具面
