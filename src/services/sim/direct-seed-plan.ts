// ==========================================
// direct-seed 装载计划 — 纯校验与形状归一
// ==========================================
//
// seed.json 由评测执行器写入运行根：fixture 原文 + 已解析的 Card/Profile 激活目标。
// 本模块只做纯校验，不碰磁盘/产品服务，便于 L2 单测；真正写入见 direct-seed.ts。
//
// 口径：
// - 只装载「纠正前」的初始会话与旧记忆；纠正结果、自动抽取结果都不预置。
// - fixture 里的 profile: "default" 表示沿用运行时 CONFIG 的默认 Profile（不覆盖），
//   其余值必须给出具体 activeId。
// - 消息时间戳必须非递减，固定时钟不得早于最后一条 fixture 消息 —— 历史先于评估时刻。

export const DIRECT_SEED_FILE_SCHEMA_VERSION = 1
export const DIRECT_SEED_FIXTURE_SCHEMA_VERSION = 4

const MESSAGE_ROLES = ["user", "assistant"] as const
const MEMORY_KINDS = ["fact", "preference", "episode", "working"] as const
const MEMORY_SCOPES = ["user", "session"] as const

export interface DirectSeedMessage {
  key: string
  role: "user" | "assistant"
  content: string
  atMs: number
}

export interface DirectSeedMemory {
  key: string
  kind: "fact" | "preference" | "episode" | "working"
  scope: "user" | "session"
  scopeId?: string
  content: string
  validFromMs: number
  validUntilMs: number | null
  sourceMessageKey: string
}

export interface DirectSeedSourceMessage {
  key: string
  seq: number
  content: string
  atMs: number
}

export interface DirectSeedPlan {
  fixtureId: string
  fixtureHash: string
  clockMs: number
  card: { name: string; activeId: string }
  profileId: string | null
  session: { id: string; title: string; messages: DirectSeedMessage[] }
  memory: DirectSeedMemory[]
  sourceMessages: DirectSeedSourceMessage[]
}

function fail(message: string): never {
  throw new Error(`direct-seed 计划无效：${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} 必须是非空字符串`)
  return value
}

function instant(value: unknown, field: string): number {
  if (typeof value !== "string") fail(`${field} 必须是 ISO 时间字符串`)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) fail(`${field} 不是可解析时间：${value}`)
  return ms
}

