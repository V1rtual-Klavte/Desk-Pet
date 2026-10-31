// ==========================================
// 用户等待登记 —— 「等用户做决定」期间的预算豁免（零依赖叶子）
//
// 2026-10-06 用户裁决：选择类弹窗（提问 / 权限确认 / 计划确认）**不留超时**，
// 用户想多久想多久；但「面板根本没送到」的逃生口必须保留（发射失败 / 会话切换 /
// 会话不活跃 / 用户停止回合 / 面板被新决策顶掉 —— 各自在结算处立即收尾）。
//
// 删掉等待超时之后，另一条倒计时还会打断用户：**回合墙钟**（`turnTimeoutMs` 包住
// 「等确认 + 执行」）与**工具执行超时**（router 的 `execution.timeoutMs`）。等待期间
// 它们必须停表。这里承载那件事的唯一登记表：
//   · 等待方（plan-confirmation / choice-confirmation / safety confirm）调
//     `beginUserWait(sessionId)`，结算时 release —— 引用计数允许同一会话并发多条等待；
//   · 预算计时器的持有方（HarnessSlot 的回合墙钟、ToolRouter 的工具超时）用
//     `subscribeUserWait` / `createPausableDeadline` 挂起与续算；
//   · `userWaitTotalMs` 给按**时间戳**比较的预算（计划时限）折算已等待时长。
//
// 为什么独立成叶子：等待方分居三个领域（引擎计划域 / 引擎选择域 / 安全域），
// 消费方在 harness 与 tool 两个模块族；叶子没有依赖，谁都可直接引用而不引入循环。
// ==========================================

/** 等待开始/结束的观察者（`waiting=true` = 该会话进入等待；false = 最后一条等待结算）。 */
type UserWaitListener = (sessionId: string, waiting: boolean) => void

const listeners = new Set<UserWaitListener>()
/** sessionId → 等待中的决策条数（引用计数：同一会话可并发多条等待）。 */
const counts = new Map<string, number>()
/** sessionId → 本轮等待的起点（0→1 时登记，计数归零时把时长累进 totals）。 */
const startedAt = new Map<string, number>()
/** sessionId → 累计等待墙钟（本轮等待期的并集；只增不减，消费方自己取基线差）。 */
const totals = new Map<string, number>()

function notify(sessionId: string, waiting: boolean): void {
  for (const listener of [...listeners]) listener(sessionId, waiting)
}

/** 观察某会话的等待开合（不立即回调；新订阅者用 `isUserWaiting` 取当前态）。 */
export function onUserWaitChange(listener: UserWaitListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 该会话当前是否有等待中的决策（0 条以上）。 */
export function isUserWaiting(sessionId: string): boolean {
  return (counts.get(sessionId) ?? 0) > 0
}

/**
 * 登记一条「等用户做决定」。返回 release 函数（幂等）；等待方在**每一条**结算路径上
 * 都必须 release —— 逃生口（发射失败 / 会话切换 / 取消）不是一个条数而是结算原因。
 */
export function beginUserWait(sessionId: string): () => void {
  const next = (counts.get(sessionId) ?? 0) + 1
  counts.set(sessionId, next)
  if (next === 1) {
    startedAt.set(sessionId, Date.now())
    notify(sessionId, true)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const current = counts.get(sessionId) ?? 0
    if (current > 1) {
      counts.set(sessionId, current - 1)
      return
    }
    counts.delete(sessionId)
    const start = startedAt.get(sessionId)
    if (start !== undefined) {
      totals.set(sessionId, (totals.get(sessionId) ?? 0) + Math.max(0, Date.now() - start))
      startedAt.delete(sessionId)
    }
    notify(sessionId, false)
  }
}

/** 该会话累计的等待墙钟（毫秒；含正在等待的一轮）。按时间戳比较的预算用它折算。 */
export function userWaitTotalMs(sessionId: string): number {
  const start = startedAt.get(sessionId)
  const active = start === undefined ? 0 : Math.max(0, Date.now() - start)
  return (totals.get(sessionId) ?? 0) + active
}

// ==========================================
// 可暂停的一次性计时器（回合墙钟与工具超时共用）
// ==========================================

export interface PausableDeadline {
  /** 起表：`remainingMs` 后触发（重新起表会覆盖旧计时器与暂停态）。 */
  start(remainingMs: number): void
  /** 挂起：记住剩余时长并清除计时器（未起表或已挂起时为空操作）。 */
  hold(): void
  /** 续算：按剩余时长续起（未挂起时为空操作；剩余为 0 也至少给 1ms 让回调必然跑到）。 */
  resume(): void
  /** 撤销：清除计时器与暂停态（预算结束/槽关闭时调用）。 */
  cancel(): void
  /** 当前是否处于挂起态（槽起表时决定「以挂起态起步」用）。 */
  isHeld(): boolean
}

/**
 * 预算计时器的用户等待豁免（唯一实现点）：`fire` 由调用方定义（回合超时走 abort、
 * 工具超时走定时器置位 + abort），挂起期间不计入预算，续算按剩余额度。
 */
export function createPausableDeadline(fire: () => void): PausableDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadlineAt = 0
  let heldRemainingMs: number | undefined
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const deadline: PausableDeadline = {
    start(remainingMs) {
      clear()
      heldRemainingMs = undefined
      deadlineAt = Date.now() + remainingMs
      timer = setTimeout(fire, remainingMs)
    },
    hold() {
      if (timer === undefined || heldRemainingMs !== undefined) return
      heldRemainingMs = Math.max(0, deadlineAt - Date.now())
      clear()
    },
    resume() {
      if (heldRemainingMs === undefined) return
      const remaining = heldRemainingMs
      heldRemainingMs = undefined
      deadlineAt = Date.now() + remaining
      timer = setTimeout(fire, Math.max(1, remaining))
    },
    cancel() {
      clear()
      heldRemainingMs = undefined
    },
    isHeld() {
      return heldRemainingMs !== undefined
    },
  }
  return deadline
}

/** 订阅某会话的等待开合（其余会话的事件被过滤掉）。 */
export function subscribeUserWait(sessionId: string, listener: (waiting: boolean) => void): () => void {
  return onUserWaitChange((changed, waiting) => {
    if (changed === sessionId) listener(waiting)
  })
}
