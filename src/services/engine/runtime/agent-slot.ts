export interface SlotAgent {
  steer(message: { role: "user"; content: string; timestamp: number }): void
  followUp(message: { role: "user"; content: string; timestamp: number }): void
  abort(): void
  waitForIdle(): Promise<void>
}

export type AgentSlotState = "idle" | "running" | "disposed"

export interface AgentSlotSnapshot {
  sessionId: string
  generation: number
  state: AgentSlotState
  hasAgent: boolean
}

interface AgentSlot {
  sessionId: string
  generation: number
  state: AgentSlotState
  agent?: SlotAgent
  drainGeneration: number
  drainPromise?: Promise<void>
}

/** Per-session ownership for Pi runs. Generation checks prevent stale cleanup from releasing a newer run. */
export class AgentSlotRegistry {
  private readonly slots = new Map<string, AgentSlot>()

  begin(sessionId: string): number | undefined {
    const current = this.slots.get(sessionId)
    if (current?.state === "running") return undefined
    const generation = (current?.generation ?? 0) + 1
    this.slots.set(sessionId, {
      sessionId,
      generation,
      state: "running",
      drainGeneration: current?.drainGeneration ?? 0,
      drainPromise: current?.drainPromise,
    })
    return generation
  }

  attach(sessionId: string, generation: number, agent: SlotAgent): boolean {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.state !== "running" || slot.generation !== generation) return false
    slot.agent = agent
    return true
  }

  end(sessionId: string, generation: number): boolean {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.state !== "running" || slot.generation !== generation) return false
    slot.state = "idle"
    return true
  }

  isRunning(sessionId: string): boolean {
    return this.slots.get(sessionId)?.state === "running"
  }

  isAnyRunning(): boolean {
    return [...this.slots.values()].some(slot => slot.state === "running")
  }

  activeAgent(sessionId: string): SlotAgent | undefined {
    const slot = this.slots.get(sessionId)
    return slot?.state === "running" ? slot.agent : undefined
  }

  drain(sessionId: string, worker: (generation: number) => Promise<void>): Promise<void> {
    let slot = this.slots.get(sessionId)
    if (!slot) {
      slot = { sessionId, generation: 0, state: "idle", drainGeneration: 0 }
      this.slots.set(sessionId, slot)
    }
    if (slot.drainPromise) return slot.drainPromise
    const drainGeneration = ++slot.drainGeneration
    const run = worker(drainGeneration).finally(() => {
      const current = this.slots.get(sessionId)
      if (current?.drainGeneration === drainGeneration && current.drainPromise === run) {
        current.drainPromise = undefined
      }
    })
    slot.drainPromise = run
    return run
  }

  isDrainCurrent(sessionId: string, generation: number): boolean {
    const slot = this.slots.get(sessionId)
    return Boolean(slot?.drainPromise && slot.drainGeneration === generation)
  }

  releaseWhenIdle(sessionId: string): boolean {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.state === "running" || slot.drainPromise) return false
    slot.state = "disposed"
    this.slots.delete(sessionId)
    return true
  }

  async dispose(sessionId: string): Promise<void> {
    const slot = this.slots.get(sessionId)
    if (!slot) return
    const generation = slot.generation
    slot.agent?.abort()
    await slot.agent?.waitForIdle().catch(() => undefined)
    const current = this.slots.get(sessionId)
    if (current?.generation !== generation) return
    current.state = "disposed"
    this.slots.delete(sessionId)
  }

  snapshot(sessionId: string): AgentSlotSnapshot | undefined {
    const slot = this.slots.get(sessionId)
    return slot && {
      sessionId: slot.sessionId,
      generation: slot.generation,
      state: slot.state,
      hasAgent: Boolean(slot.agent),
    }
  }

  reset(): void {
    for (const slot of this.slots.values()) slot.agent?.abort()
    this.slots.clear()
  }
}

export const agentSlots = new AgentSlotRegistry()
