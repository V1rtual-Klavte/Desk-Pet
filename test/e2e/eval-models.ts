// 测试侧统一模型配置的解析（纯函数，无 IPC）。
// 来源优先级：环境变量 > test/eval-models.local.json（本地专属、已 gitignore、可含凭据）
// > test/eval-models.json（进 git、不得含 apiKey）> 内置默认。
// 解析结果只用于隔离副本内的 setOverrides 与 judge 传参；凭据与真实配置不受影响。

export interface EvalModelsFile {
  underTest?: { provider?: string | null; model?: string | null; endpoint?: string | null; apiKey?: string | null; reviewMaxTokens?: number | null } | null
  judge?: { model?: string | null } | null
}

export interface ResolvedEvalModels {
  underTestProvider?: string
  underTestModel?: string
  underTestEndpoint?: string
  underTestApiKey?: string
  underTestReviewMaxTokens?: number
  judgeModel?: string
}

/** 第一个「有内容的字符串」获胜；null / undefined / 空白都视为「未提供」。 */
export function resolveEvalModels(
  base: EvalModelsFile | undefined,
  local: EvalModelsFile | undefined,
  env: Record<string, string | undefined>,
): ResolvedEvalModels {
  const pick = (...values: (string | null | undefined)[]): string | undefined => {
    for (const value of values) {
      if (typeof value === "string" && value.trim() !== "") return value.trim()
    }
    return undefined
  }
  /** 正数才有效：非数字 / 非正数视同未提供（消费端的防呆下限另算）。 */
  const pickNumber = (...values: (number | null | undefined)[]): number | undefined => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value)
    }
    return undefined
  }
  return {
    underTestProvider: pick(env.DESKPET_EVAL_PROVIDER, local?.underTest?.provider, base?.underTest?.provider),
    underTestModel: pick(env.DESKPET_EVAL_MODEL, local?.underTest?.model, base?.underTest?.model),
    underTestEndpoint: pick(local?.underTest?.endpoint, base?.underTest?.endpoint),
    underTestApiKey: pick(local?.underTest?.apiKey, base?.underTest?.apiKey),
    underTestReviewMaxTokens: pickNumber(local?.underTest?.reviewMaxTokens, base?.underTest?.reviewMaxTokens),
    judgeModel: pick(env.DESKPET_EVAL_JUDGE_MODEL, local?.judge?.model, base?.judge?.model),
  }
}

/**
 * 坏配置显式失败（配置错误是 setup 问题，不静默按默认跑）。
 * 默认禁止凭据字段：eval-models.json 进 git，apiKey 只能出现在本地专属的
 * eval-models.local.json（已 gitignore，解析时用 allowCredentials 显式放行）。
 */
export function parseEvalModelsFile(text: string, options?: { allowCredentials?: boolean }): EvalModelsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`模型配置不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("模型配置顶层必须是对象")
  }
  const file = parsed as EvalModelsFile
  if (!options?.allowCredentials) {
    const leaked = [file.underTest?.apiKey, (file.judge as { apiKey?: string | null } | null | undefined)?.apiKey]
      .some(value => typeof value === "string" && value.trim() !== "")
    if (leaked) {
      throw new Error("eval-models.json（进 git）不得包含 apiKey；凭据请放 test/eval-models.local.json（已 gitignore）")
    }
  }
  return file
}
