import type { PlanVerificationVerdict } from "./types"

/** 验收档的展示文案（唯一一处）：失败优先，成功再分证据是否闭环。 */
export function planAcceptanceLabel(success: boolean, acceptance: "verified" | "unverified"): string {
  if (!success) return "失败"
  return acceptance === "verified" ? "完成（证据已核对）" : "完成（未验收）"
}

/**
 * 步骤归宿的展示文案（唯一一处）：有结构化产出时按产出状态说，
 * 没有产出才退回旧的验收档口径（成功但没产出 = 未验收）。
 */
export function planOutcomeLabel(
  outcome: { status: "complete" | "partial" | "blocked" } | undefined,
  success: boolean,
): string {
  if (outcome === undefined) return success ? "完成（未验收）" : "失败"
  switch (outcome.status) {
    case "complete": return "完成"
    case "partial": return "部分完成"
    case "blocked": return "受阻"
  }
}

/**
 * 计划级核验的展示文案（唯一一处）：planner 的模型可见结果与用户可见兜底都从这里取，
 * 不在各自文件里另写一份 verdict → 文案映射。
 */
export function planVerificationLabel(verdict: PlanVerificationVerdict): string {
  switch (verdict) {
    case "pass": return "通过"
    case "partial": return "部分通过"
    case "fail": return "未通过"
  }
}

// 回读进主回合上下文的细节预算：产出字段可能有 20 条 × 2000 字符，整段回读会挤占上下文。
const READBACK_SUMMARY_BUDGET = 800
const READBACK_ITEM_BUDGET = 300
const READBACK_LIST_BUDGET = 1200

function cap(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}…（已截断）`
}

function capList(items: readonly string[]): string {
  const parts: string[] = []
  let used = 0
  for (const item of items) {
    const text = cap(item, READBACK_ITEM_BUDGET)
    if (used + text.length > READBACK_LIST_BUDGET) {
      parts.push("…（其余已省略）")
      break
    }
    parts.push(text)
    used += text.length + 1
  }
  return parts.join("；")
}

/** 回读用的产出投影：只认结构里能展示的部分，形状不合按「没有产出」处理。 */
interface ReadbackOutcome {
  status: "complete" | "partial" | "blocked"
  summary?: string
  missing?: string[]
  needs?: string
}

function readbackOutcome(value: unknown): ReadbackOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  if (row.status !== "complete" && row.status !== "partial" && row.status !== "blocked") return undefined
  return {
    status: row.status,
    ...(typeof row.summary === "string" ? { summary: row.summary } : {}),
    ...(Array.isArray(row.missing)
      ? { missing: row.missing.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(typeof row.needs === "string" ? { needs: row.needs } : {}),
  }
}

/**
 * 主回合回读一条 `deskpet.plan_step_result` 的正文。
 * 子运行的槽读不到父会话条目，所以这条投影只服务主回合；形状不合按不可读处理。
 * 有结构化产出时只回读摘要与缺口，不把原始 JSON 正文整段塞给主回合。
 */
export function formatPlanStepResultReadback(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const result = data as Record<string, unknown>
  const { stepId, title, acceptance, success, reply, error, outcome } = result
  if (typeof stepId !== "string" || typeof title !== "string" || typeof success !== "boolean"
    || typeof reply !== "string"
    || (acceptance !== "verified" && acceptance !== "unverified")
    || (error !== undefined && typeof error !== "string")) return undefined
  const parsed = readbackOutcome(outcome)
  if (parsed) {
    const lines = [
      `[计划步骤结果] 步骤 ${stepId}「${title}」：${planOutcomeLabel(parsed, success)}`,
      cap(parsed.summary?.trim() ? parsed.summary : reply, READBACK_SUMMARY_BUDGET),
    ]
    if (parsed.missing?.length) lines.push(`缺口：${capList(parsed.missing)}`)
    if (parsed.needs?.trim()) lines.push(`需要：${cap(parsed.needs, READBACK_ITEM_BUDGET)}`)
    // 产出已定档时 error 只是同一结论的中性摘要（见 executeStep），不再重复回读。
    return lines.join("\n")
  }
  const lines = [`[计划步骤结果] 步骤 ${stepId}「${title}」：${planAcceptanceLabel(success, acceptance)}`, reply]
  if (typeof error === "string" && error.trim() !== "") lines.push(`错误：${error}`)
  return lines.join("\n")
}
