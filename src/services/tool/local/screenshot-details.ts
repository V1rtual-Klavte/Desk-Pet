// ==========================================
// 截图工具的 details 契约（零依赖叶子）
//
// 写入方是 `screenshot` 工具的执行结果，读取方是运行内核的提交链
// （engine/harness/runtime 的 afterTool / afterResponse）—— 两侧共用这一份形状判定，
// 不各自写一遍字符串键。`show_to_user` 的截图路径在这里被宿主取走，
// 并入本回合提交的助手条目（`deskpetImagePaths`），供聊天里展示。
// ==========================================

/** 工具名：定义与宿主判定共用这一处，避免两处各写一个字面量。 */
export const SCREENSHOT_TOOL_NAME = "screenshot"

/** `screenshot` 工具结果 details 的契约形状。 */
export interface ScreenshotToolDetails {
  /** 截图落盘后的绝对路径（数据根 screenshots/ 内）。 */
  screenshotPath: string
  /** 是否要在聊天里展示给用户（模型参数 show_to_user 的冻结值）。 */
  showToUser: boolean
}

/**
 * 只有形状完整（路径非空字符串 + showToUser 为布尔）才返回契约值；
 * 其它工具的 details 或写坏的形态一律返回 undefined，由调用方按「没有截图」处理。
 */
export function readScreenshotToolDetails(details: unknown): ScreenshotToolDetails | undefined {
  if (!details || typeof details !== "object") return undefined
  const screenshotPath = (details as { screenshotPath?: unknown }).screenshotPath
  const showToUser = (details as { showToUser?: unknown }).showToUser
  if (typeof screenshotPath !== "string" || screenshotPath.length === 0) return undefined
  if (typeof showToUser !== "boolean") return undefined
  return { screenshotPath, showToUser }
}
