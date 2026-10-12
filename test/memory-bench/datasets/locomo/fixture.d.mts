export function renderLocomoDialogueEntry(input: {
  speaker: string
  dateText: string | null
  text: string
  blipCaption?: string
}): string

export const LOCOMO_ANSWER_FORMAT: Readonly<{ id: string; prompt: string }>
export function formatLocomoAnswerCard(rawCard: string): string
