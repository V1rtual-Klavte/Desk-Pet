// 会话事件兼容适配
// 新格式使用 deskpet-event HTML comment；旧 session 文件只包含 turn 或预览时仍可读取。

import type {
  MessageOrigin,
  SessionEvent,
  SessionEventKind,
} from "@/services/engine/runtime"
import type { SessionMemory } from "./types"
import { localTime } from "./parsers"

const EVENT_MARKER = /<!--\s*deskpet-event:([^\s]+)\s*-->/
const TURN_MARKER = /<!--\s*deskpet-turn:([^\s]+)\s*-->/
const PREVIEW_LINE = /^-\s*\[([^\]]+)\]\s*\*\*([^*]+)\*\*:\s*(.+)/
const EVENT_KINDS: readonly SessionEventKind[] = [
  "turn_created", "turn_state", "user_message", "assistant_message",
  "tool_call", "tool_result", "system_message", "active_message",
  "hook_message", "plan_checkpoint", "queue_state", "recovery",
  "prompt_snapshot", "compaction", "memory_projection", "error",
]
const MESSAGE_ORIGINS: readonly MessageOrigin[] = [
  "user", "assistant", "tool", "active", "hook", "queue", "recovery", "plan", "memory",
]

/** Parsed representation of a pre-event session record. */
export interface LegacySessionEvent {
  schemaVersion: 0
  eventId: string
  sessionId: string
  turnId?: string
  kind: "user_message" | "assistant_message"
  origin: "user" | "assistant"
  payload: {
    text: string
    role: "user" | "assistant"
    timestamp: number
    visibleToUser: true
    eligibleForTranscript: true
    eligibleForMemory: boolean
    isMeta: false
  }
  createdAt: number
  idempotencyKey: string
}

export type SessionEventCompat = SessionEvent | LegacySessionEvent

export type SessionEventParseIssueCode =
  | "invalid_event_encoding"
  | "invalid_event_shape"
  | "invalid_turn_encoding"
  | "invalid_turn_shape"

export interface SessionEventParseIssue {
  code: SessionEventParseIssueCode
  line: number
  rawRecord: string
}

export interface SessionEventDocument {
  events: SessionEventCompat[]
  issues: SessionEventParseIssue[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T)
}

function decodeJson(encoded: string): { value?: unknown; valid: boolean } {
  try {
    return { value: JSON.parse(decodeURIComponent(encoded)) as unknown, valid: true }
  } catch {
    return { valid: false }
  }
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value) || value.schemaVersion !== 1) return false
  return typeof value.eventId === "string"
    && typeof value.sessionId === "string"
    && isOneOf(value.kind, EVENT_KINDS)
    && isOneOf(value.origin, MESSAGE_ORIGINS)
    && isRecord(value.payload)
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && typeof value.idempotencyKey === "string"
}

