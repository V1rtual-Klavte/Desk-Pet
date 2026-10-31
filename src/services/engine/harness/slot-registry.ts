// Harness 槽注册表：每会话一个槽的所有权表、单例与全局「AI 生成中」查询。
//
// 从 slot.ts 抽出：槽实现（HarnessSlot）不依赖这张表，消费方按需只取注册表，
// 避免为了查一次「忙不忙」把整个槽实现装进来。

import type { JsonValue } from "@earendil-works/pi-agent-core"
import { ABORT_REASON_DISPOSE } from "@/services/engine/state"
import type { HarnessCancelQueuedKind, HarnessSlotSnapshot, HarnessTurnAdmission } from "@/services/engine/state"
import { onUserWaitChange } from "@/services/engine/state/user-wait"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { HarnessSlot } from "./slot"

const log = createLogger("HarnessSlot")

// ── 槽注册表 ──

/**
 * 每会话一个槽：运行所有权、投递与 drain 代际的唯一宿主定义点（H-4 起 RuntimeQueue/AgentSlot 已删除）。
 */
export class HarnessSlots {
  private readonly slots = new Map<string, HarnessSlot>()
  /** 已分配过的最大代际：新槽（含释放重建）从这里继续，保证单调不回退。 */
  private generationSeed = 0
  /**
   * 已受理、尚未交回的回合凭据：AI 生成锁的另一半真相源。
   *
   * 覆盖「槽判空闲但回合仍在途」的窗口 —— 槽在回合收尾前被释放/重建（dispose、空闲回收、
   * 测试重置）或已不在运行态时 `isAnyRunning()` 为 false，光看槽状态会让在途回合被当成
   * 空闲放行主动扫描。释放与回合的 finally 同流（`endAdmission`），没有定时器，结构上不会卡死。
   */
  private readonly turnAdmissions = new Set<HarnessTurnAdmission>()
  private admissionSeq = 0
  /** 无槽期间、以及槽关闭时仍未写入的审计条目（按 sessionId）：下次 ensure() 转交给新槽，不丢证据。 */
  private readonly orphanAudits = new Map<string, Array<{ customType: string; data: JsonValue }>>()

  /** 唯一的创建入口；读路径一律用 peek()，不得为了读一次状态而把槽建出来。 */
  ensure(sessionId: string): HarnessSlot {
    let slot = this.slots.get(sessionId)
    if (!slot) {
      slot = new HarnessSlot(sessionId, {
        generationSeed: this.generationSeed,
        onRunSettled: settled => this.releaseIfIdle(settled),
        onAuditOrphans: items => {
          for (const item of items) this.queueAuditWithoutSlot(sessionId, item.customType, item.data)
        },
      })
      this.slots.set(sessionId, slot)
      // 无槽期间挂起的审计条目在这里转交：证据不因槽被释放而丢。
      const orphans = this.orphanAudits.get(sessionId)
      if (orphans) {
        this.orphanAudits.delete(sessionId)
        for (const item of orphans) slot.queueAuditEntry(item.customType, item.data)
      }
    }
    this.generationSeed = Math.max(this.generationSeed, slot.generation)
    return slot
  }

  peek(sessionId: string): HarnessSlot | undefined {
    return this.slots.get(sessionId)
  }

  /**
   * 用户等待的回合预算豁免（`state/user-wait.ts` 的登记经模块级监听转发到这里）：把该会话的槽
   * 与挂在它下面的子运行（计划步骤的子代理 / 带父槽归属的子运行）一起挂起回合墙钟 ——
   * 主回合与它正阻塞等待的那些子运行，都不该被用户思考的时间掐断。没有槽（该会话没在跑）
   * 时是 no-op；没有父槽归属的独立子运行（fork/team、主动规划）不在豁免范围 —— 它们不面向
   * 主对话的等待，各自的预算继续有效。
   */
  applyUserWait(sessionId: string, waiting: boolean): void {
    const slot = this.slots.get(sessionId)
    if (!slot) return
    const apply = (node: HarnessSlot): void => {
      node.setUserWaitHeld(waiting)
      for (const child of node.childSlots()) apply(child)
    }
    apply(slot)
  }

