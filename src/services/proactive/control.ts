// ==========================================
// 主动控制通道 —— 档位投影下发（Node → Rust）
// ==========================================
//
// 真相源变更（契约 §2.2）：主动开关已并入 `ai.proactive.frequency` 档位（`off` = 关），
// 不再有独立 enabled 设置，也没有运行期 enabled 状态 —— 门禁一律由 scanner 读
// `proactiveFrequency()` 判定。Rust 侧 `proactive_control` 表的 enabled 列已删。
//
// 本模块唯一的职责：把当前档位派生的 limits 投影经 `proactive_control` 通道下发给
// Rust 终裁（契约 §2.5）。Rust 存运行期投影、不读 CONFIG、不回写；真相源仍是 CONFIG。
// `muteUntil` / `revision` 仍是 Rust 侧运行期状态，消费点是 scan 回执里的 `control`
// （scanner.tick 直接读，不经过本模块）。
//
// limits 是全局运行期投影，不归属任何会话。`proactive_control` 的 control 动作用
// 空身份信封（Rust 的 proactive_change 对 control 显式豁免 owner 校验，见 store.rs），
// baseRevision 也不参与乐观并发比对；不要为下发投影伪造某张卡或某个会话的身份。

import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { proactiveFrequency, proactiveTierLimits } from "./tiers"
import * as ipc from "./ipc"
import type { ProactiveOwner } from "./protocol"

const log = createLogger("ProactiveControl")

/** 投影推送的控制信封：全局运行期投影，不属于任何会话（见文件头注）。 */
const projectionOwner: ProactiveOwner = { sessionId: "", cardId: "", cardHash: "", runGeneration: 0 }

/**
 * 把当前档位派生的 limits 投影推给 Rust（scanner start 与每次 `refreshProactive` 调用）。
 *
 * `off` 不推：Rust 保持现值 / 缺省（缺省 = 中档），与「关」不产生新节流需求一致。
 * 失败只留痕不抛出 —— 投影是终裁加速器，真相源仍是 CONFIG，下一次刷新/启动会重推；
 * 调用方在同步引导路径上，一次下发失败不该中断引导或设置保存。
 */
export async function pushProactiveLimits(): Promise<void> {
  const tier = proactiveFrequency()
  if (tier === "off") return
  try {
    await ipc.control({ operationId: crypto.randomUUID(), baseRevision: 0, owner: projectionOwner, limits: proactiveTierLimits(tier) })
  } catch (error) {
    log.warn("主动档位投影下发失败（Rust 保持现值，下次刷新重推）:", formatError(error))
  }
}
