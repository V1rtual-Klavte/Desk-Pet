// ==========================================
// 测试侧统一模型配置解析（test/e2e/eval-models.ts）
// ==========================================
import { describe, expect, it } from "vitest"
import { parseEvalModelsFile, resolveEvalModels } from "../../e2e/eval-models"

describe("resolveEvalModels", () => {
  it("环境变量优先于本地文件，本地文件优先于进 git 的基线", () => {
    const base = { underTest: { provider: "base-provider", model: "base-model" }, judge: { model: "base-judge" } }
    const local = { underTest: { provider: "local-provider", model: "local-model" }, judge: { model: "local-judge" } }
    const env = { DESKPET_EVAL_PROVIDER: "env-provider", DESKPET_EVAL_MODEL: "", DESKPET_EVAL_JUDGE_MODEL: undefined }
    const resolved = resolveEvalModels(base, local, env)
    // provider：env 给了值 → env 赢
    expect(resolved.underTestProvider).toBe("env-provider")
    // model：env 是空串（视为未提供）→ 本地文件赢
    expect(resolved.underTestModel).toBe("local-model")
    // judge：env 未给 → 本地文件赢
    expect(resolved.judgeModel).toBe("local-judge")
  })

  it("本地文件缺失（undefined）时按进 git 的基线解析", () => {
    const base = { underTest: { model: "base-model" }, judge: { model: "base-judge" } }
    const resolved = resolveEvalModels(base, undefined, {})
    expect(resolved.underTestModel).toBe("base-model")
    expect(resolved.judgeModel).toBe("base-judge")
  })

  it("凭据与 endpoint 从文件两层解析（本地优先）", () => {
    const local = { underTest: { endpoint: "https://local.example", apiKey: "sk-local" } }
    const resolved = resolveEvalModels({ underTest: {} }, local, {})
    expect(resolved.underTestEndpoint).toBe("https://local.example")
    expect(resolved.underTestApiKey).toBe("sk-local")
  })

  it("reviewMaxTokens 本地优先于基线，只接受正数（非正数视同未提供）", () => {
    expect(resolveEvalModels({ underTest: { reviewMaxTokens: 1200 } }, { underTest: { reviewMaxTokens: 4096 } }, {}).underTestReviewMaxTokens).toBe(4096)
    expect(resolveEvalModels({ underTest: { reviewMaxTokens: 1200 } }, undefined, {}).underTestReviewMaxTokens).toBe(1200)
    expect(resolveEvalModels(undefined, { underTest: { reviewMaxTokens: -1 } }, {}).underTestReviewMaxTokens).toBeUndefined()
  })

  it("null 与缺失表示继承：两层都不给值时解析为 undefined", () => {
    const resolved = resolveEvalModels({ underTest: { provider: null, model: null }, judge: { model: null } }, {}, {})
    expect(resolved).toEqual({
      underTestProvider: undefined, underTestModel: undefined, underTestEndpoint: undefined,
      underTestApiKey: undefined, underTestReviewMaxTokens: undefined, judgeModel: undefined,
    })
  })

  it("忽略纯空白值（视同未提供）", () => {
    const resolved = resolveEvalModels({ underTest: { model: "  " }, judge: { model: " x " } }, {}, { DESKPET_EVAL_MODEL: "\t" })
    expect(resolved.underTestModel).toBeUndefined()
    expect(resolved.judgeModel).toBe("x")
  })

  it("两层都未定义时不抛错，全字段未提供", () => {
    expect(resolveEvalModels(undefined, undefined, {})).toEqual({
      underTestProvider: undefined, underTestModel: undefined, underTestEndpoint: undefined,
      underTestApiKey: undefined, judgeModel: undefined,
    })
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

  it("默认禁止凭据：进 git 的文件出现 apiKey 显式报错", () => {
    expect(() => parseEvalModelsFile('{"underTest":{"apiKey":"sk-x"}}')).toThrowError(/不得包含 apiKey/)
    expect(() => parseEvalModelsFile('{"judge":{"apiKey":"sk-x"}}')).toThrowError(/不得包含 apiKey/)
  })

  it("allowCredentials 放行本地文件的凭据字段", () => {
    const parsed = parseEvalModelsFile('{"underTest":{"apiKey":"sk-x","endpoint":"https://e.example"}}', { allowCredentials: true })
    expect(parsed.underTest?.apiKey).toBe("sk-x")
    expect(parsed.underTest?.endpoint).toBe("https://e.example")
  })

  it("合法文件解析出结构化字段", () => {
    const parsed = parseEvalModelsFile('{"underTest":{"model":"m1"},"judge":{"model":"j1"}}')
    expect(parsed.underTest?.model).toBe("m1")
    expect(parsed.judge?.model).toBe("j1")
  })
})
