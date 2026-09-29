// ==========================================
// Live Test 确认通道 —— 测试宿主的确定性应答
//
// live-test.html 是裸页，没有 ChatPanel：`requestPermissionConfirm()` 写入的
// `confirmState.pending` 无人 resolve，DANGER 工具一旦走到确认就会挂到场景超时。
//
// 这里给宿主装一条应答通道：watcher 以同步 flush 兜住每一条确认请求，
// 按场景声明的策略立即应答。默认 "deny" —— 只有显式声明
// `meta.confirmPolicy: "approve"` 的场景才会放行被确认的工具。
// ==========================================

import { watch } from "vue"
import { confirmState, resolveConfirm } from "@/services/safety"
import type { ConfirmPolicy, ConfirmRecord } from "./types"

let policy: ConfirmPolicy = "deny"
let stopResponder: (() => void) | undefined
const records: ConfirmRecord[] = []

/**
 * 安装应答器并把通道重置到指定策略。每个场景开始时调用一次（见 standard-setup.ts）。
 *
 * 上一场景若留下未应答的请求（例如该场景超时中断），先按拒绝收尾，
 * 否则它会在下一个场景被覆盖式写入丢弃，永远挂起。
 */
export function resetConfirmChannel(next: ConfirmPolicy = "deny"): void {
  if (!stopResponder) {
    // flush: "sync" 让应答与 `confirmState.pending = …` 在同一轮同步完成，
    // 请求不会在两次赋值之间互相覆盖。
    stopResponder = watch(
      () => confirmState.pending,
      pending => {
        if (!pending) return
        const approved = policy === "approve"
        // 身份随记录一起留底：场景要断言「授权按哪个会话与代际入账」时只有这份内核身份可信。
        records.push({
          toolName: pending.toolName,
          approved,
          ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
          ...(pending.runGeneration === undefined ? {} : { runGeneration: pending.runGeneration }),
        })
        resolveConfirm(approved)
      },
      { flush: "sync" },
    )
  }
  records.length = 0
  policy = next
  if (confirmState.pending) resolveConfirm(false)
}

/** 本场景已应答的确认请求，按发生顺序。 */
export function confirmRecords(): ConfirmRecord[] {
  return records.map(record => ({ ...record }))
}
