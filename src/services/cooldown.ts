// ==========================================
// 统一全局冷却控制器
// 所有触发源（regex / AI / future）共享同一冷却状态
// ==========================================

/** 冷却时长（毫秒），由外部配置 */
let cooldownMs = 12000;

/** 全局冷却截止时间戳 */
let globalCooldownUntil = 0;

/** 设置冷却时长 */
export function setCooldown(seconds: number): void {
  cooldownMs = seconds * 1000;
}

/** 获取当前冷却时长（秒） */
export function getCooldownSeconds(): number {
  return cooldownMs / 1000;
}

/** 是否正在冷却 */
export function isCoolingDown(): boolean {
  return Date.now() < globalCooldownUntil;
}

/** 剩余冷却时间（秒），0 表示不在冷却 */
export function remainingSeconds(): number {
  const remain = globalCooldownUntil - Date.now();
  return remain > 0 ? Math.ceil(remain / 1000) : 0;
}

/** 触发冷却 */
export function triggerCooldown(msOverride?: number): void {
  globalCooldownUntil = Date.now() + (msOverride ?? cooldownMs);
}

/** 重置冷却（测试用） */
export function resetCooldown(): void {
  globalCooldownUntil = 0;
}

// ── AI 生成并发锁（防止异步 AI 调用期间重复触发） ──
let aiGenerating = false;

export function isAIGenerating(): boolean {
  return aiGenerating;
}

export function setAIGenerating(v: boolean): void {
  aiGenerating = v;
}

// 暴露到 window 方便 F12 调试
if (typeof window !== "undefined") {
  (window as any).__cooldown = { isCoolingDown, remainingSeconds, triggerCooldown, resetCooldown, getCooldownSeconds, setCooldown };
}
