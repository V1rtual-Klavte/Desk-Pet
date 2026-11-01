// ==========================================
// 计划工作单与结构化产出的纯解析/格式化
//
// 只依赖 protocol 的持久类型，不 import planner（planner 反过来依赖本模块），
// 保持 plan 域内单向依赖。解析绝不抛异常：不合法一律返回 `{ ok: false, reason }`，
// 由调用方决定「只修复一次」还是按 partial 兜底。
// ==========================================

import type {
  PlanStepAcceptanceCheck, PlanStepOutcome, PlanStepOutcomeStatus, PlanVerification, PlanVerificationVerdict,
} from "@/services/engine/protocol"

/** 结构型工作单：planner 的 `PlanStep` 在它之上补 `id`。 */
export interface PlanWorkOrder {
  description: string
  role?: string
  /** 必填、非空：每一步的权限面必须显式声明，不允许「缺省放大到全部工具」。 */
  allowedTools: string[]
  dependsOn?: number[]
  /** 需要的输入（依赖步骤用 id 指明）。 */
  inputs: string
  /** 交付物（文件 / 结论 / 检查结果）。 */
  deliverable: string
  /** 可检查的验收条目，一行一条。 */
  acceptance: string
  /** 本步明确不做什么（防跑偏）。 */
  nonGoals?: string
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** 单条字符串上限与数组条数上限：模型输出只做封顶，不静默丢整段语义。 */
const MAX_TEXT_CHARS = 2000
const MAX_ITEMS = 20

const STEP_STATUSES: ReadonlySet<string> = new Set(["complete", "partial", "blocked"])
const VERDICT_STATUSES: ReadonlySet<string> = new Set(["pass", "partial", "fail"])

function truncateText(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : text.slice(0, MAX_TEXT_CHARS)
}

/**
 * 取出 JSON 载荷：优先 ```json 围栏，其次第一个 `{...}` 段（与 planner 既有的
 * 「围栏优先、再取花括号」同口径）。取不到时原样返回，交给 `JSON.parse` 报错。
 */
function extractJsonPayload(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1] ?? ""
  const braced = text.match(/(\{[\s\S]*\})/)
  return braced ? braced[1] ?? "" : text
}

function parseJsonObject(text: string): ParseResult<Record<string, unknown>> {
  const payload = extractJsonPayload(text).trim()
  if (payload === "") return { ok: false, reason: "没有找到 JSON 载荷" }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "JSON 顶层必须是对象" }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** 可选字符串：去空白后为空按缺省处理；超长截断（不因长度判不合法）。 */
function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text === "" ? undefined : truncateText(text)
}

/**
 * 可选字符串数组：缺省返回 undefined；存在但不是数组、或含非字符串项都判不合法
 * （静默丢项会让「证据/缺口」看起来比实际更少）。
 */
function readTextArray(value: unknown, field: string): ParseResult<string[] | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (!Array.isArray(value)) return { ok: false, reason: `${field} 必须是字符串数组` }
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== "string") return { ok: false, reason: `${field} 只能包含字符串` }
    const text = item.trim()
    if (text === "") continue
    items.push(truncateText(text))
    if (items.length >= MAX_ITEMS) break
  }
  return { ok: true, value: items.length > 0 ? items : undefined }
}

function readAcceptance(value: unknown): ParseResult<PlanStepAcceptanceCheck[] | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (!Array.isArray(value)) return { ok: false, reason: "acceptance 必须是验收条目数组" }
  const items: PlanStepAcceptanceCheck[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "acceptance 的每一项必须是 { item, met, note? } 对象" }
    }
    const row = entry as Record<string, unknown>
    const item = readOptionalText(row.item)
    if (item === undefined) return { ok: false, reason: "acceptance 的 item 不能为空" }
    if (typeof row.met !== "boolean") return { ok: false, reason: `验收条目「${item}」的 met 必须是布尔值` }
    if (row.note !== undefined && typeof row.note !== "string") {
      return { ok: false, reason: `验收条目「${item}」的 note 必须是字符串` }
    }
    const note = readOptionalText(row.note)
    items.push({ item, met: row.met, ...(note ? { note } : {}) })
    if (items.length >= MAX_ITEMS) break
  }
  return { ok: true, value: items.length > 0 ? items : undefined }
}

/**
 * 解析步骤的结构化产出。`status = complete` 与缺口/未达成验收互相矛盾：
 * 该组合判不合法（交给调用方做一次只读修复），而不是替模型把 complete 改成 partial。
 */
