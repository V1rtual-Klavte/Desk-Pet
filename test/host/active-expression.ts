import { captureProactiveOwner, sendActiveMessage } from "@/services/agent/runner"
import type { ActiveMessageRequest, ActiveMessageResult } from "@/services/agent/types"

/** Exercise the structured expression port without bypassing the native Harness request. */
export async function runTestActiveExpression(
  text: string,
  overrides: Partial<Pick<ActiveMessageRequest, "beforeGenerate" | "isCurrent" | "settle">> = {},
): Promise<ActiveMessageResult> {
  const owner = await captureProactiveOwner()
  if (!owner) return { status: "skipped", reason: "no_session" }
  const requestId = `test-active-${crypto.randomUUID()}`
  return sendActiveMessage({
    expectsReply: true,
    text,
    owner,
    requestId,
    attemptId: `attempt-${crypto.randomUUID()}`,
    ruleId: "test-active-expression",
    intent: "核对主动表达的提交路径",
    sourceRefs: [],
    memoryTargets: [],
    occurrenceIds: [],
    beforeGenerate: overrides.beforeGenerate ?? (async () => true),
    isCurrent: overrides.isCurrent ?? (async () => true),
    settle: overrides.settle ?? (async () => "committed"),
  })
}
