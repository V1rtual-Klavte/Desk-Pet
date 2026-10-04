import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

const log = createLogger("Humanizer")

export const HUMANIZER_TIMING = {
  perCharacterMs: 220,
  jitterMin: 0.7,
  jitterMax: 1.3,
  minPartDelayMs: 400,
  maxPartDelayMs: 6000,
  shortPartMaxCharacters: 4,
  shortPartMaxDelayMs: 1200,
  leadInMinMs: 300,
  leadInMaxMs: 1500,
  slowGenerationThresholdMs: 3000,
  slowLeadInMinMs: 200,
  slowLeadInMaxMs: 600,
  typingMinimumMs: 400,
} as const

export interface HumanizerRevealState {
  sessionId: string
  runGeneration: number
  messageId: string
  revealed: number
  partCount: number
  typing: boolean
  /** Timing origin is kept only while this ephemeral reveal state is alive. */
  typingStartedAt: number
}

export interface EnqueueCommittedHumanizedMessage {
  sessionId: string
  runGeneration: number
  messageId: string
  parts: readonly string[]
  /** True for proactive messages; their first bubble aligns with the notification sound. */
  isActiveMessage: boolean
  /** False means the session is not currently visible; it must render fully on next open. */
  sessionIsActive?: boolean
  generationStartedAt?: number
  /** Called when the first bubble is visible so the runtime can release its typing titlebar owner. */
  onFirstReveal?: () => void
}

export interface HumanizerClock {
  now(): number
  random(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

const defaultClock: HumanizerClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
}

function stateKey(sessionId: string, runGeneration: number, messageId: string): string {
  return `${sessionId}\u0000${runGeneration}\u0000${messageId}`
}

/** Transient reveal scheduler. It stores presentation progress only, never message content. */
export class HumanizerScheduler {
  private readonly states = new Map<string, HumanizerRevealState>()
  private readonly revealTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<(state: HumanizerRevealState) => void>()
  private readonly firstRevealCallbacks = new Map<string, () => void>()
  private defaultFirstRevealHandler?: (state: HumanizerRevealState) => void

  constructor(private readonly clock: HumanizerClock = defaultClock) {}

