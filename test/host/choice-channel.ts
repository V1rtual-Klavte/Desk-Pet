// ==========================================
// Live Test 提问选择通道 —— 测试宿主的确定性应答
//
// Native L4 runner 不创建产品窗口，没有选择面板：`requestChoice()` 写入的待答项无人
// resolve，而提问**没有等待超时**（2026-10-06 用户裁决：选择类弹窗不留超时），
// 没有人应答就会一直挂到场景超时。这里给宿主装一条应答通道：watcher 以同步 flush
// 兜住每一条提问，默认按「用户取消」立即结算（没有面板就当作没问过 —— 不假装用户
// 选了任何一项）；需要真实等待语义的用例显式声明 `hold` 自行接管（它仍由用例自己
// 负责结算，宿主不代答）。
// ==========================================

import { watch } from "vue"
import { choiceState, resolveChoice } from "@/services/engine"
import type { ChoicePolicy } from "./types"

let policy: ChoicePolicy = "cancel"
let stopResponder: (() => void) | undefined

/**
 * 安装应答器并把通道重置到指定策略。每个场景开始时调用一次（见 standard-setup.ts）。
 * 上一场景若留下未应答的提问（例如该场景中断），先按用户取消收尾 —— 与确认/计划通道
 * 同款的跨场景隔离（提问没有超时，留给下一场景会永远挂着）。
 */
export function resetChoiceChannel(next: ChoicePolicy = "cancel"): void {
  if (!stopResponder) {
    stopResponder = watch(
      () => choiceState.pending.map(view => view.requestId).join("|"),
      () => {
        if (policy === "hold") return
        for (const view of [...choiceState.pending]) {
          resolveChoice(view.requestId, { kind: "cancelled" })
        }
      },
      { flush: "sync" },
    )
  }
  policy = next
  if (next !== "hold") {
    for (const view of [...choiceState.pending]) {
      resolveChoice(view.requestId, { kind: "cancelled" })
    }
  }
}
