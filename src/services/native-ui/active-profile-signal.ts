// ==========================================
// 激活 Profile 变化信号（W9b）—— 零依赖叶子
// ==========================================
//
// 用途：Profile 装载器（`@/services/profile/loader`）在激活项变化时通知原生 UI
// 推送侧重推舞台快照，而推送侧又会读 Profile —— 两边直接互相 import 会形成
// 循环依赖。这里放一个只有注册/通知两个函数的零依赖叶子，两边都只依赖它。
//
// 语义：单监听者、注册晚于激活时由注册方自己按当前激活态补一次
// （`initNativeUiBridge` 的首推就是这个补课）；
// 未注册 = 静默跳过（Node 领域初始化早期、测试进程里都可能没有监听者）。

let listener: (() => void) | null = null

/** 注册监听者（传 null 注销）。 */
export function setActiveProfileListener(next: (() => void) | null): void {
  listener = next
}

/**
 * 通知「激活的 Profile（或它的层列表）已变化」。
 *
 * 同步、尽力而为：监听者自身的失败由监听者处理（推送侧汇总留痕），不影响激活流程。
 */
export function notifyActiveProfileChanged(): void {
  listener?.()
}
