// ==========================================
// 工具执行许可客户端 —— 向 Rust 应用级所有者借用额度
//
// 有界并发与效果互斥只有一个所有者（src-tauri/src/commands/tool_permit.rs）：
// shared_read 走有界共享，exclusive_effect 与其他执行互斥，delegate 由子运行
// 各自取许可、不占父批次额度。前端只负责借用、取消等待与真实结算后释放，
// 不自己建第二份锁。
//
// 借用者身份（本页面实例）在模块加载时声明上线：Rust 据此回收上一个页面实例留下的
// 孤儿额度。页面重新加载（Vite 全量热重载、WebView 重建）后旧实例已经无法归还额度，
// 没有这一步，泄漏的额度会让后续工具一直卡在排队上。
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import type { ToolContext, ToolDef } from "./types"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolPermit")

export interface ToolPermitLease {
  readonly requestId: string
  readonly kind: "shared" | "exclusive"
}

export type PermitAcquisition =
  | { kind: "granted"; lease: ToolPermitLease }
  /** delegate：宿主编排工具本身不占额度（§5.1）。 */
  | { kind: "not_required" }
  /** 等待期间被取消，未取得额度。 */
  | { kind: "cancelled" }

/** 借用者上线时的回收结果（对应 Rust 的 PermitReclaim）。 */
export interface PermitReclaim {
  readonly reclaimedActive: number
  readonly reclaimedQueued: number
}

/**
 * 借用者身份：本页面实例的 id。窗口标签由 Rust 从调用来源填，前端不复制一份。
 *
 * 存在 globalThis 上是刻意的：同一次页面加载内的模块再求值（HMR 模块热替换）必须复用
 * 同一身份，否则新实例会把仍在运行的额度当成孤儿回收 —— 在飞的 exclusive_effect 不能被
 * 回收。页面重新加载会拿到新 id，上一个实例的额度由 `tool_permit_attach` 一次性回收。
 */
const BORROWER_KEY = "__deskpetToolPermitBorrower"
const borrowerId: string = (() => {
  const holder = globalThis as unknown as Record<string, string | undefined>
  const existing = holder[BORROWER_KEY]
  if (existing) return existing
  const created = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  holder[BORROWER_KEY] = created
  return created
})()

function permitKind(tool: ToolDef): ToolPermitLease["kind"] | undefined {
  const { isolation } = tool.policy.execution
  if (isolation === "delegate") return undefined
  return isolation === "shared_read" ? "shared" : "exclusive"
}

/** 请求标识必须唯一：会话 + 代际 + 调用身份，避免不同窗口/回合互相释放额度。 */
function requestId(tool: ToolDef, ctx: ToolContext): string {
  const call = ctx.operationId ?? ctx.toolCallId ?? crypto.randomUUID()
  return `${ctx.sessionId ?? "no-session"}:${ctx.runGeneration ?? -1}:${call}:${tool.id}`
}

/**
 * 等待是唯一可取消的部分：拿到额度后是否继续执行由调用方按取消/代际重新核对。
 * IPC 失败按错误抛出，调用方不得在未知额度状态下执行效果。
 */
export async function acquireToolPermit(tool: ToolDef, ctx: ToolContext): Promise<PermitAcquisition> {
  const kind = permitKind(tool)
  if (!kind) return { kind: "not_required" }
  if (ctx.signal?.aborted) return { kind: "cancelled" }

  const id = requestId(tool, ctx)
  const signal = ctx.signal
  // 等待期间取消：通知 Rust 移除排队项，acquire 会以未取得额度结束。
  const cancelWait = () => {
    void invoke<boolean>("tool_permit_cancel", { requestId: id })
      .catch(error => log.warn("取消许可等待失败:", formatError(error)))
  }
  signal?.addEventListener("abort", cancelWait, { once: true })
  let granted = false
  try {
    granted = await invoke<boolean>("tool_permit_acquire", {
      requestId: id,
      kind,
      borrowerId,
      sessionId: ctx.sessionId ?? "",
      runGeneration: ctx.runGeneration ?? -1,
      operationId: ctx.operationId ?? ctx.toolCallId ?? "",
    })
  } finally {
    signal?.removeEventListener("abort", cancelWait)
  }
  return granted ? { kind: "granted", lease: { requestId: id, kind } } : { kind: "cancelled" }
}

/** 归还额度。只在真实执行结算后调用；释放失败只记录，不改变工具结果。 */
export async function releaseToolPermit(lease: ToolPermitLease): Promise<void> {
  try {
    await invoke("tool_permit_release", { requestId: lease.requestId })
  } catch (error) {
    log.error("释放工具许可失败:", formatError(error))
  }
}

export interface PermitSnapshot {
  sharedActive: number
  exclusiveActive: boolean
  queued: number
  maxSharedReaders: number
}

/**
 * 下发共享读上限（`ai.loop.maxParallelTools`）。所有者仍是 Rust 许可池：这里只把当前
 * 配置的数字交给它，由它裁定生效值（越界会报错，不静默夹边界），返回实际生效的上限。
 * 调用点是每个 run 开始前，与队列批量策略同一模式。
 */
export async function setToolPermitLimit(limit: number): Promise<number> {
  return invoke<number>("tool_permit_set_max_shared_readers", { limit })
}

/**
 * 当前许可域的额度快照 —— 只用于诊断与验证，不参与调度决策。
 * 并发场景据此断言「等待发生在额度层」而不是靠时序猜测。
 */
export async function permitSnapshot(): Promise<PermitSnapshot> {
  return invoke<PermitSnapshot>("tool_permit_snapshot")
}

/**
 * 声明本页面实例接管该窗口的额度归属，并一次性回收同窗口下上一个页面实例留下的
 * 在飞额度与排队项。判定只认「借用者已经不存在」（页面重新加载），不看时间 ——
 * 仍在运行的 exclusive_effect 不会被回收放开。
 */
async function attachToolPermitBorrower(): Promise<PermitReclaim> {
  return invoke<PermitReclaim>("tool_permit_attach", { borrowerId })
}

// 页面加载即接管：页面被重新加载后，上一个实例的额度在这里回到所有者手里。失败只记录，
// 不阻断页面 —— 所有者当前的额度与上限仍然有效，工具照常借用。
void attachToolPermitBorrower().then(
  reclaimed => {
    if (reclaimed.reclaimedActive > 0 || reclaimed.reclaimedQueued > 0) {
      log.info("回收失效借用者的额度:", reclaimed)
    }
  },
  error => log.warn("许可借用者上线失败:", formatError(error)),
)
