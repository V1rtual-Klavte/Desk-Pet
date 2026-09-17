import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { requestPermissionConfirm } from "@/services/safety"
import { confirmRecords } from "../../confirm-channel"

/**
 * pet 模式下 bash 的白名单外命令（带 shell 组合符）会被 classifyBashRisk 判为 DANGER，
 * 而 pi-bash 声明了 `lightweightPolicy: "confirm"` —— 所以它必定走确认通道。
 * 命令本身无害：即使被误放行也只写一个临时文件。
 */
const PROBE_COMMAND = "echo deskpet-confirm-probe > /tmp/deskpet-confirm-probe.txt"

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
      if (decision === "deny") throw new Error("approve 策略下确认请求未被放行")
      const records = confirmRecords().filter(record => record.toolName === "probe_tool")
      if (records.length !== 1 || !records[0].approved) throw new Error("确认记录缺失或未标记放行")
    } }] }],
}

export default 确认被拒
