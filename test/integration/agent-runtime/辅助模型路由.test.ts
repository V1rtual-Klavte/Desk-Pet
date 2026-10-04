// ==========================================
// 辅助模型路由 —— ai.auxModel 驱动子运行（agent_spawn 的 fork 通路）的模型选择
// ==========================================
//
// 覆盖语义（resolvePiAuxModel 的三条分支，从真实 fork 通路的请求上观测）：
// ① 留空 → 回落聊天模型（注入的聊天模型）；
// ② 非空 → 经同一网关按目标模型 id 解析，请求落到辅助模型；
// ③ 与聊天模型同名 → 同样回落，不产生第二份模型身份。
//
// 观测方式：fake provider 的 `payloads[].model` —— 宿主每发一次请求，替身把解析出的
// 模型 id 记进载荷；断言「请求落在哪个模型上」这个行为事实，不读实现内部状态。
// 非空分支要经真实网关构造模型（同 provider/endpoint），所以端点必须是合法 URL；
// 网络仍被注入的 streamFn 拦截（子运行成功本身就是没有出网的证据）。
//
// 归属 L3（不是 L2）的理由：import `@/services/agent/sub-agent`（工具 barrel 会带出
// 执行许可，规则 6 的 L2 禁入清单）。
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { initChat } from "@/services/agent/runner"
import { runForkAgent } from "@/services/agent/sub-agent"
import { registerDefaultTools } from "@/services/tool/registry"
import { aiConfig, setOverride } from "@/services/config"

const TASK = "看一下当前环境。"
/** 与聊天模型不同的辅助模型 id：路由一旦生效，请求的模型身份必须变成它。 */
const AUX_MODEL = "aux-route-test-model"
/** 非空辅助模型要过网关的端点校验；跑测试时请求仍走 fake streamFn，不会真的连它。 */
const TEST_ENDPOINT = "https://aux-route.invalid"

let root = ""
let prevAuxModel = ""
let prevEndpoint = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-aux-model-"))
  setTestDataRoot(root)
  await registerDefaultTools()
  prevAuxModel = aiConfig.auxModel
  prevEndpoint = aiConfig.endpoint
  setOverride("ai.endpoint", TEST_ENDPOINT)
})

afterEach(() => {
  setOverride("ai.auxModel", prevAuxModel)
  setOverride("ai.endpoint", prevEndpoint)
  rmSync(root, { recursive: true, force: true })
})

describe("辅助模型路由", () => {
  it("auxModel 留空回落聊天模型、非空时子运行落到辅助模型 [aux-model-routing]", async () => {
    await initChat()

    // ① 留空（默认）：子运行的请求落在聊天模型（注入替身）上。
    const inheriting = installFakeProvider([fakeText("辅助路由：继承")])
    const first = await runForkAgent({ task: TASK })
    expect(first.success, `继承场景的子运行失败: ${first.error ?? "<无原因>"}`).toBe(true)
    expect(inheriting.payloads.length, "子运行没有发出请求").toBeGreaterThan(0)
    for (const payload of inheriting.payloads) {
      expect(payload.model, "auxModel 留空时子运行没有回落聊天模型").toBe(inheriting.model.id)
    }

    // ② 非空：同一条 fork 通路的请求改落到辅助模型 —— 模型身份来自 ai.auxModel，
    //    而不是注入的聊天模型；子运行仍成功，说明请求走的还是替换后的运行面（没有出网）。
    setOverride("ai.auxModel", AUX_MODEL)
    const routed = installFakeProvider([fakeText("辅助路由：切换")])
    const second = await runForkAgent({ task: TASK })
    expect(second.success, `辅助模型场景的子运行失败: ${second.error ?? "<无原因>"}`).toBe(true)
    expect(routed.payloads.length, "辅助模型场景没有发出请求").toBeGreaterThan(0)
    for (const payload of routed.payloads) {
      expect(payload.model, "子运行没有落到辅助模型").toBe(AUX_MODEL)
    }

    // ③ 与聊天模型同名：回落语义同样成立（不因显式填写而走第二条身份构造路径）。
    setOverride("ai.auxModel", aiConfig.model)
    const same = installFakeProvider([fakeText("辅助路由：同名")])
    const third = await runForkAgent({ task: TASK })
    expect(third.success, `同名回落场景的子运行失败: ${third.error ?? "<无原因>"}`).toBe(true)
    expect(same.payloads.length, "同名回落场景没有发出请求").toBeGreaterThan(0)
    for (const payload of same.payloads) {
      expect(payload.model, "auxModel 与聊天模型同名时没有回落").toBe(same.model.id)
    }
  })
})
