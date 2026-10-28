/** Diagnostic URL projection only; query/fragment/credentials stay out of logs. */
export function urlForLog(raw: unknown): string {
  if (typeof raw !== "string") return "<invalid>"
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return "<invalid>"
  }
}
