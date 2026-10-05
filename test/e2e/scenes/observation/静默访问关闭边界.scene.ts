import { getHostBridge } from "@/services/host"
import { setOverride } from "@/services/config"
import { setMonitorEnabled } from "@/services/window"
import { errorCode } from "@/services/error"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import type { SceneDef } from "../../types"

export const 静默访问关闭边界: SceneDef = {
  meta: { caseId: "observation-native-disabled-boundary", module: "observation", contractId: "ob-03",
    description: "真实Rust命令注册与关闭许可边界：关闭时截图与目标读取都必须返回CANCELLED，不启动后台采集",
    depth: "deep", suite: "regression", entry: "production", tags: ["boundary", "error", "native", "permission"] },
  setup: async () => {
    setOverride("ai.silentAccess.enabled", false)
    await setMonitorEnabled(false)
    installFakeProvider([fakeText("静默访问关闭了")])
  },
  turns: [{ index: 1, description: "普通聊天仍能完成，观察端口由Rust终裁拒绝", userText: "这轮只聊一句",
    checks: [{ type: "expectNativeObservationDisabled", run: async () => {
      const probes = [
        { command: "observation_capture_screen", request: getHostBridge().request("observation_capture_screen", {}) },
        { command: "observation_read_targets", request: getHostBridge().request("observation_read_targets", { targets: [{ path: "/not-a-readable-project", kind: "file" }] }) },
      ]
      for (const { command, request } of probes) {
        let code: string | null | undefined
        try { await request }
        catch (error) { code = errorCode(error) }
        if (code !== "CANCELLED") throw new Error(`${command}关闭时应返回CANCELLED，实际${code ?? "调用成功"}`)
      }
      // 独立activity入口仍提供锁屏/idle资格，不能把其状态误当监控许可真值。
    } }] }],
}
export default 静默访问关闭边界