  /** 唯一 flush 入口的两级转发：没有槽时是 no-op（无槽期间条目挂在 orphanAudits 上）。 */
  async flushAudit(sessionId: string): Promise<void> {
    await this.peek(sessionId)?.flushAudit()
  }

  /** 关停前停止所有回合并 flush 其审计；待审计项和无法结算的运行数返回给宿主报告。 */
  async prepareForShutdown(): Promise<{ unresolvedRuns: number; pendingAudit: number }> {
    const roots = [...this.slots.values()]
    const allSlots = new Set<HarnessSlot>()
    const collect = (slot: HarnessSlot): void => {
      if (allSlots.has(slot)) return
      allSlots.add(slot)
      for (const child of slot.childSlots()) collect(child)
    }
    roots.forEach(collect)
    const aborts = await Promise.allSettled(roots.map(slot => slot.abort(ABORT_REASON_DISPOSE)))
    aborts.forEach((result, index) => {
      if (result.status === "rejected") {
        log.warn("关停时停止运行失败:", { sessionId: roots[index]!.snapshot().sessionId }, formatError(result.reason))
      }
    })
    const shutdownSlots = [...allSlots]
    const idleStates = await Promise.all(shutdownSlots.map(slot => slot.waitForIdle()))
    const unresolvedRuns = idleStates.filter(idle => !idle).length
    let pendingAudit = [...this.orphanAudits.values()].reduce((sum, items) => sum + items.length, 0)
    const auditFlushes = await Promise.allSettled(shutdownSlots.map(slot => slot.flushAudit()))
    auditFlushes.forEach((result, index) => {
      const slot = shutdownSlots[index]!
      const remaining = slot.pendingAuditCount()
      pendingAudit += result.status === "rejected" && remaining === 0 ? 1 : remaining
      if (result.status === "rejected") {
        log.error("关停时审计 flush 异常:", { sessionId: slot.snapshot().sessionId }, formatError(result.reason))
      }
    })
    return { unresolvedRuns, pendingAudit }
  }

  /** 无槽（以及槽关闭时仍有未写入项）把证据条目挂在注册表上（按 sessionId），下次 ensure() 转交给新槽；不丢证据。 */
  queueAuditWithoutSlot(sessionId: string, customType: string, data: JsonValue): void {
    const pending = this.orphanAudits.get(sessionId) ?? []
    pending.push({ customType, data })
    this.orphanAudits.set(sessionId, pending)
  }

  begin(sessionId: string, identity?: { requestId: string; turnId?: string }): number | undefined {
    const generation = this.ensure(sessionId).begin(identity)
    if (generation !== undefined) this.generationSeed = Math.max(this.generationSeed, generation)
    return generation
  }

  bindRun(sessionId: string, generation: number, identity: { requestId: string; turnId?: string }): boolean {
    return this.peek(sessionId)?.bindRun(generation, identity) ?? false
  }

  /**
   * 宿主声明回合终点：结束代际所有权，并给空闲回收器一次收口机会
   * （运行收尾时槽还被判忙、或收尾通知早于本调用时，释放请求积压到这里）。
   */
  end(sessionId: string, generation: number): boolean {
    const slot = this.peek(sessionId)
    const ended = slot?.end(generation) ?? false
    if (ended && slot) this.releaseIfIdle(slot)
    return ended
  }

  isRunning(sessionId: string): boolean {
    return this.peek(sessionId)?.isRunning() ?? false
  }

  /**
   * 唯一的「忙」定义：宿主回合所有权（`isRunning`）或 lane 操作在飞（含手动压缩）。
   * 没有槽的会话不算忙（还没打开，也就没有在飞操作）；读失败 fail-closed 见槽侧实现。
   */
  async hasOpenOperation(sessionId: string): Promise<boolean> {
    const slot = this.peek(sessionId)
    return slot ? (slot.isRunning() || await slot.hasOpenOperation()) : false
  }

