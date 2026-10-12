export function buildMemoryBankJudgePrompt(input: { question: string; history: string; response: string }): { templateId: string; prompt: string }
export function parseMemoryBankJudgeVerdict(text: unknown): boolean | null
export function judgeOutputBudget(modelMaxTokens: number, availableContextTokens?: number): number
