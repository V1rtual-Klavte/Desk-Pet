/**
 * 评测手工触发：驱动直接调用主动 tick 与任务投递的组件入口。
 *
 * 这不是自然受理、调度或实际 UI 显示的证据；结果固定带 `manualPath=sim-component`，
 * 让驱动、报告与判分能识别这条捷径。参数只接受登记的字段，非法输入在产生副作用前拒绝。
 */
import type { SimTaskOptions, SimTaskResult } from "./loop"

export const MANUAL_TRIGGER_HOST_METHODS = ["sim_proactive_tick", "sim_task_deliver"] as const
export type ManualTriggerHostMethod = (typeof MANUAL_TRIGGER_HOST_METHODS)[number]

export type ManualTriggerTaskInput = SimTaskOptions

export interface ManualTriggerEventSource {
  kind: string
  payload?: unknown
}

export interface ManualTriggerDeps {
  now: () => number
  tick: (now: number) => Promise<unknown>
  readEvents: () => readonly ManualTriggerEventSource[]
  deliverTask: (input: ManualTriggerTaskInput) => Promise<SimTaskResult>
}

export interface ManualProactiveResult {
  manualPath: "sim-component"
  trigger: "proactive_tick"
  events: Array<{ kind: string; payload?: unknown }>
}

export interface ManualTaskResult {
  manualPath: "sim-component"
  trigger: "task_delivery"
  task: SimTaskResult
}

export type ManualTriggerResult = ManualProactiveResult | ManualTaskResult

const PROACTIVE_METHOD: ManualTriggerHostMethod = "sim_proactive_tick"
const TASK_METHOD: ManualTriggerHostMethod = "sim_task_deliver"
const TASK_INPUT_KEYS = ["kind", "text", "work"] as const
const WORK_KEYS = ["goal", "inputs", "capabilities", "output", "completion"] as const

export function isManualTriggerHostMethod(method: string): method is ManualTriggerHostMethod {
  return (MANUAL_TRIGGER_HOST_METHODS as readonly string[]).includes(method)
}

export function runManualTrigger(
  method: "sim_proactive_tick",
  args: unknown,
  deps: ManualTriggerDeps,
): Promise<ManualProactiveResult>
export function runManualTrigger(
  method: "sim_task_deliver",
  args: unknown,
  deps: ManualTriggerDeps,
): Promise<ManualTaskResult>
export function runManualTrigger(
  method: string,
  args: unknown,
  deps: ManualTriggerDeps,
): Promise<ManualTriggerResult>
export async function runManualTrigger(
  method: string,
  args: unknown,
  deps: ManualTriggerDeps,
): Promise<ManualTriggerResult> {
  if (!isManualTriggerHostMethod(method)) throw new Error(`未登记的手工触发方法：${method}`)
  if (!isRecord(args)) throw new Error("手工触发参数必须是对象")
  if (method === PROACTIVE_METHOD) {
    if (Object.keys(args).length > 0) throw new Error("sim_proactive_tick 不接受参数")
    const before = deps.readEvents().length
    await deps.tick(deps.now())
    const events = deps.readEvents()
      .slice(before)
      .filter(event => event.kind.startsWith("proactive_"))
      .map(event => ({
        kind: event.kind,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      }))
    return { manualPath: "sim-component", trigger: "proactive_tick", events }
  }
  const input = readTaskInput(args)
  const task = await deps.deliverTask(input)
  return { manualPath: "sim-component", trigger: "task_delivery", task }
}

function readTaskInput(args: Record<string, unknown>): ManualTriggerTaskInput {
  const extra = Object.keys(args).filter(key => !(TASK_INPUT_KEYS as readonly string[]).includes(key))
  if (extra.length > 0) throw new Error(`sim_task_deliver 含未知参数：${extra.join(", ")}`)
  const { kind, text, work } = args
  if (kind !== undefined && kind !== "reminder" && kind !== "agent_job") {
    throw new Error("sim_task_deliver 的 kind 必须是 reminder / agent_job")
  }
  if (text !== undefined && (typeof text !== "string" || text.trim() === "")) {
    throw new Error("sim_task_deliver 的 text 必须是非空字符串")
  }
  const input: ManualTriggerTaskInput = {}
  if (kind !== undefined) input.kind = kind
  if (text !== undefined) input.text = text
  if (work !== undefined) {
    if (kind !== "agent_job") throw new Error("sim_task_deliver 的 work 只适用于 kind=agent_job")
    input.work = readWork(work)
  }
  return input
}

function readWork(value: unknown): NonNullable<SimTaskOptions["work"]> {
  if (!isRecord(value)) throw new Error("sim_task_deliver 的 work 必须是对象")
  const extra = Object.keys(value).filter(key => !(WORK_KEYS as readonly string[]).includes(key))
  if (extra.length > 0) throw new Error(`sim_task_deliver 的 work 含未知字段：${extra.join(", ")}`)
  const goal = readText(value.goal, "work.goal")
  const output = readText(value.output, "work.output")
  const completion = readText(value.completion, "work.completion")
  const inputs = readStrings(value.inputs, "work.inputs")
  const capabilities = readStrings(value.capabilities, "work.capabilities")
  return { goal, inputs, capabilities, output, completion }
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`sim_task_deliver 的 ${label} 必须是非空字符串`)
  }
  return value
}

function readStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`sim_task_deliver 的 ${label} 必须是字符串数组`)
  }
  return [...value]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
