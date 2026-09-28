import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { requestPermissionConfirm } from "@/services/safety"
import { toolsConfig } from "@/services/config"
import { confirmRecords } from "../../confirm-channel"

/**
 * 确认通道的两个方向。
 *
 * 进确认的方向：带 shell 组合符的命令不进白名单免确认通道（`classifyBashRisk` 判为
 * DANGER），DANGER 由安全模式裁决，默认 `tell_me` 下走确认通道 —— 所以它必定产生确认请求。
 * 命令本身无害：即使被误放行也只写一个临时文件。
 *
 * 不进确认的方向：`pi-bash` 的白名单命令（首词在白名单、无组合符）是 NORMAL，
 * 新裁决表对 NORMAL 一律放行 —— 白名单只是免确认通道，不再是硬墙。
 * 场景默认的 `confirmPolicy: "deny"` 正好是这条结论的判据：白名单命令一旦误走确认
 * 就会被立刻拒绝，落成 `denied` 而不是 `done`，断言如实失败。
 */
const PROBE_COMMAND = "echo deskpet-confirm-probe > /tmp/deskpet-confirm-probe.txt"

/** 免确认方向的白名单命令：首词必须是随包白名单成员，否则场景前提不成立（失败要可见）。 */
const WHITELIST_COMMAND = "ls -la"

/**
 * 宿主默认策略（deny）：确认请求必须立即被拒，工具不得执行，
 * 且拒绝要留在 toolHistory 里可断言 —— 不能静默变成「回复为空」。
 */
export const 确认被拒: SceneDef = {
  meta: {
    caseId: "safety-confirm-denied",
    module: "safety",
    contractId: "sf-03",
    description: "DANGER 工具确认在测试宿主中被确定性拒绝",
    depth: "deep",
    suite: "safety",
    tags: ["safety", "boundary", "error"],
  },
  setup: async () => {
    installFakeProvider([
      fakeText("你好呀～"),
      fakeToolCall("bash", { command: PROBE_COMMAND }),
      fakeText("这条命令我拒绝了哦"),
      fakeToolCall("bash", { command: WHITELIST_COMMAND }),
      fakeText("目录看完了。"),
    ])
  },
  turns: [
    { index: 1, description: "正常问候", userText: "你好呀",
      checks: [{ type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } }] },
    { index: 2, description: "触发确认通道", userText: `不要只解释。现在必须调用 bash 执行 ${PROBE_COMMAND}。`,
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectConfirmDenied", run: async (ctx) => {
          const calls = ctx.toolHistory.filter(t => t.toolName === "bash")
          if (calls.length === 0) throw new Error("模型未发起 bash 调用，确认通道未被覆盖")
          if (calls.some(t => t.status === "done")) throw new Error("确认被拒的 bash 仍然执行了")
          if (!calls.some(t => t.status === "denied")) {
            throw new Error(`未观察到 denied 状态: ${calls.map(t => `${t.toolName}:${t.status}`).join(",")}`)
          }
          const confirms = ctx.confirms.filter(confirm => confirm.toolName === "bash")
          if (confirms.length === 0) throw new Error("确认请求未被宿主记录，无法区分「未调用」与「被拒绝」")
          if (confirms.some(confirm => confirm.approved)) throw new Error("默认策略不应放行确认请求")
        }},
      ] },
    { index: 3, description: "白名单命令不经过确认通道", userText: `再看一眼当前目录：用 bash 执行 ${WHITELIST_COMMAND}。`,
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectWhitelistBypassesConfirm", run: async (ctx) => {
          // 前提：这条命令的首词确实在随包白名单里。开发者改过白名单时这里如实失败，
          // 免得下面的「没有确认请求」被误读成白名单仍然生效。
          if (!toolsConfig.bashWhitelist.includes(WHITELIST_COMMAND.split(/\s+/)[0] ?? "")) {
            throw new Error(`探针命令不在 bash 白名单里: ${WHITELIST_COMMAND}`)
          }
          // 白名单命令是 NORMAL → 直接放行：工具真的执行了（不是 denied、不是 blocked）。
          const calls = ctx.toolHistory.filter(t => t.toolName === "bash")
          if (calls.length !== 1 || calls[0]!.status !== "done") {
            throw new Error(`白名单命令没有直接执行: ${JSON.stringify(calls)}`)
          }
          // 本场景累计只有第 2 轮那一次确认请求：第 3 轮没有产生新的待确认项。
          const confirms = ctx.confirms.filter(confirm => confirm.toolName === "bash")
          if (confirms.length !== 1 || confirms[0]!.approved) {
            throw new Error(`白名单命令产生了额外确认请求，或第一轮的拒绝记录丢失: ${JSON.stringify(confirms)}`)
          }
        }},
      ] },
  ],
}

/** 场景显式声明 approve：同一条确认请求必须立即放行。 */
export const 确认放行: SceneDef = {
  meta: {
    caseId: "safety-confirm-approved",
    module: "safety",
    contractId: "sf-03",
    description: "场景声明 approve 后确认通道立即放行",
    depth: "shallow",
    suite: "safety",
    confirmPolicy: "approve",
    tags: ["safety", "boundary"],
  },
  setup: async () => { installFakeProvider([fakeText("通道自检完成")]) },
  turns: [{ index: 1, description: "确认通道 approve 策略", userText: "检查确认通道。",
    checks: [{ type: "expectConfirmApproved", run: async () => {
      // 直接走生产入口（PermissionKernel 同一函数）：探针请求必须被宿主按场景策略应答。
      const decision = await requestPermissionConfirm({
        requestId: "channel-probe", sessionId: "probe-session", runGeneration: 0,
        toolCallId: "probe_tool", toolName: "probe_tool", inputHash: "probe", policyHash: "probe",
        expiresAt: Date.now() + 60_000, message: "通道自检", parameterSummary: "", effectClass: "external_side_effect",
      })
      // 应答形状也要钉住：宿主 approve 走的是 `resolveConfirm(true)` → `allow_session`，
      // 正是子代理授权场景要复用的那种授权（sf-20）。
      if (decision !== "allow_session") throw new Error(`approve 策略下的应答不是 allow_session: ${decision}`)
      const records = confirmRecords().filter(record => record.toolName === "probe_tool")
      if (records.length !== 1 || !records[0].approved) throw new Error("确认记录缺失或未标记放行")
    } }] }],
}

export default 确认被拒
