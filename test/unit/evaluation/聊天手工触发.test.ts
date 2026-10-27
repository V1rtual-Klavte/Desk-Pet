import { describe, expect, it } from "vitest"
import type { ManualTriggerDeps } from "@/services/sim/manual-trigger"
import { isManualTriggerHostMethod, MANUAL_TRIGGER_HOST_METHODS, runManualTrigger } from "@/services/sim/manual-trigger"
import {
  DRIVER_HOST_METHOD_VALUES,
  MANUAL_TRIGGER_HOST_METHODS as DATASET_MANUAL_TRIGGER_HOST_METHODS,
} from "../../sim/desk-pet-chat/dataset.mjs"

function deps(overrides: Partial<ManualTriggerDeps> = {}): ManualTriggerDeps {
  return {
    now: () => 1_000,
    tick: async () => undefined,
    readEvents: () => [],
    deliverTask: async () => ({ taskId: "task-1", created: true, delivered: true }),
    ...overrides,
  }
}

describe("评测手工触发", () => {
  it("主动 tick 只收取本次调用产生的 proactive 事件 [chat-manual-trigger]", async () => {
    const events: Array<{ kind: string; payload?: unknown }> = []
    const ticks: number[] = []
    const result = await runManualTrigger("sim_proactive_tick", {}, deps({
      now: () => 1_234,
      tick: async (now) => {
        ticks.push(now)
        events.push(
          { kind: "agent_start" },
          { kind: "proactive_tick", payload: { status: "started" } },
          { kind: "proactive_skipped", payload: { reason: "quiet_time" } },
        )
      },
      readEvents: () => events,
    }))

    expect(ticks).toEqual([1_234])
    expect(result).toMatchObject({
      manualPath: "sim-component",
      trigger: "proactive_tick",
      events: [
        { kind: "proactive_tick", payload: { status: "started" } },
        { kind: "proactive_skipped", payload: { reason: "quiet_time" } },
      ],
    })
  })

  it("任务投递原样返回创建与交付结果 [chat-manual-trigger-task]", async () => {
    const inputs: unknown[] = []
    const delivered = { taskId: "task-1", created: true, delivered: true }
    const result = await runManualTrigger("sim_task_deliver", { kind: "reminder", text: "起来走走" }, deps({
      deliverTask: async (input) => {
        inputs.push(input)
        return delivered
      },
    }))

    expect(inputs).toEqual([{ kind: "reminder", text: "起来走走" }])
    expect(result).toMatchObject({
      manualPath: "sim-component",
      trigger: "task_delivery",
      task: delivered,
    })
  })

  it("拒绝未登记方法、主动参数与非法任务参数", async () => {
    expect(isManualTriggerHostMethod("sim_proactive_tick")).toBe(true)
    expect(isManualTriggerHostMethod("sim_task_deliver")).toBe(true)
    expect(isManualTriggerHostMethod("chat_new_session")).toBe(false)

    await expect(runManualTrigger("chat_new_session", {}, deps())).rejects.toThrow(/未登记/)
    await expect(runManualTrigger("sim_proactive_tick", { force: true }, deps())).rejects.toThrow(/不接受参数/)
    await expect(runManualTrigger("sim_task_deliver", { kind: "other" }, deps())).rejects.toThrow(/kind/)
    await expect(runManualTrigger("sim_task_deliver", { text: " " }, deps())).rejects.toThrow(/text/)
    await expect(runManualTrigger("sim_task_deliver", {
      work: { goal: "", inputs: [], capabilities: [], output: "", completion: "" },
    }, deps())).rejects.toThrow(/work/)
  })

  it("产品与数据集的手工触发方法注册表保持一致 [chat-manual-trigger-registry]", () => {
    expect([...MANUAL_TRIGGER_HOST_METHODS]).toEqual([...DATASET_MANUAL_TRIGGER_HOST_METHODS])
    for (const method of MANUAL_TRIGGER_HOST_METHODS) {
      expect(DRIVER_HOST_METHOD_VALUES).toContain(method)
    }
  })
})
