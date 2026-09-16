export interface SlotAgent {
  steer(message: { role: "user"; content: string; timestamp: number }): void
  followUp(message: { role: "user"; content: string; timestamp: number }): void
  abort(): void
  waitForIdle(): Promise<void>
}

export type AgentSlotState = "idle" | "running" | "disposed"
export type AgentDeliveryPhase = "streaming" | "settling"
export type AgentDeliveryReceipt = "steered" | "followup"

export interface AgentSlotSnapshot {
  sessionId: string
  generation: number
  state: AgentSlotState
  hasAgent: boolean
  deliveryPhase?: AgentDeliveryPhase
}

interface AgentSlot {
  sessionId: string
  generation: number
  state: AgentSlotState
  agent?: SlotAgent
  deliveryPhase?: AgentDeliveryPhase
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
    slot.deliveryPhase = "streaming"
    return true
  }

  markDeliveryPhase(sessionId: string, generation: number, phase: AgentDeliveryPhase): boolean {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.state !== "running" || slot.generation !== generation || !slot.agent) return false
    slot.deliveryPhase = phase
    return true
  }

  deliver(sessionId: string, text: string): AgentDeliveryReceipt | undefined {
    const slot = this.slots.get(sessionId)
    if (slot?.state !== "running" || !slot.agent || !slot.deliveryPhase) return undefined
    const message = { role: "user" as const, content: text, timestamp: Date.now() }
    if (slot.deliveryPhase === "settling") {
      slot.agent.followUp(message)
      return "followup"
    }
    slot.agent.steer(message)
    return "steered"
  }

  deliveryMode(sessionId: string): "steer" | "followup" | undefined {
    const phase = this.slots.get(sessionId)?.deliveryPhase
    if (phase === "settling") return "followup"
    return phase === "streaming" ? "steer" : undefined
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
    let resolveRun!: () => void
    let rejectRun!: (error: unknown) => void
    const run = new Promise<void>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })
    slot.drainPromise = run
    void worker(drainGeneration).then(resolveRun, rejectRun).finally(() => {
      const current = this.slots.get(sessionId)
      if (current?.drainGeneration === drainGeneration && current.drainPromise === run) {
        current.drainPromise = undefined
      }
    })
    return run
  }

  isDrainCurrent(sessionId: string, generation: number): boolean {
    const slot = this.slots.get(sessionId)
    return slot?.drainGeneration === generation
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
      deliveryPhase: slot.deliveryPhase,
    }
  }

  reset(): void {
    for (const slot of this.slots.values()) slot.agent?.abort()
    this.slots.clear()
  }

  async abortAndWaitAll(): Promise<void> {
    const runs = [...this.slots.values()].map(async slot => {
      slot.agent?.abort()
      await slot.agent?.waitForIdle().catch(() => undefined)
    })
    await Promise.allSettled(runs)
    this.slots.clear()
  }
}

export const agentSlots = new AgentSlotRegistry()
