// ==========================================
// 工具过程文案的顶栏推送（与阶段提示共用 owner 与释放点）—— L3
// ==========================================
//
// 被测语义（用户规则 2026-10-05：过程状态只在顶栏显示，聊天窗底部不再占过程文案）：
//   ① beforeTool（调用门放行后、工具执行前）经 Card 文案发 executing；
//   ② onToolEnd 按结果发 done / blocked（失败）；
//   ③ 文案取 getStagePrompt(key, "") —— 进程级 _default 一条：即使工具自身有具体
//      类别（探针声明 fs.read），顶栏也不按工具类别细分；
//   ④ 与阶段提示共用同一个 owner 与释放点：回合收尾的 finally 释放该 owner，顶栏不再
//      持有过程文案。另立 owner 或不释放的改法会把顶栏钉在最后一条过程文案上。
//
// 归属 L3（不是 L2）的理由：要驱动真实 agent loop，beforeTool / onToolEnd 才会真正跑起来，
// import `@/services/engine/harness`（规则 6 的 L2 禁入清单）。只替换 Provider 与执行许可
// （Node 宿主没有 Rust 许可内核；与既有 L3 用例同形），工具与权限链其余部分照走真实路径。
//
// 观测面：`@/services/titlebar` 的渲染监听（原生 UI 推送适配器挂的同一出口），收集顶栏
// 文本序列。按序列断言而不是按时刻轮询：executing 与 done 之间的窗口由回合内两条同步
// 路径决定，顺序构成契约、墙钟时刻不构成。
//
// 探针 Card 的阶段文案经唯一缓存入口 `loadStages` 装入（不落盘、不调模型），用例结束
// 还原缓存 —— D8：模块级单例不还原会把探针文案漏给同进程的其他用例。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { runRuntimeTurn } from "./_runtime-turn"
import { flushConfig, setOverrides } from "@/services/config"
import { resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import type { StageMap, StagePrompts } from "@/services/personality"
import { loadStages, restoreStagesCache, snapshotStagesCache } from "@/services/personality"
import { FALLBACK_STAGES } from "@/services/personality/stages-cache"
import { setTitlebarRenderListener, titlebarLogo } from "@/services/titlebar"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"

/** 探针文案由用例手写（独立见证），不 import 实现的默认版本文案。 */
const EXECUTING_TEXT = "探针执行中"
/** fs.read 类别专属文案：它出现即证明顶栏按工具类别取文案，而不是进程级 _default。 */
const EXECUTING_CATEGORY_TEXT = "探针读取中"
const DONE_TEXT = "探针完成"
const BLOCKED_TEXT = "探针已拦截"
const FINAL_TEXT = "工具跑完了"

/** 探针工具的类别：故意与 _default 文案分叉，用来钉「取的是哪一条」。 */
const PROBE_CATEGORY = "fs.read"

const PROBE_STAGES: StageMap = {
  ...FALLBACK_STAGES,
  executing: { [PROBE_CATEGORY]: EXECUTING_CATEGORY_TEXT, _default: EXECUTING_TEXT },
  done: { "fs.write": "探针写入完成", _default: DONE_TEXT },
  blocked: { _default: BLOCKED_TEXT },
}

let root = ""
let rendered: string[] = []
let savedStages: StagePrompts | null = null

function titlebarProbe(id: string, name: string, failing: boolean): ToolDef {
  return defineTool({
    id, name, description: "顶栏过程文案探针（只读，不产生副作用）",
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: PROBE_CATEGORY,
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async () => (failing
    ? { success: false, content: "", error: "探针恒定失败" }
    : { success: true, content: "探针结果" }))
}

const OK_PROBE = titlebarProbe("titlebar-stage-probe", "titlebar_stage_probe", false)
const FAILING_PROBE = titlebarProbe("titlebar-stage-failing-probe", "titlebar_stage_failing_probe", true)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-titlebar-stage-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
  // 拟人开关关掉：casual 流的 typing 所有权延迟释放不参与本用例，工具过程文案的
  // 推送与释放不依赖拟人通道（关了才能按回合收尾这一条释放点断言）。
  setOverrides({ "ai.humanizer.enabled": false })
  await flushConfig()
  register(OK_PROBE)
  register(FAILING_PROBE)
  savedStages = snapshotStagesCache()
  loadStages({
    cardId: "titlebar-stage-probe", cardVersion: 1, sourceHash: "titlebar-stage-probe",
    generatedAt: Date.now(), isFallback: false, stages: PROBE_STAGES,
  })
  rendered = []
  setTitlebarRenderListener(text => rendered.push(text))
})

