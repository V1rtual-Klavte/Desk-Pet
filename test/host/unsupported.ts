// ==========================================
// Node 适配层的抛错表 —— 命令按「能否等价复现」分成两组
// ==========================================
//
// [保留已登记 §4.2] 本文件在 Node 侧运行（vitest / Node launcher），不能 import
// @/services/logger|error —— 那两个模块会拖进 Tauri IPC 与浏览器全局。这里没有静默分支：
// 每条路径要么返回真实结果，要么抛错。

/**
 * Node 适配层**无法等价复现**的 Tauri 命令。调用即抛，绝不返回 null 冒充成功。
 *
 * 判据是「复现它需要 Rust 侧的安全基线或桌面能力」，不是「暂时懒得写」：
 * 把这些命令做成空实现，场景会在假适配下「假装通过」，那比直接失败更糟。
 * 目录见 docs/history/implementation/测试分层重构契约-2026-09-29基线.md「宿主分层」的不可复现表。
 */
export const RUST_ONLY_COMMANDS = [
  // tool_exec.rs / bash_policy.rs：层 1 硬基线 + 系统路径保护 + 凭据拦截，调用方不可关闭
  "bash_exec", "bash_cancel",
  // mcp_bridge.rs：stdio 子进程
  "mcp_spawn", "mcp_send", "mcp_kill",
  // tool_permit.rs：Rust 侧许可内核（额度、借用者代际、结算时点）
  "tool_permit_acquire", "tool_permit_release", "tool_permit_cancel",
  "tool_permit_attach", "tool_permit_snapshot", "tool_permit_set_max_shared_readers",
  // 桌面能力：系统剪贴板
  "clipboard_read", "clipboard_write",
  // 窗口与显示器
  "open_windows_sim", "close_windows_sim", "pause_monitor", "resume_monitor",
  // 桌面副作用
  "app_open", "export_profile_zip", "restore_default_resources",
  // MemoryStore/FTS/transactions are Rust-owned; Node must not fake them.
  "memory_status", "memory_list", "memory_detail", "memory_register_sources", "memory_query", "memory_get_items",
  "memory_apply_change", "memory_job_start", "memory_job_checkpoint", "memory_job_cancel", "memory_job_resume",
  "memory_job_sources", "memory_candidates_add", "memory_review_batch", "memory_publish_batch", "memory_export",
  "memory_backup", "memory_rebuild", "memory_restore",
] as const

export type RustOnlyCommand = (typeof RUST_ONLY_COMMANDS)[number]

/**
 * 未登记或不可复现的命令。`command` 字段单独存一份，方便场景用
 * `toMatchObject({ name: "UnsupportedInNodeError", command })` 断言，不靠正则抠文案。
 */
export class UnsupportedInNodeError extends Error {
  readonly command: string

  constructor(command: string) {
    super(
      `命令 ${command} 无法在 Node 适配层复现（它依赖 Rust 侧的安全基线或桌面能力）。` +
        `该场景属于 L4，请留在 test/e2e/。`,
    )
    this.name = "UnsupportedInNodeError"
    this.command = command
  }
}