function stableHash(input: string): string {
  // FNV-1a 32-bit is sufficient here: this is an identifier namespace, not a security hash.
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function legacyEventId(sessionId: string, index: number, turn: SessionMemory["turns"][number]): string {
  return `legacy-${stableHash(`${sessionId}|${index}|${turn.role}|${turn.timestamp}|${turn.text}`)}`
}

function legacyEvent(sessionId: string, index: number, turn: SessionMemory["turns"][number]): LegacySessionEvent {
  const eventId = legacyEventId(sessionId, index, turn)
  return {
    schemaVersion: 0,
    eventId,
    sessionId,
    kind: turn.role === "user" ? "user_message" : "assistant_message",
    origin: turn.role,
    payload: {
      text: turn.text,
      role: turn.role,
      timestamp: turn.timestamp,
      visibleToUser: true,
      eligibleForTranscript: true,
      eligibleForMemory: turn.role === "user",
      isMeta: false,
    },
    createdAt: turn.timestamp,
    idempotencyKey: eventId,
  }
}

function eventText(event: SessionEvent): string | undefined {
  const text = event.payload.text
  return typeof text === "string" ? text : undefined
}

/** Serialize one event as a readable preview plus a lossless HTML comment. */
export function serializeSessionEvent(event: SessionEvent, previewText?: string): string[] {
  const text = previewText ?? eventText(event) ?? `[${event.kind}]`
  const preview = text.replace(/\s+/g, " ").trim().substring(0, 300)
  const encoded = encodeURIComponent(JSON.stringify(event))
  return [
    `- [${localTime(event.createdAt)}] **${event.origin}**: ${preview}`,
    `  <!-- deskpet-event:${encoded} -->`,
  ]
}

/**
 * Parse event comments and upgrade old turn/preview records to a stable
 * compatibility shape. First occurrence wins for duplicate event IDs or
 * idempotency keys. Corrupt comments are retained in structured issues.
 */
export function parseSessionEventDocument(raw: string, sessionId = "legacy-session"): SessionEventDocument {
  if (!raw) return { events: [], issues: [] }

  const events: SessionEventCompat[] = []
  const issues: SessionEventParseIssue[] = []
  const seenEventIds = new Set<string>()
  const seenIdempotencyKeys = new Set<string>()
  const lines = raw.split("\n")
  let inConversation = false
  let legacyIndex = 0

  function append(event: SessionEventCompat): void {
    if (seenEventIds.has(event.eventId) || seenIdempotencyKeys.has(event.idempotencyKey)) return
    events.push(event)
    seenEventIds.add(event.eventId)
    seenIdempotencyKeys.add(event.idempotencyKey)
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.startsWith("## 对话记录")) { inConversation = true; continue }
    if (line.startsWith("## ")) { inConversation = false; continue }

    const eventMatch = line.match(EVENT_MARKER)
    if (eventMatch) {
      const decoded = decodeJson(eventMatch[1])
      if (!decoded.valid) {
        issues.push({ code: "invalid_event_encoding", line: index + 1, rawRecord: line })
      } else if (!isSessionEvent(decoded.value)) {
        issues.push({ code: "invalid_event_shape", line: index + 1, rawRecord: line })
      } else {
        append(decoded.value)
      }
      continue
    }

    const turnMatch = line.match(TURN_MARKER)
    if (turnMatch) {
      const decoded = decodeJson(turnMatch[1])
      if (!decoded.valid) {
        issues.push({ code: "invalid_turn_encoding", line: index + 1, rawRecord: line })
      } else if (!isRecord(decoded.value)
        || (decoded.value.role !== "user" && decoded.value.role !== "assistant")) {
        issues.push({ code: "invalid_turn_shape", line: index + 1, rawRecord: line })
      } else {
        const text = typeof decoded.value.text === "string"
          ? decoded.value.text
          : String(decoded.value.text ?? "")
        const timestamp = typeof decoded.value.timestamp === "number" && Number.isFinite(decoded.value.timestamp)
          ? decoded.value.timestamp
          : 0
        append(legacyEvent(sessionId, legacyIndex++, { role: decoded.value.role, text, timestamp }))
      }
      continue
    }

    if (!inConversation) continue
    const previewMatch = line.match(PREVIEW_LINE)
    if (!previewMatch) continue
    // A preview immediately followed by exact metadata is display-only.
    if (EVENT_MARKER.test(lines[index + 1] ?? "") || TURN_MARKER.test(lines[index + 1] ?? "")) continue
    const timestamp = Date.parse(previewMatch[1])
    const turn: SessionMemory["turns"][number] = {
      role: previewMatch[2].trim() === "糖糖" ? "assistant" : "user",
      text: previewMatch[3].trim(),
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
    }
    append(legacyEvent(sessionId, legacyIndex++, turn))
  }

  events.sort((a, b) => a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId))
  return { events, issues }
}

export function parseSessionEventsFromRaw(raw: string, sessionId = "legacy-session"): SessionEventCompat[] {
  return parseSessionEventDocument(raw, sessionId).events
}
