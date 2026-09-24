// ==========================================
// /win open, /win close — Windows 模拟器控制
// ==========================================

import type { SlashCommand } from "../types"
import { invoke } from "@tauri-apps/api/core"

export const winCommands: SlashCommand[] = [
  {
    name: "win open",
    description: "打开 Windows 模拟器彩蛋",
    category: "easteregg" as const,
    // 只控制独立窗口，不涉及会话与运行状态。
    busyPolicy: "immediate",
    async execute() {
      // 失败不在这里吞：preprocessor 已把抛出的错误转成 log.error 与用户可见提示
      await invoke("open_windows_sim")
      return null
    },
  },
  {
    name: "win close",
    description: "关闭 Windows 模拟器",
    category: "easteregg" as const,
    busyPolicy: "immediate",
    async execute() {
      // 同上：处置链在 preprocessor 的 cmd.execute() catch 里
      await invoke("close_windows_sim")
      return null
    },
  },
]
