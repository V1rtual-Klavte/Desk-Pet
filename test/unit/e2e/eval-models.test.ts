// ==========================================
// 测试侧统一模型配置解析（test/e2e/eval-models.ts）
// ==========================================
import { describe, expect, it } from "vitest"
import { parseEvalModelsFile, resolveEvalModels } from "../../e2e/eval-models"

describe("resolveEvalModels", () => {
  it("环境变量优先于文件，文件优先于内置默认（默认不在此层）", () => {
    const file = { underTest: { provider: "file-provider", model: "file-model" }, judge: { model: "file-judge" } }
    const env = { DESKPET_EVAL_PROVIDER: "env-provider", DESKPET_EVAL_MODEL: "", DESKPET_EVAL_JUDGE_MODEL: undefined }
    const resolved = resolveEvalModels(file, env)
    // provider：env 给了值 → env 赢
    expect(resolved.underTestProvider).toBe("env-provider")
    // model：env 是空串（视为未提供）→ 文件赢
    expect(resolved.underTestModel).toBe("file-model")
    // judge：env 未给 → 文件赢
    expect(resolved.judgeModel).toBe("file-judge")
  })

  it("null 与缺失表示继承：两者都不给值时解析为 undefined", () => {
    const resolved = resolveEvalModels({ underTest: { provider: null, model: null }, judge: { model: null } }, {})
    expect(resolved).toEqual({ underTestProvider: undefined, underTestModel: undefined, judgeModel: undefined })
  })

  it("忽略纯空白值（视同未提供）", () => {
    const resolved = resolveEvalModels({ underTest: { model: "  " }, judge: { model: " x " } }, { DESKPET_EVAL_MODEL: "\t" })
    expect(resolved.underTestModel).toBeUndefined()
    expect(resolved.judgeModel).toBe("x")
  })

  it("空文件对象（未定义）不抛错，全字段未提供", () => {
    expect(resolveEvalModels(undefined, {})).toEqual({ underTestProvider: undefined, underTestModel: undefined, judgeModel: undefined })
  })
})

describe("parseEvalModelsFile", () => {
  it("坏 JSON 显式失败，不静默按默认跑", () => {
    expect(() => parseEvalModelsFile("{oops")).toThrowError(/不是合法 JSON/)
  })

  it("非对象顶层显式失败", () => {
    expect(() => parseEvalModelsFile("[1,2]")).toThrowError(/必须是对象/)
    expect(() => parseEvalModelsFile("null")).toThrowError(/必须是对象/)
  })

  it("合法文件解析出结构化字段", () => {
    const parsed = parseEvalModelsFile('{"underTest":{"model":"m1"},"judge":{"model":"j1"}}')
    expect(parsed.underTest?.model).toBe("m1")
    expect(parsed.judge?.model).toBe("j1")
  })
})