export function parseStepOutcome(text: string): ParseResult<PlanStepOutcome> {
  const json = parseJsonObject(text)
  if (!json.ok) return json
  const row = json.value

  if (typeof row.status !== "string" || !STEP_STATUSES.has(row.status)) {
    return { ok: false, reason: "status 必须是 complete / partial / blocked 之一" }
  }
  const status = row.status as PlanStepOutcomeStatus
  const summary = readOptionalText(row.summary)
  if (summary === undefined) return { ok: false, reason: "summary 不能为空" }

  const artifacts = readTextArray(row.artifacts, "artifacts")
  if (!artifacts.ok) return artifacts
  const evidence = readTextArray(row.evidence, "evidence")
  if (!evidence.ok) return evidence
  const missing = readTextArray(row.missing, "missing")
  if (!missing.ok) return missing
  const acceptance = readAcceptance(row.acceptance)
  if (!acceptance.ok) return acceptance
  if (row.needs !== undefined && row.needs !== null && typeof row.needs !== "string") {
    return { ok: false, reason: "needs 必须是字符串" }
  }
  const needs = readOptionalText(row.needs)

  if (status === "complete") {
    if (missing.value && missing.value.length > 0) {
      return { ok: false, reason: "status 为 complete 时 missing 必须为空" }
    }
    const unmet = acceptance.value?.filter(check => !check.met) ?? []
    if (unmet.length > 0) {
      return { ok: false, reason: `status 为 complete 时验收不得有未达成项：${unmet.map(check => check.item).join("、")}` }
    }
  }

  return {
    ok: true,
    value: {
      status,
      summary,
      ...(artifacts.value ? { artifacts: artifacts.value } : {}),
      ...(evidence.value ? { evidence: evidence.value } : {}),
      ...(acceptance.value ? { acceptance: acceptance.value } : {}),
      ...(missing.value ? { missing: missing.value } : {}),
      ...(needs ? { needs } : {}),
    },
  }
}

/** 解析计划级核验。`reasons` 可缺省（= 没有补充理由）；`missing`/`drift` 缺省按空处理。 */
export function parsePlanVerification(text: string): ParseResult<PlanVerification> {
  const json = parseJsonObject(text)
  if (!json.ok) return json
  const row = json.value

  if (typeof row.verdict !== "string" || !VERDICT_STATUSES.has(row.verdict)) {
    return { ok: false, reason: "verdict 必须是 pass / partial / fail 之一" }
  }
  const summary = readOptionalText(row.summary)
  if (summary === undefined) return { ok: false, reason: "summary 不能为空" }
  const reasons = readTextArray(row.reasons, "reasons")
  if (!reasons.ok) return reasons
  const missing = readTextArray(row.missing, "missing")
  if (!missing.ok) return missing
  const drift = readTextArray(row.drift, "drift")
  if (!drift.ok) return drift

  return {
    ok: true,
    value: {
      verdict: row.verdict as PlanVerificationVerdict,
      reasons: reasons.value ?? [],
      missing: missing.value ?? [],
      drift: drift.value ?? [],
      summary,
    },
  }
}

/**
 * 步骤子代理的任务块：工作单是这一步唯一的执行面 —— 交付物、验收与「明确不做」
 * 必须与任务说明同处一块，避免子代理把局部探索当成最终目标。
 */
export function formatWorkOrder(step: PlanWorkOrder): string {
  const deps = step.dependsOn?.length ? step.dependsOn.join("、") : "无"
  const lines = [
    "## 本步工作单",
    `任务: ${step.description}`,
    `需要的输入: ${step.inputs}`,
    `交付物: ${step.deliverable}`,
    "验收标准:",
    ...step.acceptance.split(/\r?\n/).map(line => line.trim()).filter(line => line !== "").map(line => `- ${line}`),
  ]
  // 「明确不做」始终出现（缺席写「无」）：子代理不该靠缺段猜这一步有没有限制。
  const nonGoals = (step.nonGoals ?? "").split(/\r?\n/).map(line => line.trim()).filter(line => line !== "")
  lines.push("明确不做:", ...(nonGoals.length > 0 ? nonGoals.map(line => `- ${line}`) : ["- 无"]))
  lines.push(`允许工具: ${step.allowedTools.join("、")}`)
  lines.push(`依赖步骤: ${deps}`)
  return lines.join("\n")
}

/**
 * 子代理正文 → 结构化产出。解析失败按 `partial` 兜底：它确实有产出（正文），
 * 但没有可核对的结论 —— 不冒充 complete，也不把 already-done 的结果说成失败。
 */
export function stepOutcomeFromReply(reply: string, fallbackSummary: string): PlanStepOutcome {
  const parsed = parseStepOutcome(reply)
  if (parsed.ok) return parsed.value
  return {
    status: "partial",
    summary: truncateText(fallbackSummary.trim() || "步骤未返回结构化结果"),
    missing: ["结构化结果不符合契约"],
  }
}

/**
 * 工作单必填字段校验（生成校验与 `propose_plan` 准入共用一份口径）。
 * 返回给模型的中性理由；`at` 是该步在本次提交中的 1 基位置。
 */
export function validateWorkOrderFields(step: PlanWorkOrder, at: number): string | undefined {
  if (!step.description?.trim()) return `第 ${at} 步缺少 description（这一步要做什么）`
  if (!step.inputs?.trim()) return `第 ${at} 步缺少 inputs（需要的输入）`
  if (!step.deliverable?.trim()) return `第 ${at} 步缺少 deliverable（交付物）`
  if (!step.acceptance?.trim()) return `第 ${at} 步缺少 acceptance（可检查的验收条目）`
  if (!Array.isArray(step.allowedTools) || step.allowedTools.length === 0
    || step.allowedTools.some(name => typeof name !== "string" || name.trim() === "")) {
    return `第 ${at} 步没有声明 allowedTools：这一步的权限面必须显式声明`
  }
  return undefined
}
