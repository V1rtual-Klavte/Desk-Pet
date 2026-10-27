import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

export interface ScheduledJob {
  id: string
  nextAt: (now: number) => number | null
  run: (now: number) => Promise<void>
  cancel?: () => void
}

/** 关停只能等这么久：宿主 flush 期限是 5s，超过期限的作业如实记为未收敛。 */
export const SCHEDULER_STOP_TIMEOUT_MS = 2_000

export interface SchedulerStopReport {
  canceled: number
  drained: boolean
  abandoned: string[]
}
const log = createLogger("Scheduler")
/** One process timer. Domain owners retain their own eligibility, cancellation and budgets. */
export class SchedulerKernel {
  private jobs = new Map<string, { job: ScheduledJob; due: number | null; running?: Promise<void> }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private inFlight = new Set<Promise<void>>()
  constructor(private readonly clock = () => Date.now()) {}
  register(job: ScheduledJob): () => void {
    if (this.stopped) throw new Error("scheduler_stopped")
    if (this.jobs.has(job.id)) throw new Error(`scheduler_duplicate_job:${job.id}`)
    const state = { job, due: job.nextAt(this.clock()) } as { job: ScheduledJob; due: number | null; running?: Promise<void> }
    this.jobs.set(job.id, state)
    this.arm()
    return () => {
      if (this.jobs.get(job.id) !== state) return
      job.cancel?.(); this.jobs.delete(job.id); this.arm()
    }
  }
  wake(id: string): void {
    const state = this.jobs.get(id)
    if (!state || this.stopped) return
    state.due = this.clock()
    this.arm()
  }
  refresh(id: string): void {
    const state = this.jobs.get(id)
    if (state) state.due = state.job.nextAt(this.clock())
    this.arm()
  }
  refreshAll(): void {
    for (const state of this.jobs.values()) state.due = state.job.nextAt(this.clock())
    this.arm()
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.stopped) return
    const due = [...this.jobs.values()].filter(s => !s.running && s.due !== null).map(s => s.due!)
    if (!due.length) return
    // The bounded clock check detects suspend/resume and wall-clock changes without a polling timer per job.
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain() }, Math.max(1, Math.min(60_000, Math.min(...due) - this.clock())))
    this.timer.unref?.()
  }
  async drain(): Promise<void> {
    if (this.stopped) return
    const now = this.clock()
    const runs: Promise<void>[] = []
    for (const state of this.jobs.values()) {
      if (state.running || state.due === null || state.due > now) continue
      state.due = null
      const run = Promise.resolve().then(() => state.job.run(now))
        .catch(error => log.warn(`调度作业失败:${state.job.id}`, formatError(error)))
        .finally(() => {
          this.inFlight.delete(run)
          state.running = undefined
          if (this.jobs.get(state.job.id) === state && !this.stopped) {
            // An event received during a run is coalesced into one subsequent run.
            state.due ??= state.job.nextAt(this.clock())
          }
          this.arm()
        })
      state.running = run
      this.inFlight.add(run)
      runs.push(run)
    }
    this.arm()
    await Promise.all(runs)
  }
  async stop({ timeoutMs = SCHEDULER_STOP_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SchedulerStopReport> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    let canceled = 0
    for (const state of this.jobs.values()) {
      if (!state.job.cancel) continue
      state.job.cancel()
      canceled += 1
    }
    const pending = [...this.inFlight]
    // 卡死的作业不能拖住整个退出序列：期限内没排空就如实上报，由调用方计入未完成。
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
      timer.unref?.()
    })
    const drained = pending.length === 0
      ? true
      : await Promise.race([Promise.all(pending).then(() => "drained" as const), timeout]) === "drained"
    if (timer) clearTimeout(timer)
    const abandoned = drained
      ? []
      : [...this.jobs.values()].filter(state => state.running !== undefined).map(state => state.job.id).sort()
    this.jobs.clear()
    return { canceled, drained, abandoned }
  }
}
export const internalScheduler = new SchedulerKernel()
