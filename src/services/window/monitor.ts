// ==========================================
// 窗口停留计时 + 统一冷却触发
// ==========================================

import { invoke } from "@tauri-apps/api/core";
import { isCoolingDown, isAIGenerating, triggerCooldown, setCooldown, getCooldownSeconds } from "@/services/cooldown";
import { windowMonitorConfig } from "@/services/config";
import { createLogger } from "@/services/logger";

const log = createLogger("WinMon");

let currentWindowTitle = "";
let stayStartTime = 0;
let pendingTitle = "";
let pendingTime = 0;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

setCooldown(windowMonitorConfig.cooldownSeconds);

export interface TriggerResult {
  source: "regex" | "ai";
  message: string;
}

export function checkWindowTiming(title: string): boolean {
  // 每次运行时读取最新配置值（防止模块级 const 缓存在覆盖值更新后不生效）
  const staySeconds = windowMonitorConfig.staySeconds;
  const settleMs = windowMonitorConfig.settleMs;
  const cooldownSeconds = windowMonitorConfig.cooldownSeconds;
  const samePageCooldownSeconds = windowMonitorConfig.samePageCooldownSeconds;
  const resumeExtraMs = windowMonitorConfig.resumeExtraMs;

  // 更新全局冷却时长为最新配置值
  setCooldown(cooldownSeconds);

  if (title !== currentWindowTitle) {
    if (title !== pendingTitle) { pendingTitle = title; pendingTime = Date.now(); return false; }
    if (Date.now() - pendingTime >= settleMs) {
      currentWindowTitle = pendingTitle;
      stayStartTime = Date.now();
      pendingTitle = "";
    }
    return false;
  }
  const elapsed = (Date.now() - stayStartTime) / 1000;
  log.debug("停留:", currentWindowTitle.substring(0, 40), "|", elapsed.toFixed(1) + "s /", staySeconds + "s");
  if (elapsed < staySeconds) return false;
  if (isCoolingDown()) { log.debug("跳过：全局冷却中"); return false; }
  if (isAIGenerating()) { log.debug("跳过：AI 生成中（锁占用）"); return false; }
  stayStartTime = Date.now();
  return true;
}

export function processTrigger(result: TriggerResult): void {
  // 触发后重置停留计时 + 当前窗口标题，防止冷却结束立即再次触发同一页面
  // reset currentWindowTitle → 同标题会走 settle 流程重新计时
  stayStartTime = Date.now();
  currentWindowTitle = "";
  pendingTitle = "";
  triggerCooldown();
  const s = getCooldownSeconds();
  const resumeExtraMs = windowMonitorConfig.resumeExtraMs;
  invoke("pause_monitor", { durationMs: s * 1000 }).catch(() => {});
  cooldownTimer = setTimeout(() => invoke("resume_monitor").catch(() => {}), s * 1000 + resumeExtraMs);
  log.info("source:", result.source, "→ 全局冷却:", s + "s");
}

/** 停止监控并清理定时器 */
export function stopMonitor(): void {
  if (cooldownTimer) {
    clearTimeout(cooldownTimer)
    cooldownTimer = null
  }
}
