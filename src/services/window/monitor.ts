// ==========================================
// 窗口停留计时 + 统一冷却触发
// ==========================================

import { invoke } from "@tauri-apps/api/core";
import { isCoolingDown, isAIGenerating, triggerCooldown, setCooldown, getCooldownSeconds } from "@/services/cooldown";
import { windowMonitorConfig } from "@/services/config";
import { createLogger } from "@/services/logger";

const log = createLogger("WinMon");

const STAY_SECONDS = windowMonitorConfig.staySeconds;
const SETTLE_MS = windowMonitorConfig.settleMs;
const COOLDOWN_SECONDS = windowMonitorConfig.cooldownSeconds;
const RESUME_EXTRA_MS = windowMonitorConfig.resumeExtraMs;
export const SAME_PAGE_COOLDOWN_SECONDS = windowMonitorConfig.samePageCooldownSeconds;

let currentWindowTitle = "";
let stayStartTime = 0;
let pendingTitle = "";
let pendingTime = 0;

setCooldown(COOLDOWN_SECONDS);

export interface TriggerResult {
  source: "regex" | "ai";
  message: string;
}

export function checkWindowTiming(title: string): boolean {
  if (title !== currentWindowTitle) {
    if (title !== pendingTitle) { pendingTitle = title; pendingTime = Date.now(); return false; }
    if (Date.now() - pendingTime >= SETTLE_MS) {
      currentWindowTitle = pendingTitle;
      stayStartTime = Date.now();
      pendingTitle = "";
    }
    return false;
  }
  const elapsed = (Date.now() - stayStartTime) / 1000;
  log.debug("停留:", currentWindowTitle.substring(0, 40), "|", elapsed.toFixed(1) + "s /", STAY_SECONDS + "s");
  if (elapsed < STAY_SECONDS) return false;
  if (isCoolingDown()) { log.debug("跳过：全局冷却中"); return false; }
  if (isAIGenerating()) { log.debug("跳过：AI 生成中（锁占用）"); return false; }
  stayStartTime = Date.now();
  return true;
}

export function processTrigger(result: TriggerResult): void {
  triggerCooldown();
  const s = getCooldownSeconds();
  invoke("pause_monitor", { durationMs: s * 1000 }).catch(() => {});
  setTimeout(() => invoke("resume_monitor").catch(() => {}), s * 1000 + RESUME_EXTRA_MS);
  log.info("source:", result.source, "→ 全局冷却:", s + "s");
}
