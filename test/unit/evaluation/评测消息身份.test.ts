// 评测消息操作身份 — 驱动消息必须绑定 operation、trial、会话与当前宿主代际。
import { describe, expect, it } from "vitest"
import {
  MESSAGE_OPERATION_FIELDS,
  assertMessageOperation,
} from "@/services/sim/message-operation"

const TRIALS = [{ caseId: "case-a", trialId: "trial-1", status: "started" }]
const CONTEXT = { generation: "gen-1", sessionId: "session-1", trials: TRIALS }
const OPERATION = {
  operationId: "op-1",
  caseId: "case-a",
  trialId: "trial-1",
  sessionId: "session-1",
  generation: "gen-1",
  stepId: "say",
}

describe("评测消息操作身份", () => {
  it("匹配当前会话、代际与在跑 trial 时返回规范身份", () => {
    expect(MESSAGE_OPERATION_FIELDS).toEqual([
      "operationId", "caseId", "trialId", "sessionId", "generation", "stepId",
    ])
    expect(assertMessageOperation(OPERATION, CONTEXT)).toEqual(OPERATION)
  })

  it("缺少字段、空值或未知字段直接拒绝", () => {
    expect(() => assertMessageOperation({ ...OPERATION, operationId: " " }, CONTEXT))
      .toThrow(/operationId/)
    expect(() => assertMessageOperation({ ...OPERATION, extra: true }, CONTEXT))
      .toThrow(/未知字段/)
  })

  it("代际、会话或 trial 不匹配时拒绝，不回落当前会话", () => {
    expect(() => assertMessageOperation({ ...OPERATION, generation: "gen-old" }, CONTEXT))
      .toThrow(/代际/)
    expect(() => assertMessageOperation({ ...OPERATION, sessionId: "session-other" }, CONTEXT))
      .toThrow(/会话/)
    expect(() => assertMessageOperation({ ...OPERATION, caseId: "case-other" }, CONTEXT))
      .toThrow(/trial/)
    expect(() => assertMessageOperation(
      { ...OPERATION, trialId: "trial-ended" },
      { ...CONTEXT, trials: [{ caseId: "case-a", trialId: "trial-ended", status: "completed" }] },
    )).toThrow(/trial/)
  })
})