  /** 当前代际仍是所有者（未取消、未失效）。 */
  isCurrent(sessionId: string, generation: number): boolean {
    return this.peek(sessionId)?.isCurrent(generation) ?? false
  }

  isAnyRunning(): boolean {
    return [...this.slots.values()].some(slot => slot.isRunning())
  }

  /**
   * 受理一个回合：返回的凭据必须在同一回路的 finally 里交回 `endAdmission`。
   *
   * 调用点是三个 runner 入口（`sendMessage` / `resumePausedInputs` / `sendActiveMessage`）
   * 在 `begin()` 成功之后、该回路的首个 `await` 之前 —— 提前 return 的分支都发生在受理之前，
   * 因此不存在「受理了却没人交回」的路径。
   */
  admit(): HarnessTurnAdmission {
    const token: HarnessTurnAdmission = { admissionId: ++this.admissionSeq }
    this.turnAdmissions.add(token)
    return token
  }

  /** 交回受理凭据；重复或未知凭据是无操作（Set 语义），不会误伤别的回合的锁。 */
  endAdmission(token: HarnessTurnAdmission): void {
    this.turnAdmissions.delete(token)
  }

  /**
   * 是否有回合在途（AI 生成锁的唯一判据，`isAIGenerating()` 据此计算）：
   * 有已受理未交回的回合，或任一槽在运行。
   *
   * 长回合期间恒为 true —— 不清锁靠定时器，而靠回合自己的 finally（不再有安全超时强解）。
   */
  isTurnActive(): boolean {
    return this.turnAdmissions.size > 0 || this.isAnyRunning()
  }

  /** Test isolation hook：清空受理计数（场景之间不留上一个回合的锁）。 */
  resetTurnAdmissionsForTest(): void {
    this.turnAdmissions.clear()
  }

  snapshot(sessionId: string): HarnessSlotSnapshot | undefined {
    return this.peek(sessionId)?.snapshot()
  }

  getInterrupted(sessionId: string): HarnessSlotSnapshot["interrupted"] {
    return this.peek(sessionId)?.getInterrupted()
  }

  /** 撤销尚未被消费的投递（best-effort）；未打开过的会话没有待撤销项。 */
  async cancelPendingDelivery(sessionId: string, requestId: string): Promise<boolean> {
    return await this.peek(sessionId)?.cancelPendingDelivery(requestId) ?? false
  }

  /** 单项撤回（UI 排队视图）：没有槽的会话本来就没有可撤回项。 */
  async cancelQueued(sessionId: string, entryId: string): Promise<HarnessCancelQueuedKind> {
    const slot = this.peek(sessionId)
    return slot ? await slot.cancelQueued(entryId) : "not_found"
  }

  /**
   * 空闲回收：单一定义点就是本注册表的 Map。
   * 顺序：ABA 校验 → 消费待回收标记 → 宿主仍持有运行权时归还请求（等 end()）。
   */
  private releaseIfIdle(slot: HarnessSlot): void {
    if (this.slots.get(slot.sessionId) !== slot) return
    if (!slot.consumeIdleRelease()) return
    if (slot.isRunning()) { slot.requestIdleRelease(); return }
    this.slots.delete(slot.sessionId)
    void slot.close()
  }

  /**
   * 释放空闲槽（会话切换/关闭时用）；运行中的槽不释放。
   *
   * 「不空闲」包含 lane 结构操作在飞（手动压缩）：这类槽此刻不能删，但请求不再丢 ——
   * 登记到槽上，等运行收尾（`onRunSettled`）或宿主声明回合终点（`end`）时由
   * `releaseIfIdle` 收口。返回 false 表示「本次没释放」，不代表请求被丢弃。
   */
  async releaseWhenIdle(sessionId: string): Promise<boolean> {
    const slot = this.peek(sessionId)
    if (!slot) return false
    if (slot.isRunning() || await slot.hasOpenOperation()) {
      slot.requestIdleRelease()
      return false
    }
    this.slots.delete(sessionId)
    await slot.close()
    return true
  }