function optionalInstant(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return instant(value, field)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${field} 必须是 ${allowed.join(" | ")}`)
  }
  return value as T
}

function parseSession(raw: unknown): DirectSeedPlan["session"] {
  if (!isRecord(raw)) fail("fixture.initialSession 缺失")
  const id = text(raw.id, "fixture.initialSession.id")
  const title = text(raw.title, "fixture.initialSession.title")
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    fail("fixture.initialSession.messages 不能为空")
  }
  const seen = new Set<string>()
  const messages: DirectSeedMessage[] = []
  let lastAt = -Infinity
  raw.messages.forEach((entry, index) => {
    if (!isRecord(entry)) fail(`fixture.initialSession.messages[${index}] 不是对象`)
    const key = text(entry.id, `fixture.initialSession.messages[${index}].id`)
    if (seen.has(key)) fail(`fixture 消息 id 重复：${key}`)
    seen.add(key)
    const role = oneOf(entry.role, MESSAGE_ROLES, `fixture.initialSession.messages[${index}].role`)
    const content = text(entry.content, `fixture.initialSession.messages[${index}].content`)
    const atMs = instant(entry.at, `fixture.initialSession.messages[${index}].at`)
    if (atMs < lastAt) fail(`fixture 消息时间倒退：${key}`)
    lastAt = atMs
    messages.push({ key, role, content, atMs })
  })
  return { id, title, messages }
}

function parseMemory(raw: unknown, sessionId: string, messageByKey: Map<string, DirectSeedMessage>): DirectSeedMemory[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail("fixture.initialMemory 必须是数组")
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    if (!isRecord(entry)) fail(`fixture.initialMemory[${index}] 不是对象`)
    const key = text(entry.id, `fixture.initialMemory[${index}].id`)
    if (seen.has(key)) fail(`fixture 记忆 id 重复：${key}`)
    seen.add(key)
    const kind = oneOf(entry.kind, MEMORY_KINDS, `fixture.initialMemory[${index}].kind`)
    const scope = oneOf(entry.scope, MEMORY_SCOPES, `fixture.initialMemory[${index}].scope`)
    const origin = text(entry.origin, `fixture.initialMemory[${index}].origin`)
    if (origin !== "user") fail(`direct-seed 只装载用户口述事实：${key} 的 origin=${origin}`)
    const content = text(entry.content, `fixture.initialMemory[${index}].content`)
    if (!isRecord(entry.source)) fail(`fixture.initialMemory[${index}].source 缺失`)
    const sourceSession = text(entry.source.sessionId, `fixture.initialMemory[${index}].source.sessionId`)
    if (sourceSession !== sessionId) fail(`fixture 记忆 ${key} 的来源会话不是初始会话`)
    const sourceMessageKey = text(entry.source.messageId, `fixture.initialMemory[${index}].source.messageId`)
    const sourceMessage = messageByKey.get(sourceMessageKey)
    if (!sourceMessage) fail(`fixture 记忆 ${key} 引用了不存在的消息 ${sourceMessageKey}`)
    if (sourceMessage.role !== "user") fail(`fixture 记忆 ${key} 只能以用户消息为来源`)
    const validFromMs = optionalInstant(entry.validFrom, `fixture.initialMemory[${index}].validFrom`) ?? sourceMessage.atMs
    const validUntilMs = optionalInstant(entry.validUntil, `fixture.initialMemory[${index}].validUntil`)
    if (validUntilMs !== null && validUntilMs <= validFromMs) {
      fail(`fixture 记忆 ${key} 的 validUntil 必须晚于 validFrom`)
    }
    return {
      key,
      kind,
      scope,
      ...(scope === "session" ? { scopeId: sessionId } : {}),
      content,
      validFromMs,
      validUntilMs,
      sourceMessageKey,
    }
  })
}

/**
 * 把执行器写下的 seed.json 校验成装载计划。
 * `fixtureHash` 由数据集工具计算并随 seed.json 固化，这里只校验形状。
 */
export function buildDirectSeedPlan(raw: unknown): DirectSeedPlan {
  if (!isRecord(raw)) fail("seed.json 不是对象")
  if (raw.schemaVersion !== DIRECT_SEED_FILE_SCHEMA_VERSION) {
    fail(`seed.json schemaVersion=${String(raw.schemaVersion)} 不受支持`)
  }
  const fixtureId = text(raw.fixtureId, "seed.json.fixtureId")
  const fixtureHash = text(raw.fixtureHash, "seed.json.fixtureHash")
  if (!/^sha256:[0-9a-f]{64}$/.test(fixtureHash)) fail("seed.json.fixtureHash 不是 sha256:<hex>")
  if (!isRecord(raw.card)) fail("seed.json.card 缺失")
  const cardName = text(raw.card.name, "seed.json.card.name")
  const cardId = text(raw.card.activeId, "seed.json.card.activeId")
  if (!isRecord(raw.profile)) fail("seed.json.profile 缺失")
  const profileId = raw.profile.activeId === null ? null : text(raw.profile.activeId, "seed.json.profile.activeId")
  if (!isRecord(raw.fixture)) fail("seed.json.fixture 缺失")
  const fixture = raw.fixture
  if (fixture.schemaVersion !== DIRECT_SEED_FIXTURE_SCHEMA_VERSION) {
    fail(`fixture schemaVersion=${String(fixture.schemaVersion)} 不受支持`)
  }
  if (text(fixture.fixtureId, "fixture.fixtureId") !== fixtureId) fail("fixture.fixtureId 与 seed.json 不一致")
  if (text(fixture.card, "fixture.card") !== cardName) fail("fixture.card 与 seed.json.card.name 不一致")
  const fixtureProfile = text(fixture.profile, "fixture.profile")
  if ((fixtureProfile === "default") !== (profileId === null)) {
    fail("fixture.profile=default 时 seed.json.profile.activeId 必须为 null，反之必须给具体 id")
  }
  if (!isRecord(fixture.loading) || fixture.loading.mode !== "direct-seed") {
    fail("fixture.loading.mode 必须是 direct-seed")
  }
  const clockMs = instant(fixture.clock, "fixture.clock")
  const session = parseSession(fixture.initialSession)
  const messages = session.messages
  if (clockMs < messages[messages.length - 1]!.atMs) fail("fixture.clock 早于最后一条 fixture 消息")

  const messageByKey = new Map(messages.map(message => [message.key, message]))
  const memory = parseMemory(fixture.initialMemory, session.id, messageByKey)
  // 初始可信来源 = 全部用户消息（与产品整理看到的水位口径一致）；助手台词只进会话正文。
  const sourceMessages: DirectSeedSourceMessage[] = messages
    .map((message, index) => ({ message, seq: index + 1 }))
    .filter(({ message }) => message.role === "user")
    .map(({ message, seq }) => ({ key: message.key, seq, content: message.content, atMs: message.atMs }))

  return {
    fixtureId,
    fixtureHash,
    clockMs,
    card: { name: cardName, activeId: cardId },
    profileId,
    session,
    memory,
    sourceMessages,
  }
}
