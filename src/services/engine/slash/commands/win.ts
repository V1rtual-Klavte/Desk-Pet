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
    async execute() {
      await invoke("open_windows_sim").catch(() => {})
      return null
    },
  },
  {
    name: "win close",
    description: "关闭 Windows 模拟器",
    category: "easteregg" as const,
    async execute() {
      await invoke("close_windows_sim").catch(() => {})
      return null
    },
  },
]
