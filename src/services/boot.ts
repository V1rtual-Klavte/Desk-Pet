// ==========================================
// 窗口启动引导 —— 4 个前端入口共用
// 收敛启动序列：全局拦截 → 初始化 → 应用日志级别 → 挂载
// ==========================================

import type { Component } from "vue"
import { initPaths } from "@/services/paths"
import { initConfig, applyLogLevel } from "@/services/config"
import { createLogger } from "@/services/logger"
import { installGlobalHandlers, installVueErrorHandler, reportError } from "@/services/error"

const log = createLogger("Boot")

/**
 * 窗口入口共用的启动序列。
 *
 * 顺序是刻意的：全局拦截最先装 —— 这样 initPaths() / initConfig() 的失败
 * 也能被弹出来，而不是留下一片白屏（改造前正是如此）。
 */
export async function bootWindow(
  source: string,
  loadRoot: () => Promise<{ default: Component }>,
): Promise<void> {
  installGlobalHandlers(source)

  try {
    await initPaths()
    await initConfig()

    // 计算并应用生效级别（前端 + 推给 Rust），两端过滤保持一致
    const level = applyLogLevel()

    const { createApp } = await import("vue")
    const { default: Root } = await loadRoot()
    const app = createApp(Root)
    installVueErrorHandler(app, source)
    app.mount("#app")

    log.info(`窗口就绪: ${source} | 日志级别: ${level}`)
  } catch (e) {
    reportError(source, e, { kind: "启动失败", fatal: true })
  }
}
