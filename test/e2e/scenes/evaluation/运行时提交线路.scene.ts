import * as assert from "node:assert/strict"
import type { SceneDef } from "../../types"
import { captureRuntimeTrace } from "../../../host/trace-observer"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { getActiveSessionId } from "@/services/session"
import { readPiSessionEntries } from "@/services/session/repo"

let capture: ReturnType<typeof captureRuntimeTrace> | undefined

const scene: SceneDef = {
  meta: {
    caseId: "trace-production-commit", module: "evaluation", contractId: "eval-01",
    description: "生产入口 trace 身份、模型请求与真实 JSONL 提交证据一致", depth: "deep",
    suite: "regression", entry: "production", tags: ["trace", "boundary"],
  },
  setup: async () => {
    capture?.unsubscribe()
    capture = captureRuntimeTrace()
    installFakeProvider([fakeText("提交线路核验完成")])
  },
  turns: [{
    index: 1, description: "读取原生提交事件并对照真实会话条目", userText: "请回复提交线路核验完成", checks: [{
      type: "traceCommitMatchesDurableEntries",
      run: async ({ output }) => {
        try {
          assert.strictEqual(output.reply, "提交线路核验完成")
          const events = capture!.events
          const ingress = events.filter(event => event.kind === "input_accepted")
          assert.strictEqual(ingress.length, 1)
          assert.ok(ingress[0].requestId)
          const linked = events.filter(event => event.kind === "run_linked")
          assert.strictEqual(linked.length, 1)
          assert.strictEqual(linked[0].runId, ingress[0].runId)
          assert.ok(linked[0].nativeRunId)
          const starts = events.filter(event => event.kind === "provider_request_start")
          const ends = events.filter(event => event.kind === "provider_request_end")
          assert.strictEqual(starts.length, 1)
          assert.strictEqual(ends.length, 1)
          assert.strictEqual(starts[0].runId, ends[0].runId)
          assert.strictEqual(starts[0].spanId, ends[0].spanId)
          assert.ok(ends[0].monotonicMs >= starts[0].monotonicMs)
          const commits = events.filter(event => event.kind === "entry_added" && event.payload.role === "assistant")
          assert.strictEqual(commits.length, 1)
          const entries = await readPiSessionEntries(getActiveSessionId())
          const committed = entries.filter(entry => entry.id === commits[0].entryId)
          assert.strictEqual(committed.length, 1)
          assert.strictEqual(committed[0].type, "message")
          const messageEnd = events.find(event => event.kind === "message_end" && event.payload.role === "assistant")!
          assert.ok(commits[0].sequence > messageEnd.sequence)
          assert.strictEqual(events.filter(event => event.kind === "first_text_generated").length, 1)
          assert.strictEqual(events.filter(event => event.kind === "first_visible_text").length, 0)
        } finally { capture?.unsubscribe() }
      },
    }],
  }],
}
export default scene
