import type { MessageTaint } from "@/services/engine/runtime"

export interface MemoryRecallRequest {
  requestId: string
  sessionId: string
  query: string
  tokenBudget: number
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
