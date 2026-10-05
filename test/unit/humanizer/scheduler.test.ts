import { describe, expect, it } from "vitest"
import { HumanizerScheduler, type HumanizerClock } from "@/services/humanizer/scheduler"

class FakeClock implements HumanizerClock {
  time = 0
  private nextId = 0
  private timers = new Map<number, { at: number; callback: () => void }>()

  now(): number { return this.time }
  random(): number { return 0.5 }
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = ++this.nextId
    this.timers.set(id, { at: this.time + delayMs, callback })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer as unknown as number) }
  advance(ms: number): void {
    const target = this.time + ms
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.time = due[1].at
      this.timers.delete(due[0])
      due[1].callback()
    }
    this.time = target
  }
}

describe("humanizer scheduler", () => {
  it("reveals casual bubbles in order and then removes transient state [humanizer-scheduler-casual]", () => {
    const clock = new FakeClock()
    const scheduler = new HumanizerScheduler(clock)
    const states: number[] = []
    scheduler.subscribe(state => states.push(state.revealed))
    scheduler.enqueueCommitted({ sessionId: "s1", runGeneration: 2, messageId: "m1", parts: ["hello", "world"], isActiveMessage: false })
    expect(scheduler.getRevealState("s1", "m1")?.revealed).toBe(0)
    clock.advance(900)
    expect(scheduler.getRevealState("s1", "m1")?.revealed).toBe(1)
    expect(scheduler.getRevealState("s1", "m1")?.typing).toBe(false)
    clock.advance(1500)
    expect(states).toContain(2)
    expect(states[states.length - 1]).toBe(2)
    expect(scheduler.getRevealState("s1", "m1")).toBeUndefined()
  })

  it("reveals every remaining part immediately when a run is cancelled [humanizer-scheduler-cancel]", () => {
    const clock = new FakeClock()
    const scheduler = new HumanizerScheduler(clock)
    scheduler.enqueueCommitted({ sessionId: "s1", runGeneration: 3, messageId: "m2", parts: ["a", "b", "c"], isActiveMessage: false })
    scheduler.cancelSession("s1", 3)
    expect(scheduler.getRevealState("s1", "m2")).toBeUndefined()
    clock.advance(10_000)
    expect(scheduler.getRevealState("s1", "m2")).toBeUndefined()
  })

  it("shows the first proactive bubble immediately [humanizer-scheduler-active-first]", () => {
    const clock = new FakeClock()
    const scheduler = new HumanizerScheduler(clock)
    scheduler.enqueueCommitted({ sessionId: "s1", runGeneration: 4, messageId: "m3", parts: ["first", "second"], isActiveMessage: true })
    expect(scheduler.getRevealState("s1", "m3")?.revealed).toBe(1)
  })

  it("calls the titlebar release hook when the first casual bubble appears [humanizer-scheduler-titlebar]", () => {
    const clock = new FakeClock()
    const scheduler = new HumanizerScheduler(clock)
    let released = 0
    scheduler.enqueueCommitted({
      sessionId: "s1", runGeneration: 5, messageId: "m4", parts: ["one", "two"],
      isActiveMessage: false, onFirstReveal: () => { released++ }
    })
    expect(released).toBe(0)
    clock.advance(900)
    expect(released).toBe(1)
  })
})
