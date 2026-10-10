// Shared, content-free reader diagnostics; safe for the trace privacy boundary.
export const MEMORY_READING_ERROR_CATEGORIES = [
  "invalid_json",
  "invalid_document",
  "invalid_note_shape",
  "invalid_note_id",
  "invalid_quote",
  "non_contiguous_quote",
  "duplicate_note",
  "invalid_relevance",
  "missing_question_checks",
  "invalid_question_checks",
  "invalid_check_shape",
  "duplicate_check",
  "invalid_check_source",
  "invalid_search_query",
] as const

export type ReadingErrorCategory = typeof MEMORY_READING_ERROR_CATEGORIES[number]
