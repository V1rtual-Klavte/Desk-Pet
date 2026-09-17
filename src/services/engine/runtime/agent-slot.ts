export interface SlotAgent {
  steer(message: { role: "user"; content: string; timestamp: number; deskpetEventId?: string }): void
  followUp(message: { role: "user"; content: string; timestamp: number; deskpetEventId?: string }): void
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
  requestId?: string
  turnId?: string
}

interface AgentSlot {
  sessionId: string
  generation: number
  state: AgentSlotState
  controller?: AbortController
  agent?: SlotAgent
  deliveryPhase?: AgentDeliveryPhase
  drainGeneration: number
  drainPromise?: Promise<void>
  requestId?: string
  turnId?: string
}

/** Per-session ownership for Pi runs. Generation checks prevent stale cleanup from releasing a newer run. */
export class AgentSlotRegistry {
  private readonly slots = new Map<string, AgentSlot>()
  /** 跨 slot 删除、reset 与重建单调递增，不能从 Map 中的旧 slot 推导。 */
  private nextGeneration = 0
  /** drain worker 同样需要跨删除的代际，避免旧 finally 清空新 drainPromise。 */
  private nextDrainGeneration = 0

  begin(sessionId: string): number | undefined {
    const current = this.slots.get(sessionId)
    if (current?.state === "running") return undefined
    const generation = ++this.nextGeneration
    this.slots.set(sessionId, {
      sessionId,
      generation,
      state: "running",
      controller: new AbortController(),
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

  bindRun(sessionId: string, generation: number, identity: { requestId: string; turnId?: string }): boolean {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.state !== "running" || slot.generation !== generation) return false
    slot.requestId = identity.requestId
    slot.turnId = identity.turnId
    return true
  }

  markDeliveryPhase(sessionId: string, generation: number, phase: AgentDeliveryPhase): boolean {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.state !== "running" || slot.generation !== generation || !slot.agent) return false
    slot.deliveryPhase = phase
    return true
  }

  deliver(sessionId: string, text: string, deskpetEventId?: string): AgentDeliveryReceipt | undefined {
    const slot = this.slots.get(sessionId)
    if (slot?.state !== "running" || !slot.agent || !slot.deliveryPhase) return undefined
    const message = { role: "user" as const, content: text, timestamp: Date.now(), deskpetEventId }
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
    slot.controller?.abort()
    slot.state = "idle"
    return true
  }

  isRunning(sessionId: string): boolean {
    return this.slots.get(sessionId)?.state === "running"
  }

  isAnyRunning(): boolean {
    return [...this.slots.values()].some(slot => slot.state === "running")
  }

  signal(sessionId: string, generation: number): AbortSignal | undefined {
    const slot = this.slots.get(sessionId)
    return slot?.generation === generation ? slot.controller?.signal : undefined
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
    const drainGeneration = ++this.nextDrainGeneration
    slot.drainGeneration = drainGeneration
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
    slot.controller?.abort()
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
      requestId: slot.requestId,
      turnId: slot.turnId,
    }
  }

  reset(): void {
    for (const slot of this.slots.values()) { slot.controller?.abort(); slot.agent?.abort() }
    this.slots.clear()
  }

  async abortAndWaitAll(): Promise<void> {
    const runs = [...this.slots.values()].map(async slot => {
      slot.controller?.abort()
    slot.agent?.abort()
      await slot.agent?.waitForIdle().catch(() => undefined)
    })
    await Promise.allSettled(runs)
    this.slots.clear()
  }
}

export const agentSlots = new AgentSlotRegistry()
