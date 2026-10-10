export interface ReaderControlSession {
  sessionId: string
  sessionDate: string
  turns: Array<{ turnIndex: number; role: "user" | "assistant"; content: string }>
}
export function requireCompleteReaderOutput(result: { stopReason: string; text?: string | null }, stage?: string): string
export function buildReaderControlPrompts(caseDef: Record<string, unknown>, mode: "direct" | "con"): {
  systemPrompt: string
  noteSystemPrompt: string
  sessions: ReaderControlSession[]
  notePrompts: string[]
  finalPrompt(history?: string): string
}
