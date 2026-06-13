// ==========================================
// 窗口停留计时 + 统一冷却触发
// ==========================================

import { invoke } from "@tauri-apps/api/core";
import { isCoolingDown, isAIGenerating, triggerCooldown, setCooldown, getCooldownSeconds } from "./cooldown";

const STAY_SECONDS = 60;
const SETTLE_MS = 2000;
const COOLDOWN_SECONDS = 5000;
export const SAME_PAGE_COOLDOWN_SECONDS = 7800;

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
  console.log("[计时] 停留:", currentWindowTitle.substring(0, 40), "|", elapsed.toFixed(1) + "s /", STAY_SECONDS + "s");
  if (elapsed < STAY_SECONDS) return false;
  if (isCoolingDown()) return false;
  if (isAIGenerating()) return false;
  stayStartTime = Date.now();
  return true;
}

export function processTrigger(result: TriggerResult): void {
  triggerCooldown();
  const s = getCooldownSeconds();
  invoke("pause_monitor", { durationMs: s * 1000 }).catch(() => {});
  setTimeout(() => invoke("resume_monitor").catch(() => {}), s * 1000 + 2000);
  console.log("[触发] source:", result.source, "→ 全局冷却:", s + "s");
}
