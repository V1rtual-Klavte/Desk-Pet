// ==========================================
// 本地工具：系统信息 (SAFE)
// 获取 OS / CPU / 内存 / 运行时间
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolSys")

const systemTool: ToolDef = {
  id: "local-system-info",
  name: "system_info",
  description: "获取当前系统信息：操作系统、CPU核心数、总内存、已用内存、平台架构。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  personalityHint: {
    executing: "检查一下电脑状态...",
    done: "嗯嗯了解了～",
  },
  async handler() {
    try {
      const info = await invoke<{
        os: string; arch: string; cpuCount: number;
        memTotal: number; memUsed: number;
      }>("system_info")

      const memTotalGB = (info.memTotal / (1024 * 1024 * 1024)).toFixed(1)
      const memUsedGB = (info.memUsed / (1024 * 1024 * 1024)).toFixed(1)
      const memPercent = info.memTotal > 0
        ? ((info.memUsed / info.memTotal) * 100).toFixed(1)
        : "?"

      const text = [
        `操作系统: ${info.os}`,
        `架构: ${info.arch}`,
        `CPU 核心数: ${info.cpuCount}`,
        `内存: ${memUsedGB}GB / ${memTotalGB}GB (${memPercent}%)`,
      ].join("\n")

      return { success: true, content: text }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

export function registerSystemTool(): void {
  register(systemTool)
  log.info("系统工具已注册 (system.info)")
}