  /** 槽是否已因内核故障密封（上游 fault 后不能原地续跑，只能整条重开）。 */
  isFaulted(sessionId: string): boolean {
    return this.peek(sessionId)?.snapshot().state === "faulted"
  }

  /**
   * 用户新回合入口的故障恢复：显式放掉密封槽，让紧接着的 `begin` 新建槽并从盘上重开会话。
   *
   * 只由面向用户的新消息入口调用 —— 主动回合、结构操作与子运行不自行恢复，故障不能被
   * 它们静默洗掉。`open()` 自身仍不静默重建（§8.7.4），恢复必须经过这次显式释放。
   */
  async recoverFaulted(sessionId: string): Promise<boolean> {
    if (!this.isFaulted(sessionId)) return false
    log.warn("会话槽已故障，按用户新消息放掉并重开:", sessionId)
    await this.dispose(sessionId)
    return true
  }

  /** 释放会话槽；返回是否在空闲状态下释放（false 表示带着未结束的运行继续，已 warn）。 */
  async dispose(sessionId: string): Promise<boolean> {
    const slot = this.peek(sessionId)
    if (!slot) return true
    await slot.abort(ABORT_REASON_DISPOSE).catch(error => {
      log.warn("释放会话槽时停止运行失败:", sessionId, formatError(error))
      return undefined
    })
    const idle = await slot.waitForIdle()
    // 子运行不注册在会话表里：abort 已级联到它们，这里再等它们收尾（句柄释放不能反序）。
    await Promise.allSettled(slot.childSlots().map(child => child.waitForIdle()))
    this.slots.delete(sessionId)
    await slot.close()
    return idle
  }

  async abortAndWaitAll(): Promise<void> {
    await Promise.allSettled([...this.slots.values()].map(async slot => {
      await slot.abort(ABORT_REASON_DISPOSE).catch(error => {
        log.warn("停止运行失败:", { sessionId: slot.snapshot().sessionId }, formatError(error))
        return undefined
      })
      await slot.waitForIdle()
      // 子槽（计划步骤的子代理）不在会话表里：不等它们收尾，隔离点会在子运行未结束时
      // 关掉文件句柄（resetAgentRuntimeForTest 的直接后果）。
      await Promise.allSettled(slot.childSlots().map(child => child.waitForIdle()))
    }))
  }

  async reset(): Promise<void> {
    const slots = [...this.slots.values()]
    this.slots.clear()
    // 未转交的孤儿审计条目在 reset 时清空：报出条数，不静默当它们已落盘。
    if (this.orphanAudits.size > 0) {
      const pending = [...this.orphanAudits.values()].reduce((sum, items) => sum + items.length, 0)
      log.error("重置运行槽时有审计条目未落盘，已丢弃:", { sessions: this.orphanAudits.size, pending })
      this.orphanAudits.clear()
    }
    await Promise.allSettled(slots.map(slot => slot.close()))
  }
}

export const harnessSlots = new HarnessSlots()

// 用户等待的回合预算豁免（唯一接线点）：`state/user-wait.ts` 的登记每次开合都转发到相关槽。
// 模块级挂一次即可（单例常驻），不随 run 生命周期增删。
onUserWaitChange((sessionId, waiting) => { harnessSlots.applyUserWait(sessionId, waiting) })

/**
 * AI 生成锁：是否正在生成（主动扫描 / 观察 / 记忆整理据此不打搅）。
 *
 * 真相源是回合状态本身（受理计数 + 槽运行状态），不是另一个可被写坏的布尔：
 * 谁受理谁在 finally 交回，没有定时器、没有强制解锁，锁的寿命与回合严格同流。
 */
export function isAIGenerating(): boolean {
  return harnessSlots.isTurnActive()
}
