// ==========================================
// 会话读模型变化信号（A2）—— 零依赖叶子
// ==========================================
//
// 用途：session 域（`@/services/session/manager`）在会话读模型发生变化时通知原生 UI
// 推送侧重推会话侧投影帧（标签列表 / 历史列表），而推送侧（native-ui 的
// `session-projection`）要读 session 域 —— 两边直接互相 import 会形成循环依赖。
// 这里放一个只有注册/通知两个函数的零依赖叶子，两边都只依赖它
// （与 `active-profile-signal.ts` 同一装配模式）。
//
// 触发点（manager 的写路径；即标签条显示需要更新的时机）：
// 新建 / 关闭 / 恢复打开 / 删除 / 切换活跃会话 / 改名（含首条消息自动命名）/
// 「上次运行中断」标记变化。
//
// 未注册 = 静默跳过（Node 领域初始化早期、测试进程里都可能没有消费者）；
// 通知是同步、尽力而为的：监听者自己的推送失败由监听者留痕，不影响会话操作本身。

let listener: (() => void) | null = null

/** 注册监听者（传 null 注销）。 */
export function setSessionChangedListener(next: (() => void) | null): void {
  listener = next
}

/** 通知「会话读模型已变化」（列表集合 / 活跃指针 / 展示名 / 中断标记）。 */
export function notifySessionChanged(): void {
  listener?.()
}
