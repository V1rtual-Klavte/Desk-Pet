// ==========================================
// 本地工具：运行环境 (SAFE)
// 获取 OS / 架构 / CPU 核数 / 内存 / bash 默认工作目录
//
// 两类来源分工固定：OS、架构、核数与三个内存口径都来自 Rust `system_info`；
// bash 默认工作目录来自 TS 侧的 `TauriExecutionEnv.defaultCwd()`（bash 工具本身也取这一处），
// 不往 Rust 载荷里加第二个 cwd 定义点。
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { TauriExecutionEnv } from "../pi/tauri-execution-env"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolSys")

const BYTES_PER_GB = 1024 * 1024 * 1024

const systemTool: ToolDef = defineTool({
  id: "local-system-info",
  name: "system_info",
  description: "获取当前运行环境：操作系统、平台架构、CPU 核心数、内存（总量、已用、可用）以及 bash 的默认工作目录。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  actionCategory: "os.info",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async () => {
  try {
    const info = await invoke<{
      os: string; arch: string; cpuCount: number;
      memTotal: number; memUsed: number; memAvailable: number;
    }>("system_info")
    const cwd = await TauriExecutionEnv.defaultCwd()

    const gb = (bytes: number) => (bytes / BYTES_PER_GB).toFixed(1)
    const memPercent = info.memTotal > 0
      ? ((info.memUsed / info.memTotal) * 100).toFixed(1)
      : "?"

    const text = [
      `操作系统: ${info.os}`,
      `架构: ${info.arch}`,
      `CPU 核心数: ${info.cpuCount}`,
      `内存: 已用 ${gb(info.memUsed)}GB / 总 ${gb(info.memTotal)}GB (${memPercent}%)，可用 ${gb(info.memAvailable)}GB`,
      `bash 默认工作目录: ${cwd}`,
    ].join("\n")

    return { success: true, content: text }
  } catch (e) {
    const msg = formatError(e)
    return { success: false, content: "", error: msg }
  }
})

export function registerSystemTool(): void {
  register(systemTool)
  log.info("系统工具已注册 (os.info)")
}