afterEach(() => {
  setTitlebarRenderListener(null)
  restoreStagesCache(savedStages)
  savedStages = null
  unregister(OK_PROBE.id)
  unregister(FAILING_PROBE.id)
  resetPiRuntimeProviderForTest()
})

describe("工具过程文案的顶栏推送", () => {
  it("成功工具：executing → done 逐条进顶栏，回合收尾释放 [tool-stage-titlebar-sequence]", async () => {
    const provider = installFakeProvider([
      fakeToolCall(OK_PROBE.name, {}, "titlebar-call"),
      fakeText(FINAL_TEXT),
    ])

    const output = await runRuntimeTurn("调一次工具。")

    expect(output.failure, `回合以失败结算：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(provider.state.callCount, "工具轮 + 收尾轮应为两次请求").toBe(2)

    // ① 执行期：Card 的 executing 文案在顶栏出现过（删掉 beforeTool 的推送这条立即红）。
    expect(rendered, `顶栏文本序列缺少执行文案: ${JSON.stringify(rendered)}`).toContain(EXECUTING_TEXT)
    // ② 取的是进程级 _default：按工具类别（fs.read）取会得到另一条文案。
    expect(rendered, "顶栏按工具类别取文案（应为进程级 _default）").not.toContain(EXECUTING_CATEGORY_TEXT)
    // ③ 结束：done 文案，且晚于 executing（把 key 传反/漏发 done 都会红）。
    expect(rendered, `顶栏文本序列缺少完成文案: ${JSON.stringify(rendered)}`).toContain(DONE_TEXT)
    expect(rendered.indexOf(EXECUTING_TEXT)).toBeLessThan(rendered.indexOf(DONE_TEXT))
    // ④ 回合收尾释放：顶栏不再持有过程文案（另立 owner / 不释放会钉在最后一条上）。
    expect(titlebarLogo.text, "回合收尾后顶栏仍持有完成文案（owner 未释放或用了第二个 owner）").not.toBe(DONE_TEXT)
    expect(titlebarLogo.text).not.toBe(EXECUTING_TEXT)
    expect(rendered[rendered.length - 1], "最后一次渲染与真值点当前文本不一致").toBe(titlebarLogo.text)
  })

  it("失败工具：executing → blocked，回合收尾同样释放 [tool-stage-titlebar-blocked]", async () => {
    installFakeProvider([
      fakeToolCall(FAILING_PROBE.name, {}, "titlebar-fail-call"),
      fakeText(FINAL_TEXT),
    ])

    const output = await runRuntimeTurn("调一次会失败的工具。")

    expect(output.failure, `回合以失败结算：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(rendered, `顶栏文本序列缺少执行文案: ${JSON.stringify(rendered)}`).toContain(EXECUTING_TEXT)
    expect(rendered, `顶栏文本序列缺少拦截文案: ${JSON.stringify(rendered)}`).toContain(BLOCKED_TEXT)
    expect(rendered.indexOf(EXECUTING_TEXT)).toBeLessThan(rendered.indexOf(BLOCKED_TEXT))
    expect(titlebarLogo.text, "回合收尾后顶栏仍持有拦截文案（owner 未释放）").not.toBe(BLOCKED_TEXT)
    expect(rendered[rendered.length - 1]).toBe(titlebarLogo.text)
  })
})
