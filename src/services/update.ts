import { check } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { getActiveSessionId, pushSystemMessage } from "@/services/session"
import { confirmDialog } from "@/services/dialog"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Update")

/** 启动后延迟检查的等待时间：避开启动竞争与首屏渲染。 */
const UPDATE_CHECK_DELAY_MS = 30_000

/** 可注入的上游端口：生产是 Tauri 插件，测试注入假实现。 */
export interface UpdatePort {
  version: string
  downloadAndInstall: () => Promise<void>
}

export interface UpdatePortFactory {
  check: () => Promise<UpdatePort | null>
  relaunch: () => Promise<void>
}

const defaultFactory: UpdatePortFactory = {
  check: async () => {
    const update = await check()
    if (!update) return null
    return { version: update.version, downloadAndInstall: () => update.downloadAndInstall() }
  },
  relaunch,
}

let factory: UpdatePortFactory = defaultFactory
let started = false
let prompted = false

/** 测试注入；传 null 复位。会一并重置调度与「本次启动已提示」标记。 */
export function __setUpdatePortForTest(next: UpdatePortFactory | null): void {
  factory = next ?? defaultFactory
  started = false
  prompted = false
}

/**
 * 检查并询问是否更新。返回：
 *   none    没有新版本（或本次启动已经提示过）
 *   skipped 用户选了「稍后」
 *   updated 已下载安装并触发重启
 *   failed  检查或安装抛错（已记日志，不打扰用户）
 */
export async function checkForUpdate(): Promise<"none" | "skipped" | "updated" | "failed"> {
  if (prompted) return "none"
  try {
    const update = await factory.check()
    if (!update) return "none"

    prompted = true

    // 中性系统消息：更新是系统事件，不用角色口吻（AGENTS.md 的通用文案约束）
    pushSystemMessage(`发现新版本 v${update.version}，可下载并安装更新`, getActiveSessionId())

    const accepted = await confirmDialog(`发现新版本 v${update.version}`, {
      title: "软件更新",
      okLabel: "下载并安装",
      // 正常可用的更新不是故障，显式关掉危险样式（confirmDialog 不传 danger 时默认按 error + 危险按钮渲染）
      danger: false,
    })
    if (!accepted) return "skipped"

    await update.downloadAndInstall()
    await factory.relaunch()
    return "updated"
  } catch (error) {
    log.warn("检查更新失败:", formatError(error))
    return "failed"
  }
}

/** 启动链调用：延迟检查一次；同一进程内重复调用无效。 */
export function startUpdateCheck(options: { delayMs?: number } = {}): void {
  if (started) return
  started = true
  const delay = options.delayMs ?? UPDATE_CHECK_DELAY_MS
  setTimeout(() => { void checkForUpdate() }, delay)
}
