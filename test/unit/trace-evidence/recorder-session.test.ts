import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createRuntimeTraceContext, publishRuntimeTrace } from "@/services/engine/runtime"
import { createSimTraceRecorder } from "@/services/sim/trace-recorder"

/** 采集只按显式绑定的会话兜底归属；未绑定的会话事件仍必须是 orphan。 */
async function captureProactive(bindSession: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "desk-pet-recorder-session-"))
  const recorder = createSimTraceRecorder({ collectEvents: false })
  let finished = false
  try {
    await recorder.startCapture({
      attemptDir: dir,
      tracePath: join(dir, "trace.jsonl"),
      expectedTrials: [{ caseId: "scene-a", trialId: "trial-1" }],
    })
    await recorder.beginTrial("scene-a", "trial-1")
    if (bindSession) recorder.bindSession("session-1")
    publishRuntimeTrace(createRuntimeTraceContext("session-1"), "proactive_tick", { status: "started" })
    await recorder.endTrial("scene-a", "trial-1")
    const result = await recorder.finishCapture()
    finished = true
    const records = readFileSync(join(dir, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .flatMap(line => JSON.parse(line).chunk.events)
    return { result, record: records.find((entry: { event?: { kind?: string } }) => entry.event?.kind === "proactive_tick") }
  } finally {
    if (finished) recorder.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("trace recorder 会话归属", () => {
  it("手工触发会话显式绑定后 proactive 事件归到当前 trial，未绑定仍是 orphan", async () => {
    const unbound = await captureProactive(false)
    expect(unbound.record?.orphan).toBe(true)
    expect(unbound.result.orphanCount).toBe(1)

    const bound = await captureProactive(true)
    expect(bound.record).toMatchObject({ orphan: false, sceneId: "scene-a", trialId: "trial-1" })
    expect(bound.result.orphanCount).toBe(0)
  })
})
