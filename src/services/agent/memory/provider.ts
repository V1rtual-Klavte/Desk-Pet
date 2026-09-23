import type { MessageTaint } from "@/services/engine/runtime"
// 估算口径从零依赖叶子直接导入：`@/services/context` 的 barrel 会拉进 builder.ts，
// 而 builder.ts 已 import `@/services/agent/memory`，走 barrel 就成环。
import { estimateContextTokens } from "@/services/context/budget"

export interface MemoryRecallRequest {
  requestId: string
  sessionId: string
  query: string
  tokenBudget: number
  signal: AbortSignal
}

export interface MemoryProjection {
  sourceId: string
  memoryVersion: string
  provenance: string
  taint: MessageTaint
  text: string
  tokenBudget: number
}

export interface MemoryProvider {
  recall(request: MemoryRecallRequest): Promise<MemoryProjection[]>
}

/** P3 installs the recall boundary without enabling automatic long-term recall. */
export const emptyMemoryProvider: MemoryProvider = {
  async recall(_request) {
    return []
  },
}

const MEMORY_RECALL_TIMEOUT_MS = 1_500

/** 裁剪标记：与 L0 的缩短标记同思想 —— 超配显式可见，不静默截尾；标记本身不计入预算。 */
const RECALL_TRUNCATION_MARK = "…[召回文本超出预算，已按 token 口径截断]"

/**
 * 按 token 预算裁剪召回正文，与 `estimateContextTokens` 同口径逐单元累加到预算用尽。
 *
 * 旧实现按「4 字符 = 1 token」折算（字符数 = token 预算 × 4 再切片）：那个常数是中英通吃的平均值，
 * 中文下实际用量可达声明预算的约 4 倍（1 汉字 ≈ 1 token），而预算会计只按声明值扣减 ——
 * P6 接真实 provider 后就是 CJK 场景的预算穿透点。ASCII 与非 ASCII 分列计费后，
 * 裁剪边界与估算器、硬预算守卫重新对齐。
 */
function clipToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return ""
  if (estimateContextTokens(text) <= tokenBudget) return text
  // UTF-16 单元逐个累加（与估算器一致：emoji 代理对算两个单元），前缀估算单调不减，越界即停。
  let nonAscii = 0
  let length = 0
  for (; length < text.length; length++) {
    const unit = text.charCodeAt(length) > 0x7F ? 1 : 0
    if (Math.ceil(nonAscii + unit + (length + 1 - nonAscii - unit) / 4) > tokenBudget) break
    nonAscii += unit
  }
  return `${text.slice(0, length)}${RECALL_TRUNCATION_MARK}`
}

export async function recallMemory(request: Omit<MemoryRecallRequest, "signal">): Promise<MemoryProjection[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("MemoryProvider recall timeout")), MEMORY_RECALL_TIMEOUT_MS)
  try {
    const recalled = await Promise.race([
      activeProvider.recall({ ...request, signal: controller.signal }),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
    ])
    let remaining = Math.max(0, request.tokenBudget)
    return recalled.flatMap(projection => {
      if (remaining <= 0 || !projection || typeof projection.text !== "string" || !projection.text.trim()) return []
      const budget = Math.min(remaining, Math.max(0, projection.tokenBudget))
      remaining -= budget
      return [{ ...projection, text: clipToTokenBudget(projection.text, budget), tokenBudget: budget }]
    })
  } finally {
    clearTimeout(timer)
  }
}

let activeProvider: MemoryProvider = emptyMemoryProvider

export function getMemoryProvider(): MemoryProvider { return activeProvider }

/** Installs one recall strategy and restores only if it is still current. */
export function installMemoryProvider(provider: MemoryProvider): () => void {
  const previous = activeProvider
  activeProvider = provider
  return () => { if (activeProvider === provider) activeProvider = previous }
}

export function resetMemoryProvider(): void { activeProvider = emptyMemoryProvider }
