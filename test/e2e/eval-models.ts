// 测试侧统一模型配置的解析（纯函数，无 IPC）。
// 来源优先级：环境变量 > test/eval-models.json（启动器 stage 到隔离数据根）> 内置默认。
// 解析结果只用于隔离副本内的 setOverrides 与 judge 传参；凭据与真实配置不受影响。

export interface EvalModelsFile {
  underTest?: { provider?: string | null; model?: string | null } | null
  judge?: { model?: string | null } | null
}

export interface ResolvedEvalModels {
  underTestProvider?: string
  underTestModel?: string
  judgeModel?: string
}

/** 第一个「有内容的字符串」获胜；null / undefined / 空白都视为「未提供」。 */
export function resolveEvalModels(file: EvalModelsFile | undefined, env: Record<string, string | undefined>): ResolvedEvalModels {
  const pick = (...values: (string | null | undefined)[]): string | undefined => {
    for (const value of values) {
      if (typeof value === "string" && value.trim() !== "") return value.trim()
    }
    return undefined
  }
  return {
    underTestProvider: pick(env.DESKPET_EVAL_PROVIDER, file?.underTest?.provider),
    underTestModel: pick(env.DESKPET_EVAL_MODEL, file?.underTest?.model),
    judgeModel: pick(env.DESKPET_EVAL_JUDGE_MODEL, file?.judge?.model),
  }
}

/** 坏配置显式失败（配置错误是 setup 问题，不静默按默认跑）。 */
export function parseEvalModelsFile(text: string): EvalModelsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`eval-models.json 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("eval-models.json 顶层必须是对象")
  }
  return parsed as EvalModelsFile
}
