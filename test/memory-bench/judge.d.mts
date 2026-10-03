export const LME_JUDGE_TEMPLATES: readonly string[]
export function judgeTemplateId(questionType: string, abstention: boolean): string
export function buildLongMemEvalJudgePrompt(input: { questionType: string; question: string; answer: string; response: string; abstention?: boolean }): { templateId: string; prompt: string }
export function buildMemoryBankJudgePrompt(input: { question: string; history: string; response: string }): { templateId: string; prompt: string }
export function parseJudgeVerdict(text: unknown): boolean
export function judgeOutputBudget(modelMaxTokens?: number | null): number
