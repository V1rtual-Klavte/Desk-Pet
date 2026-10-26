// ==========================================
// sim-eval 测试侧模型覆盖 — 只作用于隔离副本
// ==========================================
//
// 评测执行器把 `test/eval-models.json`（进 git，不得含凭据）与可选的
// `test/eval-models.local.json`（本地专属，可含凭据）stage 到隔离数据根根目录。
// 本模块在 `initConfig()` 之后、任何模型消费者之前解析两层配置与 `DESKPET_EVAL_*`
// 环境变量，把被测模型通过 `setOverrides` 写进本进程的运行时 CONFIG 并落盘。
//
// 覆盖只落在 `<workspace>/test/.tmp/sim-eval-*/data/settings/CONFIG.yaml`：
// 不读真实开发配置，不回写真实数据根；日志只报告是否配置了 endpoint/apiKey，
// 绝不回显凭据值。judge 模型字段供记忆基准等独立评测使用；聊天评测的 judge 是
// 外部 coding agent，运行器不读取 judge 凭据，也不调用模型 API。

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { flushConfig, setOverrides } from "@/services/config"
import { createLogger } from "@/services/logger"
import { parseEvalModelsFile, resolveEvalModels } from "./eval-models"
import type { EvalModelsFile } from "./eval-models"
import { getSimEvalRunContext } from "./run-context"

const log = createLogger("SimEvalModels")
const BASE_FILE = "eval-models.json"
const LOCAL_FILE = "eval-models.local.json"

export interface SimEvalModelSummary {
  provider?: string
  model?: string
  endpointConfigured: boolean
  apiKeyConfigured: boolean
  reviewMaxTokens?: number
  judgeModel?: string
}

let applied: Promise<SimEvalModelSummary | null> | null = null

/** 应用一次测试侧模型覆盖（进程内单次）；非 sim-eval 运行返回 null。 */
export function applySimEvalModelOverrides(): Promise<SimEvalModelSummary | null> {
  applied ??= apply()
  return applied
}

async function apply(): Promise<SimEvalModelSummary | null> {
  const context = await getSimEvalRunContext()
  if (!context) return null

  const base = await readStaged(context.dataRoot, BASE_FILE, false)
  const local = await readStaged(context.dataRoot, LOCAL_FILE, true)
  const resolved = resolveEvalModels(base, local, process.env)

  const overrides: Record<string, unknown> = {}
  if (resolved.underTestProvider) overrides["ai.provider"] = resolved.underTestProvider
  if (resolved.underTestModel) overrides["ai.model"] = resolved.underTestModel
  if (resolved.underTestEndpoint) overrides["ai.endpoint"] = resolved.underTestEndpoint
  if (resolved.underTestApiKey) overrides["ai.apiKey"] = resolved.underTestApiKey
  if (resolved.underTestReviewMaxTokens !== undefined) {
    overrides["ai.memory.dreaming.reviewMaxTokens"] = resolved.underTestReviewMaxTokens
  }
  if (Object.keys(overrides).length > 0) {
    setOverrides(overrides)
    await flushConfig()
  }

  const summary: SimEvalModelSummary = {
    provider: resolved.underTestProvider,
    model: resolved.underTestModel,
    endpointConfigured: resolved.underTestEndpoint !== undefined,
    apiKeyConfigured: resolved.underTestApiKey !== undefined,
    reviewMaxTokens: resolved.underTestReviewMaxTokens,
    judgeModel: resolved.judgeModel,
  }
  log.info(
    "测试侧模型覆盖:",
    `${summary.provider ?? "继承"}/${summary.model ?? "继承"}`,
    `endpoint=${summary.endpointConfigured ? "已配置" : "继承"}`,
    `apiKey=${summary.apiKeyConfigured ? "已配置" : "继承"}`,
    summary.reviewMaxTokens === undefined ? "reviewMaxTokens=继承" : `reviewMaxTokens=${summary.reviewMaxTokens}`,
    `judge=${summary.judgeModel ?? "继承"}`,
  )
  return summary
}

async function readStaged(
  dataRoot: string,
  name: string,
  allowCredentials: boolean,
): Promise<EvalModelsFile> {
  let text: string
  try {
    text = await readFile(join(dataRoot, name), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // local 是可选的本地文件；base 缺失说明启动器没 stage，留一条 warn 不静默。
      if (!allowCredentials) log.warn(`${name} 未在隔离根找到；被测模型继承隔离副本配置`)
      return {}
    }
    throw error
  }
  return parseEvalModelsFile(text, { allowCredentials })
}
