// ==========================================
// 窗口下限文案 —— 从 test/e2e/scenes/memory/窗口下限文案.scene.ts 迁到 L3
// ==========================================
//
// 同一条下限有两个归因：设置页报的是「你填的值太低」（可改配置），模型解析报的是
// 「模型目录的已知窗口太小」（改配置没用）。归因错了，用户会去改一个本来合法的值。
//
// 归 L3 的理由：接线断言经 `resolvePiTurnModel`（`@/services/engine/harness` 会带出 runtime 的 IPC 依赖）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { installFakeProvider } from "../../host/fake-provider"
import { MIN_CONTEXT_WINDOW, contextWindowError } from "@/services/context"
import { aiConfig, getOverride, setOverride } from "@/services/config"
import { resetPiRuntimeProviderForTest, resolvePiTurnModel } from "@/services/engine/harness"
import { formatError } from "@/services/error"

/** 原设置页文案里的那句话：两个调用点共用下限，但归因不能共用。 */
const CONFIG_FLAVOR = "上下文窗口配置最低"
const MODEL_FLAVOR = "改用窗口更大的模型"

let root = ""
let originalContextMaxTokens: number | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-window-message-"))
  setTestDataRoot(root)
  // 配置钉位：场景口径是「配置 131072 合法、模型目录窗口太小」，不依赖本机 CONFIG 的取值。
  originalContextMaxTokens = getOverride<number>("ai.contextMaxTokens")
  setOverride("ai.contextMaxTokens", 131_072)
})

afterEach(() => {
  resetPiRuntimeProviderForTest()
  setOverride("ai.contextMaxTokens", originalContextMaxTokens)
  rmSync(root, { recursive: true, force: true })
})

/** 取一次失败现场（模型解析处必须报错，报错内容即断言对象）。 */
function resolveFailure(): string {
  try {
    resolvePiTurnModel()
    return ""
  } catch (error) {
    return formatError(error)
  }
}

describe("窗口下限文案", () => {
  it("模型解析处报出「模型窗口太小」并给出可修方向，设置页口径不变 [memory-context-window-message]", () => {
    const below = MIN_CONTEXT_WINDOW - 1

    // 1. 设置页口径（不传 options）：文案逐字保持原样，保存校验依赖它。
    expect(contextWindowError(below), "设置页口径的文案变了")
      .toContain(`${CONFIG_FLAVOR} ${MIN_CONTEXT_WINDOW} tokens（当前 ${below}）`)

    // 2. 模型解析口径：指出模型 id 与配置值，并给出可修方向（换模型）。
    const modelFlavor = contextWindowError(below, { configured: 131_072, modelId: "gpt-4" })
    expect(modelFlavor, "带 options 时应当报错").toBeDefined()
    // 参数回显本身是 mm-30 要求的行为（「指出模型 id 与配置值」），能红于丢掉插值的实现；
    // 这里再钉一条真正的分支判据（见下），避免这组断言的证据只剩「参数被回显」。
    for (const expected of ["gpt-4", "131072", MODEL_FLAVOR]) {
      expect(modelFlavor, `模型口径的文案缺少「${expected}」`).toContain(expected)
    }
    expect(modelFlavor, "模型口径的文案仍在指控配置").not.toContain(CONFIG_FLAVOR)
    // 配置值与生效值相等时省略配置括注（「取小」没有发生，就没有配置侧要说）：
    // 两个入参的产出必须逐字相同 —— 分支被删掉（恒回显配置值）时这里立刻红。
    expect(contextWindowError(below, { configured: below, modelId: "gpt-4" }),
      "配置值与生效值相等时仍回显了配置值（省略分支失效）")
      .toBe(contextWindowError(below, { modelId: "gpt-4" }))

    // 3. 边界：下限自身合法。
    expect(contextWindowError(MIN_CONTEXT_WINDOW), "下限自身应当合法").toBeUndefined()

    // 4. 接线：模型解析处必须把模型 id 与配置值交给同一处文案。
    //    用注入模型把「目录已知窗口」压到下限之下，不依赖本机模型目录里恰有小窗口模型；
    //    文案里出现模型 id 与配置值，只可能来自 model-gateway 的调用点传了 options。
    const fake = installFakeProvider([], { id: "window-floor-probe", name: "Window Floor Probe", contextWindow: below })
    let failure = ""
    try { failure = resolveFailure() } finally { fake.restore() }
    expect(failure, "模型解析处的下限错误没有给出可修方向").toContain(MODEL_FLAVOR)
    expect(failure, "模型解析处的下限错误没有指出模型 id").toContain("window-floor-probe")
    // 配置值只在与生效值不同时出现（取小取到了模型目录这一侧才有的说）。
    if (aiConfig.contextMaxTokens > below) {
      expect(failure, "模型解析处的下限错误没有指出配置值").toContain(String(aiConfig.contextMaxTokens))
    }
  })
})