  subscribe(listener: (state: HumanizerRevealState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setFirstRevealHandler(handler: ((state: HumanizerRevealState) => void) | undefined): void {
    this.defaultFirstRevealHandler = handler
  }

  getRevealState(sessionId: string, messageId: string): HumanizerRevealState | undefined {
    let latest: HumanizerRevealState | undefined
    for (const state of this.states.values()) {
      if (state.sessionId === sessionId && state.messageId === messageId
        && (!latest || state.runGeneration > latest.runGeneration)) latest = state
    }
    return latest ? { ...latest } : undefined
  }

  enqueueCommitted(input: EnqueueCommittedHumanizedMessage): void {
    const parts = input.parts
    if (!parts.length || input.sessionIsActive === false) return
    const key = stateKey(input.sessionId, input.runGeneration, input.messageId)
    this.clearTimers(key)
    const now = this.clock.now()
    const elapsed = input.generationStartedAt === undefined ? 0 : Math.max(0, now - input.generationStartedAt)
    const revealImmediately = input.isActiveMessage
    const state: HumanizerRevealState = {
      sessionId: input.sessionId,
      runGeneration: input.runGeneration,
      messageId: input.messageId,
      revealed: revealImmediately ? 1 : 0,
      partCount: parts.length,
      typing: true,
      typingStartedAt: input.generationStartedAt ?? now,
    }
    this.states.set(key, state)
    if (input.onFirstReveal) this.firstRevealCallbacks.set(key, input.onFirstReveal)
    this.publish(state)
    if (revealImmediately) {
      this.notifyFirstReveal(key, state)
      this.endTypingAfterMinimum(key)
      if (state.revealed < state.partCount) this.scheduleNext(key, parts, 1)
      return
    }
    if (state.revealed >= state.partCount) {
      this.notifyFirstReveal(key, state)
      this.endTypingAfterMinimum(key)
      return
    }
    const lead = elapsed >= HUMANIZER_TIMING.slowGenerationThresholdMs
      ? this.randomBetween(HUMANIZER_TIMING.slowLeadInMinMs, HUMANIZER_TIMING.slowLeadInMaxMs)
      : this.randomBetween(HUMANIZER_TIMING.leadInMinMs, HUMANIZER_TIMING.leadInMaxMs)
    this.revealTimers.set(key, this.clock.setTimeout(() => {
      this.revealTimers.delete(key)
      this.revealOne(key, parts, 0)
    }, lead))
  }

  /** Cancel timed reveals and expose all committed parts immediately. */
  revealAll(sessionId?: string, runGeneration?: number): void {
    for (const [key, state] of this.states) {
      if (sessionId !== undefined && state.sessionId !== sessionId) continue
      if (runGeneration !== undefined && state.runGeneration !== runGeneration) continue
      this.clearTimers(key)
      if (state.revealed !== state.partCount || state.typing) {
        const completed = { ...state, revealed: state.partCount, typing: false }
        if (state.revealed === 0) this.notifyFirstReveal(key, completed)
        this.publish(completed)
      }
      this.states.delete(key)
      this.firstRevealCallbacks.delete(key)
    }
  }

  cancelSession(sessionId: string, runGeneration?: number): void {
    this.revealAll(sessionId, runGeneration)
  }

  cancelAll(): void {
    this.revealAll()
  }

  resetForTest(): void {
    this.cancelAll()
    this.listeners.clear()
  }

  private revealOne(key: string, parts: readonly string[], index: number): void {
    this.revealTimers.delete(key)
    const current = this.states.get(key)
    if (!current) return
    const next = { ...current, revealed: Math.min(current.partCount, index + 1) }
    this.states.set(key, next)
    if (index === 0) this.notifyFirstReveal(key, next)
    this.publish(next)
    if (next.revealed === 1 && next.typing) this.endTypingAfterMinimum(key)
    if (next.revealed < next.partCount) this.scheduleNext(key, parts, next.revealed)
    else if (!next.typing) {
      this.states.delete(key)
      this.firstRevealCallbacks.delete(key)
    }
  }

  private scheduleNext(key: string, parts: readonly string[], previousIndex: number): void {
    const previous = parts[previousIndex - 1] ?? ""
    const length = [...previous].length
    const jitter = this.randomBetween(HUMANIZER_TIMING.jitterMin, HUMANIZER_TIMING.jitterMax)
    let delay = Math.max(HUMANIZER_TIMING.minPartDelayMs,
      Math.min(HUMANIZER_TIMING.maxPartDelayMs, length * HUMANIZER_TIMING.perCharacterMs * jitter))
    if (length <= HUMANIZER_TIMING.shortPartMaxCharacters) delay = Math.min(delay, HUMANIZER_TIMING.shortPartMaxDelayMs)
    this.revealTimers.set(key, this.clock.setTimeout(() => {
      this.revealTimers.delete(key)
      this.revealOne(key, parts, previousIndex)
    }, delay))
  }

  private endTypingAfterMinimum(key: string): void {
    const currentState = this.states.get(key)
    if (!currentState?.typing) return
    const elapsed = this.clock.now() - currentState.typingStartedAt
    const wait = Math.max(0, HUMANIZER_TIMING.typingMinimumMs - elapsed)
    if (wait === 0) {
      const current = this.states.get(key)
      if (current?.typing) {
        const completed = { ...current, typing: false }
        this.states.set(key, completed)
        this.publish(completed)
        if (completed.revealed >= completed.partCount) {
          this.states.delete(key)
          this.firstRevealCallbacks.delete(key)
        }
      }
      return
    }
    const pendingTyping = this.typingTimers.get(key)
    if (pendingTyping !== undefined) this.clock.clearTimeout(pendingTyping)
    this.typingTimers.delete(key)
    this.typingTimers.set(key, this.clock.setTimeout(() => {
      this.typingTimers.delete(key)
      const current = this.states.get(key)
      if (current?.typing) {
        const completed = { ...current, typing: false }
        this.states.set(key, completed)
        this.publish(completed)
        if (completed.revealed >= completed.partCount) {
          this.states.delete(key)
          this.firstRevealCallbacks.delete(key)
        }
      }
    }, wait))
  }

  private clearTimers(key: string): void {
    const revealTimer = this.revealTimers.get(key)
    if (revealTimer !== undefined) this.clock.clearTimeout(revealTimer)
    this.revealTimers.delete(key)
    const typingTimer = this.typingTimers.get(key)
    if (typingTimer !== undefined) this.clock.clearTimeout(typingTimer)
    this.typingTimers.delete(key)
  }

  private randomBetween(min: number, max: number): number {
    return min + this.clock.random() * (max - min)
  }

  private publish(state: HumanizerRevealState): void {
    for (const listener of this.listeners) {
      try { listener({ ...state }) } catch (error) { log.error("揭示状态订阅者失败:", formatError(error)) }
    }
  }

  private notifyFirstReveal(key: string, state: HumanizerRevealState): void {
    const callback = this.firstRevealCallbacks.get(key)
    this.firstRevealCallbacks.delete(key)
    try { callback?.() } catch (error) { log.error("首泡揭示回调失败:", formatError(error)) }
    try { this.defaultFirstRevealHandler?.({ ...state }) } catch (error) { log.error("首泡状态清理失败:", formatError(error)) }
  }
}

export const humanizerScheduler = new HumanizerScheduler()

export const setFirstRevealHandler = (handler: ((state: HumanizerRevealState) => void) | undefined): void => humanizerScheduler.setFirstRevealHandler(handler)

export const enqueueCommitted = (input: EnqueueCommittedHumanizedMessage): void => humanizerScheduler.enqueueCommitted(input)
export const cancelSession = (sessionId: string, runGeneration?: number): void => humanizerScheduler.cancelSession(sessionId, runGeneration)
export const revealAll = (sessionId?: string, runGeneration?: number): void => humanizerScheduler.revealAll(sessionId, runGeneration)
export const getRevealState = (sessionId: string, messageId: string): HumanizerRevealState | undefined => humanizerScheduler.getRevealState(sessionId, messageId)
export const subscribe = (listener: (state: HumanizerRevealState) => void): (() => void) => humanizerScheduler.subscribe(listener)
