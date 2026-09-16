import type { MessageTaint } from "@/services/engine/runtime"

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
      return [{ ...projection, text: projection.text.slice(0, budget * 4), tokenBudget: budget }]
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
