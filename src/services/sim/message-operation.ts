// ==========================================
// 评测消息操作身份 — 驱动消息必须绑定本步 operation、trial、会话与宿主代际
// ==========================================
//
// 只做纯校验：控制通道在发消息前用它核对驱动声明的身份，不推断「大概是这次运行」。
// 本模块不 import 产品服务，L2 可直接钉住协议字段与拒绝分支。

export const MESSAGE_OPERATION_FIELDS = Object.freeze([
  "operationId",
  "caseId",
  "trialId",
  "sessionId",
  "generation",
  "stepId",
] as const)

export interface MessageOperation {
  operationId: string
  caseId: string
  trialId: string
  sessionId: string
  generation: string
  stepId: string
}

export interface MessageOperationContext {
  generation: string
  sessionId: string
  trials: ReadonlyArray<{ caseId: string; trialId: string; status: string }>
}

function textField(raw: Record<string, unknown>, field: string): string {
  const value = raw[field]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`评测消息 operation 缺少字段 ${field}`)
  }
  return value
}

export function assertMessageOperation(raw: unknown, context: MessageOperationContext): MessageOperation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("评测消息 operation 不是对象")
  }
  const record = raw as Record<string, unknown>
  const extra = Object.keys(record).filter(key => !(MESSAGE_OPERATION_FIELDS as readonly string[]).includes(key))
  if (extra.length) throw new Error(`评测消息 operation 含未知字段：${extra.join(", ")}`)

  const operation: MessageOperation = {
    operationId: textField(record, "operationId"),
    caseId: textField(record, "caseId"),
    trialId: textField(record, "trialId"),
    sessionId: textField(record, "sessionId"),
    generation: textField(record, "generation"),
    stepId: textField(record, "stepId"),
  }
  if (operation.generation !== context.generation) {
    throw new Error(`评测消息 operation 的代际与当前宿主不一致：${operation.generation}`)
  }
  if (operation.sessionId !== context.sessionId) {
    throw new Error(`评测消息 operation 的会话与当前活跃会话不一致：${operation.sessionId}`)
  }
  const trial = context.trials.find(candidate =>
    candidate.caseId === operation.caseId
    && candidate.trialId === operation.trialId
    && candidate.status === "started")
  if (!trial) {
    throw new Error(`评测消息 operation 不属于当前在跑的 trial：${operation.caseId}/${operation.trialId}`)
  }
  return operation
}
