import type { MessageTaint } from "./types"

const DEFAULT_DEADLINE_MS = 250
const MAX_DEADLINE_MS = 2_000

export type HookMode = "blocking" | "async"

export interface HookEvent {
  hookId: string
  name: string
  sessionId?: string
  turnId?: string
  runId?: string
  taint: MessageTaint
  payload: Record<string, unknown>
}

export interface HookResult {
  decision: "allow" | "block"
  reason?: string
}

export interface HookHandler {
  id: string
  mode: HookMode
  deadlineMs?: number
  handle: (event: HookEvent) => HookResult | void | Promise<HookResult | void>
}

export class HookBus {
  private readonly handlers = new Map<string, HookHandler>()
  private readonly active = new Set<string>()

  register(handler: HookHandler): () => void {
    this.handlers.set(handler.id, handler)
    return () => this.handlers.delete(handler.id)
  }

  unregister(id: string): void {
    this.handlers.delete(id)
  }

  async emit(event: HookEvent): Promise<HookResult> {
    const handlers = [...this.handlers.values()]
    const asyncTasks: Promise<void>[] = []
    for (const handler of handlers) {
      if (handler.mode === "async") {
        asyncTasks.push(this.runAsync(handler, event))
        continue
      }
      const result = await this.runBlocking(handler, event)
      if (result.decision === "block") return result
    }
    void Promise.allSettled(asyncTasks)
    return { decision: "allow" }
  }

  clear(): void {
    this.handlers.clear()
    this.active.clear()
  }

  private async runBlocking(handler: HookHandler, event: HookEvent): Promise<HookResult> {
    if (this.active.has(handler.id)) return { decision: "block", reason: "hook_reentrancy" }
    this.active.add(handler.id)
    try {
      const result = await this.withDeadline(handler, event)
      return result ?? { decision: "allow" }
    } catch (error) {
      return { decision: "block", reason: error instanceof Error ? error.message : "hook_failed" }
    } finally {
      this.active.delete(handler.id)
    }
  }

  private async runAsync(handler: HookHandler, event: HookEvent): Promise<void> {
    if (this.active.has(handler.id)) return
    this.active.add(handler.id)
    try {
      await this.withDeadline(handler, event)
    } catch {
      // Async hooks are observational and must not affect the tool result.
    } finally {
      this.active.delete(handler.id)
    }
  }

  private async withDeadline(handler: HookHandler, event: HookEvent): Promise<HookResult | void> {
    const deadline = Math.min(Math.max(handler.deadlineMs ?? DEFAULT_DEADLINE_MS, 1), MAX_DEADLINE_MS)
    return Promise.race([
      Promise.resolve().then(() => handler.handle(event)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hook_timeout")), deadline)),
    ])
  }
}

export const hookBus = new HookBus()
