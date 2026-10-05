// ==========================================
// 顶栏状态位推送（A2）—— 最终文本 → 原生宿主
// ==========================================
//
// 仲裁（owner/优先级/序列）**唯一在 `src/services/titlebar.ts`**：本模块不重实现、
// 不改动它，只在它的渲染结果落定处（`renderOwner` 的渲染通知）把**最终文本**经既有
// 命令通道推给宿主（`apply_titlebar_status`；Rust 落点 `UiHandle::apply_titlebar_status`，
// 见 `crates/native-host/src/ui/titlebar.rs`）。宿主只持文本快照，未收到推送时保持
// 缺省「就绪」（中性空闲态；与 truth point 初值同字面量）。
//
// 去重：只在最终文本与上次**成功推送**的文本不同时才发（渲染点每次 owner 变更都会
// 通知，同一文本重复下发没有意义）；失败不更新去重位，下一次渲染自动重试
// （失败由装配侧留痕，见 index.ts 的监听注册）。

import { getHostBridge } from "@/services/host"

let lastPushed: string | null = null

/** 推送顶栏状态位最终文本（去重；失败如实抛出、不更新去重位）。 */
export async function pushTitlebarStatus(text: string): Promise<void> {
  if (text === lastPushed) return
  await getHostBridge().request("apply_titlebar_status", { text })
  lastPushed = text
}

/** 测试拆卸（产品路径不调用）。 */
export function __resetTitlebarStatusPushForTest(): void {
  lastPushed = null
}
