// ==========================================
// 上下文窗口下限 —— 从 test/e2e/scenes/memory/上下文窗口下限.scene.ts 迁到 L3
// ==========================================
//
// 低于下限的窗口没有可用的压缩切点：设置页保存被拒（复用同一个 contextWindowError），
// 运行期在模型解析这一唯一入口报错 —— 这里验证运行期路径，避免「保存能过、回合静默跑坏」。
//
// 归 L3 的理由：接线断言经 `resolvePiTurnModel`（`@/services/engine/harness` 会带出 runtime 的 IPC 依赖）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { installFakeProvider } from "../../host/fake-provider"
import { MIN_CONTEXT_WINDOW, contextWindowError } from "@/services/context"
import { getOverride, setOverride } from "@/services/config"
import { resetPiRuntimeProviderForTest, resolvePiTurnModel } from "@/services/engine/harness"
import { formatError } from "@/services/error"

const PINNED_CONTEXT_MAX_TOKENS = 131_072

let root = ""
let originalContextMaxTokens: number | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-window-floor-"))
  setTestDataRoot(root)
  // 配置钉位：解析出的窗口是 min(配置, 注入模型)，两侧都由本测试钉死，不读本机 CONFIG 的决定性取值。
  originalContextMaxTokens = getOverride<number>("ai.contextMaxTokens")
  setOverride("ai.contextMaxTokens", PINNED_CONTEXT_MAX_TOKENS)
})

afterEach(() => {
  resetPiRuntimeProviderForTest()
  setOverride("ai.contextMaxTokens", originalContextMaxTokens)
  rmSync(root, { recursive: true, force: true })
})

describe("上下文窗口下限", () => {
  it("低于 65536 的配置在模型解析处报错，合法窗口照常解析 [memory-context-window-floor]", () => {
    // 价值钉：65536 是用户可见的契约值（CONFIG 注释、设置页校验与 mm-20 都写它）。
    // 改这个值要同批更新本行与相关文档，而不是让断言跟着实现漂。
    expect(MIN_CONTEXT_WINDOW, "MIN_CONTEXT_WINDOW 的契约值是 65536").toBe(65_536)

    // 设置页口径：下限自身合法，低于下限必须给出带下限值的文案。
    expect(contextWindowError(MIN_CONTEXT_WINDOW), "下限自身应当合法").toBeUndefined()
    const below = MIN_CONTEXT_WINDOW - 1
    expect(contextWindowError(below), `下限之下的文案缺少下限值`).toContain(String(MIN_CONTEXT_WINDOW))

    // 合法窗口照常解析：「取小」的两个方向各由独立见证钉住（原场景的两条断言是恒真式：
    // 解析器低于下限已先抛错，而 min(配置, 窗口) 不可能大于配置 —— 先把它们换成真判据）。
    const smallerModel = installFakeProvider([], { id: "floor-model-small", name: "Floor Small", contextWindow: 96_000 })
    try {
      // 模型目录更小 → 取模型侧。
      expect(resolvePiTurnModel().contextWindow, "模型窗口更小时没有取模型侧").toBe(96_000)
    } finally { smallerModel.restore() }

    const largerModel = installFakeProvider([], { id: "floor-model-large", name: "Floor Large", contextWindow: 200_000 })
    try {
      // 配置更小 → 取配置侧（只认模型窗口的实现会在这里返回 200000）。
      expect(resolvePiTurnModel().contextWindow, "配置窗口更小时没有取配置侧").toBe(PINNED_CONTEXT_MAX_TOKENS)
    } finally { largerModel.restore() }

    // 低于下限的窗口在模型解析处报错（而不是静默跑在坏预算上）。
    setOverride("ai.contextMaxTokens", below)
    let failure = ""
    try { resolvePiTurnModel() } catch (error) { failure = formatError(error) }
    expect(failure, "低于下限的窗口没有在模型解析处报错").toContain(String(MIN_CONTEXT_WINDOW))
  })
})
