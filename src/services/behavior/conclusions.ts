// ==========================================
// 稳定结论（可沉淀视图）—— 画像读模型上唯一的「允许进入长期记忆」的出口
// ==========================================
//
// 落点自证（2026-10-06 用户裁决「方案 b」）：
// - 输入只有 `BehaviorSnapshot`（画像层已算出的近 30 日读模型：rhythm / apps /
//   focus / activity + quality），**拿不到** daily/segments 原始账 —— 类型签名就是边界，
//   「把原始观察带进去」需要先改这个函数的入参，不是一句注释约定。
// - 只有 reliable 档（≥3 个有效观察日 + 覆盖率 ≥60%，见 aggregate.ts 的 qualityFor）
//   才产出结论；其余状态返回空数组 = 不登记、不沉淀。
// - 结论只用**带段 / 整比 / 取整**后的表述（活跃时段带、类别占比、取整分钟数），
//   不输出：具体某天的工时、精确时间戳、逐次应用切换细节 —— 那些只留在画像域
//   （不记清单见 docs/current/behavior.md「稳定结论沉淀」一节）。
// - 可重验性：每条结论自带判据（依据的画像字段与窗口）。结论由当前滚动窗口重算，
//   新数据自然改写文本 → 新的来源版本 → 整理覆盖旧条目；清画像时整批失效。
//   刻意不依赖 >30 天历史 —— 与 daily/segments 降级为滚动工作缓冲的口径一致。
//
// 这个模块是纯函数：不触 IPC、不读盘、不注册来源；登记与整理在 memory 域完成。

import { BEHAVIOR_MEASUREMENT_VERSION } from "./types"
import type { AppCategory, BehaviorSnapshot } from "./types"

export type BehaviorConclusionSlot = "rhythm" | "apps" | "focus" | "activity"

export interface BehaviorConclusion {
  slot: BehaviorConclusionSlot
  text: string
  measurementVersion: typeof BEHAVIOR_MEASUREMENT_VERSION
}

/** 结论共同的时间口径：画像快照本身就是近 30 个日历日的读模型。 */
const WINDOW_LABEL = "近一个月"
const WINDOW_BASIS = "近30日画像窗口"

/** 节律取最强 4 小时带：比逐小时直方图更接近「结论」，也不泄漏精确时刻。 */
const BAND_HOURS = 4
/** 常用类别最多列 2 类、常用应用最多列 3 个（有界），低于占比下限的类别不单列。 */
const TOP_CATEGORIES = 2
const TOP_APPS = 3
const CATEGORY_SHARE_FLOOR = 0.15

const CATEGORY_LABELS: Record<AppCategory, string> = {
  work: "办公",
  communication: "通讯",
  media: "影音",
  development: "开发",
  browser: "浏览器",
  other: "其他",
  unknown: "未知",
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step
}

/** 24 小时里求和最大的连续 4 小时窗口；全零时返回 null（不编造结论）。 */
function dominantBand(hours: readonly number[]): { start: number; end: number } | null {
  const total = hours.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return null
  let best = -1
  let bestStart = 0
  for (let start = 0; start + BAND_HOURS <= hours.length; start += 1) {
    let sum = 0
    for (let hour = start; hour < start + BAND_HOURS; hour += 1) sum += hours[hour] ?? 0
    if (sum > best) { best = sum; bestStart = start }
  }
  return best > 0 ? { start: bestStart, end: bestStart + BAND_HOURS } : null
}

function rhythmConclusion(snapshot: BehaviorSnapshot): string | null {
  const parts: string[] = []
  const weekday = dominantBand(snapshot.rhythm.weekdays)
  const weekend = dominantBand(snapshot.rhythm.weekends)
  if (weekday) parts.push(`工作日集中在 ${weekday.start}–${weekday.end} 时`)
  if (weekend) parts.push(`周末集中在 ${weekend.start}–${weekend.end} 时`)
  if (parts.length === 0) return null
  return `${WINDOW_LABEL}的活跃时段：${parts.join("，")}。（判据：${WINDOW_BASIS}的最强 ${BAND_HOURS} 小时活跃带）`
}

function appsConclusion(snapshot: BehaviorSnapshot): string | null {
  const ranked = (Object.entries(snapshot.apps.categoryShare) as [AppCategory, number][])
    .filter(([category, share]) => category !== "unknown" && share >= CATEGORY_SHARE_FLOOR)
    .sort((left, right) => right[1] - left[1])
  if (ranked.length === 0) return null
  const top = ranked.slice(0, TOP_CATEGORIES)
  const share = Math.round(top.reduce((sum, [, value]) => sum + value, 0) * 100)
  const apps = snapshot.apps.commonAppIds.slice(0, TOP_APPS)
  const categoryPart = `已识别的前台应用中，${top.map(([category]) => CATEGORY_LABELS[category]).join("、")}类为主（约占 ${share}%）`
  const appPart = apps.length ? `，常用 ${apps.join("、")}` : ""
  const confidencePart = `；可靠分类覆盖约 ${Math.round(snapshot.apps.classificationRatio * 100)}%`
  return `${WINDOW_LABEL}的前台应用观察：${categoryPart}${appPart}${confidencePart}。（判据：${WINDOW_BASIS}的身份分类与前台应用时长）`
}

function focusConclusion(snapshot: BehaviorSnapshot): string | null {
  const meanMinutes = snapshot.focus.meanMs > 0 ? roundTo(snapshot.focus.meanMs / 60_000, 5) : 0
  const longestMinutes = snapshot.focus.longestMs > 0 ? roundTo(snapshot.focus.longestMs / 60_000, 15) : 0
  if (meanMinutes <= 0 && longestMinutes <= 0) return null
  const parts: string[] = []
  if (meanMinutes > 0) parts.push(`连续观察到的办公/开发活跃段通常约 ${meanMinutes} 分钟`)
  if (longestMinutes > 0) parts.push(`最长约 ${longestMinutes} 分钟`)
  return `${WINDOW_LABEL}的前台应用活跃观察：${parts.join("，")}。（判据：${WINDOW_BASIS}的可信活跃段统计，按 5/15 分钟取整）`
}

function activityConclusion(snapshot: BehaviorSnapshot): string | null {
  const { activeMs, idleMs, unobservedMs } = snapshot.activity
  const { unknownMs } = snapshot.activity
  const total = activeMs + idleMs + unknownMs + unobservedMs
  if (!(total > 0) || !(activeMs > 0)) return null
  const share = Math.round((activeMs / total) * 100)
  return `${WINDOW_LABEL}的观察活跃约占 ${share}%（其余为空闲、活动状态未知或未观察）。（判据：${WINDOW_BASIS}的互斥活动时长桶）`
}

/**
 * 稳定结论：reliable 档才产出，最多 4 条（每个画像组一条），文本有界且可重算。
 *
 * 返回值只描述「画像读模型能支持的结论」；是否登记为来源、是否沉淀进记忆由调用方决定。
 */
export function sedimentConclusions(snapshot: BehaviorSnapshot): BehaviorConclusion[] {
  if (snapshot.quality.status !== "reliable") return []
  const built: Array<[BehaviorConclusionSlot, string | null]> = [
    ["rhythm", rhythmConclusion(snapshot)],
    ["apps", appsConclusion(snapshot)],
    ["focus", focusConclusion(snapshot)],
    ["activity", activityConclusion(snapshot)],
  ]
  const out: BehaviorConclusion[] = []
  for (const [slot, text] of built) {
    if (text) out.push({ slot, text, measurementVersion: BEHAVIOR_MEASUREMENT_VERSION })
  }
  return out
}
