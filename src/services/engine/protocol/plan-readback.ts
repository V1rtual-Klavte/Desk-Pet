/** 验收档的展示文案（唯一一处）：失败优先，成功再分证据是否闭环。 */
export function planAcceptanceLabel(success: boolean, acceptance: "verified" | "unverified"): string {
  if (!success) return "失败"
  return acceptance === "verified" ? "完成（证据已核对）" : "完成（未验收）"
}

/**
 * 主回合回读一条 `deskpet.plan_step_result` 的正文。
 * 子运行的槽读不到父会话条目，所以这条投影只服务主回合；形状不合按不可读处理。
 */
export function formatPlanStepResultReadback(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const result = data as Record<string, unknown>
  const { stepId, title, acceptance, success, reply, error } = result
  if (typeof stepId !== "string" || typeof title !== "string" || typeof success !== "boolean"
    || typeof reply !== "string"
    || (acceptance !== "verified" && acceptance !== "unverified")
    || (error !== undefined && typeof error !== "string")) return undefined
  const lines = [`[计划步骤结果] 步骤 ${stepId}「${title}」：${planAcceptanceLabel(success, acceptance)}`, reply]
  if (typeof error === "string" && error.trim() !== "") lines.push(`错误：${error}`)
  return lines.join("\n")
}
