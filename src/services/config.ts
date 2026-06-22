// ==========================================
// 全局配置 —— 从根目录 CONFIG.yaml 加载
// 所有模块都应从此处读取配置，不自行定义常量
// 运行时用户设置通过 localStorage 持久化覆盖 CONFIG 默认值
// ==========================================

import rawConfig from "../../CONFIG.yaml";

interface UserSettings {
  popupMode: "cursor" | "fixed";
  fixedPosition: { x: number; y: number } | null;
  popupSize: { w: number; h: number };
  shortcutKey: string;
  shortcutMacModifiers: string[];
  shortcutWinModifiers: string[];
  /** 收到新消息时自动弹出窗口 */
  autoPopupOnMessage: boolean;
}

interface Config {
  mode: {
    assistant: boolean;
  };
  ai: {
    provider: string;
    endpoint: string;
    apiKey: string;
    model: string;
    contextMaxTokens: number;
    thinkingEffort: string;
    thinkingBudget: { low: number; medium: number; high: number };
    defaultSystemPrompt: string;
    fallbackReplies: string[];
  };
  personality: {
    enabled: boolean;
    active: string;
    cards: { id: string; name: string; path: string; description: string }[];
  };
  windowMonitor: {
    enabled: boolean;
    staySeconds: number;
    settleMs: number;
    cooldownSeconds: number;
    samePageCooldownSeconds: number;
    defaultCooldownMs: number;
    resumeExtraMs: number;
  };
  aiLock: {
    safetyTimeoutMs: number;
  };
  memory: {
    maxEntries: number;
  };
  desktop: {
    pollingIntervalMs: number;
    pauseExtraMs: number;
    waitTimeoutMs: number;
  };
  shortcut: {
    key: string;
    macModifiers: string[];
    winModifiers: string[];
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  loop: {
    maxRetry: number;
    maxToolCallsPerTurn: number;
    toolTimeoutMs: number;
    turnTimeoutMs: number;
    streamEnabled: boolean;
    contextCompactAt: number;
  };
  tools: {
    bash: {
      enabled: boolean;
      whitelist: string[];
    };
    file: {
      enabled: boolean;
      writeEnabled: boolean;
    };
    mcp: {
      enabled: boolean;
      servers: Record<string, unknown>[];
    };
    skill: {
      enabled: boolean;
    };
  };
  safety: {
    mode: string;
    sessionTrustEnabled: boolean;
  };
  user: UserSettings;
}

const cfg = rawConfig as Config;

// ==========================================
// 运行时用户配置（localStorage 持久化，覆盖 CONFIG.user 默认值）
// ==========================================
const STORAGE_KEY = "deskpet_user_settings";

const USER_DEFAULTS: UserSettings = {
  popupMode: cfg.user?.popupMode || "cursor",
  fixedPosition: null,
  popupSize: cfg.user?.popupSize || { w: 730, h: 450 },
  shortcutKey: cfg.user?.shortcutKey || cfg.shortcut?.key || "P",
  shortcutMacModifiers: cfg.user?.shortcutMacModifiers || cfg.shortcut?.macModifiers || ["Control", "Command"],
  shortcutWinModifiers: cfg.user?.shortcutWinModifiers || cfg.shortcut?.winModifiers || ["Control", "Alt"],
  autoPopupOnMessage: cfg.user?.autoPopupOnMessage ?? false,
};

function loadUserOverrides(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...USER_DEFAULTS, ...parsed };
    }
  } catch {}
  return { ...USER_DEFAULTS };
}

function saveUserOverrides(s: UserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

let _cache: UserSettings | null = null;

function getUser(): UserSettings {
  if (!_cache) _cache = loadUserOverrides();
  return _cache;
}

/** 清除用户设置缓存，强制下次 get 重新从 localStorage 读取（跨窗口同步用） */
export function refreshUserCache(): void {
  _cache = null;
  _overridesCache = null;
}

/** 运行时用户设置（可读写，持久化 localStorage） */

/** 获取弹窗尺寸：优先返回用户手动调整后持久化的尺寸，未调整过则回退 CONFIG.yaml 默认值 */
export function getDefaultSize(): { w: number; h: number } {
  return userConfig.popupSize;
}

export const userConfig = {
  get popupMode() { return getUser().popupMode; },
  set popupMode(v: "cursor" | "fixed") { const u = loadUserOverrides(); u.popupMode = v; _cache = u; saveUserOverrides(u); },
  get fixedPosition() { const p = getUser().fixedPosition; return (p && Math.abs(p.x) > 5000) ? null : (p && Math.abs(p.y) > 5000) ? null : p; },
  set fixedPosition(v: { x: number; y: number } | null) { const u = loadUserOverrides(); u.fixedPosition = v; _cache = u; saveUserOverrides(u); },
  get popupSize() { const sz = getUser().popupSize; return (!sz || sz.w > 2000 || sz.h > 2000 || sz.w < 50 || sz.h < 50) ? { w: 730, h: 450 } : sz; },
  set popupSize(v: { w: number; h: number }) { const u = loadUserOverrides(); u.popupSize = v; _cache = u; saveUserOverrides(u); },
  get shortcutKey() { return getUser().shortcutKey; },
  set shortcutKey(v: string) { const u = loadUserOverrides(); u.shortcutKey = v; _cache = u; saveUserOverrides(u); },
  get shortcutMacModifiers() { return getUser().shortcutMacModifiers; },
  set shortcutMacModifiers(v: string[]) { const u = loadUserOverrides(); u.shortcutMacModifiers = v; _cache = u; saveUserOverrides(u); },
  get shortcutWinModifiers() { return getUser().shortcutWinModifiers; },
  set shortcutWinModifiers(v: string[]) { const u = loadUserOverrides(); u.shortcutWinModifiers = v; _cache = u; saveUserOverrides(u); },
  get autoPopupOnMessage() { return getUser().autoPopupOnMessage; },
  set autoPopupOnMessage(v: boolean) { const u = loadUserOverrides(); u.autoPopupOnMessage = v; _cache = u; saveUserOverrides(u); },
  /** 获取所有值 */
  getAll(): UserSettings { return { ...getUser() }; },
  /** 批量保存 */
  setAll(s: Partial<UserSettings>) { const u = { ...loadUserOverrides(), ...s }; _cache = u; saveUserOverrides(u); },
  /** 重置为 CONFIG 默认值 */
  resetAll() { try { localStorage.removeItem(STORAGE_KEY); } catch {} _cache = null; },
};

// ==========================================
// 配置覆盖键（设置面板保存的全部覆盖 → localStorage）
// 用于重启后生效的编译时配置项
// ==========================================
const OVERRIDES_KEY = "deskpet_config_overrides";

let _overridesCache: Record<string, any> | null = null;

function getOverrides(): Record<string, any> {
  if (!_overridesCache) {
    try {
      _overridesCache = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}");
    } catch {
      _overridesCache = {};
    }
  }
  return _overridesCache!;
}

/** 获取某个 key 的运行时覆盖值（如果存在），否则返回 undefined */
export function getOverride<T>(key: string): T | undefined {
  const v = getOverrides()[key];
  return v !== undefined ? (v as T) : undefined;
}

/** 设置配置覆盖值 */
export function setOverride(key: string, value: any): void {
  const ov = getOverrides();
  ov[key] = value;
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(ov));
}

/** 批量设置覆盖值 */
export function setOverrides(map: Record<string, any>): void {
  const ov = getOverrides();
  Object.assign(ov, map);
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(ov));
}

/** 获取所有覆盖值 */
export function getAllOverrides(): Record<string, any> {
  return { ...getOverrides() };
}

/** 清除所有覆盖 */
export function clearOverrides(): void {
  localStorage.removeItem(OVERRIDES_KEY);
  _overridesCache = null;
}

// ── 辅助：从 override 或默认值获取 ──
function overrideOr<T>(key: string, fallback: T): T {
  const ov = getOverrides()[key];
  return ov !== undefined ? (ov as T) : fallback;
}

// ==========================================
// AI 配置
// ==========================================
const _ai = {
  get provider() { return overrideOr("ai.provider", cfg.ai.provider); },
  get endpoint() { return overrideOr("ai.endpoint", cfg.ai.endpoint || import.meta.env.VITE_API_ENDPOINT || ""); },
  get apiKey() { return overrideOr("ai.apiKey", cfg.ai.apiKey || import.meta.env.VITE_API_KEY || ""); },
  get model() { return overrideOr("ai.model", cfg.ai.model || import.meta.env.VITE_MODEL || "deepseek-chat"); },
  get contextMaxTokens() { return overrideOr("ai.contextMaxTokens", cfg.ai.contextMaxTokens ?? 16000); },
  get thinkingEffort() { return overrideOr("ai.thinkingEffort", cfg.ai.thinkingEffort || "auto") as import("@/services/agent/types").ThinkingEffort; },
  get thinkingBudget() {
    return {
      low: overrideOr("ai.thinkingBudget.low", cfg.ai.thinkingBudget?.low ?? 1000),
      medium: overrideOr("ai.thinkingBudget.medium", cfg.ai.thinkingBudget?.medium ?? 4000),
      high: overrideOr("ai.thinkingBudget.high", cfg.ai.thinkingBudget?.high ?? 16000),
    };
  },
  get defaultSystemPrompt() { return overrideOr("ai.defaultSystemPrompt", cfg.ai.defaultSystemPrompt || "你叫糖糖，是一个在直播的虚拟主播。"); },
  get fallbackReplies() { return overrideOr("ai.fallbackReplies", cfg.ai.fallbackReplies || ["嗯嗯～"]); },
  /** 是否已配置 API */
  get configured() { return Boolean(this.endpoint && this.apiKey); },
};
export const aiConfig = _ai;

// ==========================================
// 窗口监控配置
// ==========================================
export const windowMonitorConfig = {
  get enabled() { return overrideOr("windowMonitor.enabled", cfg.windowMonitor.enabled ?? true); },
  get staySeconds() { return overrideOr("windowMonitor.staySeconds", cfg.windowMonitor.staySeconds || 60); },
  get settleMs() { return overrideOr("windowMonitor.settleMs", cfg.windowMonitor.settleMs || 2000); },
  get cooldownSeconds() { return overrideOr("windowMonitor.cooldownSeconds", cfg.windowMonitor.cooldownSeconds || 5000); },
  get samePageCooldownSeconds() { return overrideOr("windowMonitor.samePageCooldownSeconds", cfg.windowMonitor.samePageCooldownSeconds || 7800); },
  get defaultCooldownMs() { return overrideOr("windowMonitor.defaultCooldownMs", cfg.windowMonitor.defaultCooldownMs || 12000); },
  get resumeExtraMs() { return overrideOr("windowMonitor.resumeExtraMs", cfg.windowMonitor.resumeExtraMs || 2000); },
};

// ==========================================
// AI 并发锁配置
// ==========================================
export const aiLockConfig = {
  get safetyTimeoutMs() { return overrideOr("aiLock.safetyTimeoutMs", cfg.aiLock.safetyTimeoutMs || 30000); },
};

// ==========================================
// 长期记忆配置
// ==========================================
export const memoryConfig = {
  get maxEntries() { return overrideOr("memory.maxEntries", cfg.memory.maxEntries || 200); },
};

// ==========================================
// 通知弹窗配置（已移除 — macOS 系统通知无法实现）
// 保留空壳避免引用报错，始终返回 false/0
// ==========================================
export const notificationConfig = {
  get enabled() { return false; },
  get autoCloseMs() { return 8000; },
};

// ==========================================
// 桌面后端配置（Rust 轮询参数）
// ==========================================
export const desktopConfig = {
  get pollingIntervalMs() { return overrideOr("desktop.pollingIntervalMs", cfg.desktop.pollingIntervalMs || 3000); },
  get pauseExtraMs() { return overrideOr("desktop.pauseExtraMs", cfg.desktop.pauseExtraMs || 5000); },
  get waitTimeoutMs() { return overrideOr("desktop.waitTimeoutMs", cfg.desktop.waitTimeoutMs || 5000); },
};

// ==========================================
// 快捷键配置
// ==========================================
export const shortcutConfig = {
  get key() { return overrideOr("shortcut.key", cfg.shortcut?.key || "P"); },
  get macModifiers() { return overrideOr("shortcut.macModifiers", cfg.shortcut?.macModifiers || ["Control", "Command"]); },
  get winModifiers() { return overrideOr("shortcut.winModifiers", cfg.shortcut?.winModifiers || ["Control", "Alt"]); },
};

// ==========================================
// 日志配置
// ==========================================
export const loggingConfig = {
  get level(): "debug" | "info" | "warn" | "error" {
    return overrideOr("logging.level", cfg.logging?.level || (import.meta.env.DEV ? "debug" : "info"));
  },
};

// ==========================================
// 人格配置
// ==========================================
export const personalityConfig = {
  get enabled() { return overrideOr("personality.enabled", cfg.personality?.enabled ?? true); },
  get active() { return overrideOr("personality.active", cfg.personality?.active || ""); },
  get cards() { return overrideOr("personality.cards", cfg.personality?.cards || []); },
};

// ==========================================
// 模式配置
// ==========================================
export const modeConfig = {
  get assistant() { return overrideOr("mode.assistant", cfg.mode?.assistant ?? false); },
};

// ==========================================
// Loop 配置
// ==========================================
export const loopConfig = {
  get maxRetry() { return overrideOr("loop.maxRetry", cfg.loop?.maxRetry ?? 3); },
  get maxToolCallsPerTurn() { return overrideOr("loop.maxToolCallsPerTurn", cfg.loop?.maxToolCallsPerTurn ?? 5); },
  get toolTimeoutMs() { return overrideOr("loop.toolTimeoutMs", cfg.loop?.toolTimeoutMs ?? 30000); },
  get turnTimeoutMs() { return overrideOr("loop.turnTimeoutMs", cfg.loop?.turnTimeoutMs ?? 120000); },
  get streamEnabled() { return overrideOr("loop.streamEnabled", cfg.loop?.streamEnabled ?? true); },
  get contextCompactAt() { return overrideOr("loop.contextCompactAt", cfg.loop?.contextCompactAt ?? 0.95); },
};

// ==========================================
// 工具系统配置
// ==========================================
export const toolsConfig = {
  get bashEnabled() { return overrideOr("tools.bash.enabled", cfg.tools?.bash?.enabled ?? true); },
  get bashWhitelist() { return overrideOr("tools.bash.whitelist", cfg.tools?.bash?.whitelist || ["ls", "cat", "head", "tail", "grep", "find", "which", "echo", "pwd", "date", "whoami", "uname", "df", "du", "ps"]); },
  get fileEnabled() { return overrideOr("tools.file.enabled", cfg.tools?.file?.enabled ?? true); },
  get fileWriteEnabled() { return modeConfig.assistant && (overrideOr("tools.file.writeEnabled", cfg.tools?.file?.writeEnabled ?? false)); },
  get mcpEnabled() { return modeConfig.assistant && (overrideOr("tools.mcp.enabled", cfg.tools?.mcp?.enabled ?? false)); },
  get mcpServers() { return overrideOr("tools.mcp.servers", cfg.tools?.mcp?.servers || []); },
  get skillEnabled() { return modeConfig.assistant && (overrideOr("tools.skill.enabled", cfg.tools?.skill?.enabled ?? false)); },
};

// ==========================================
// 安全配置
// ==========================================
export const safetyConfig = {
  get mode() { return overrideOr("safety.mode", cfg.safety?.mode || "tell_me"); },
  get sessionTrustEnabled() { return overrideOr("safety.sessionTrustEnabled", cfg.safety?.sessionTrustEnabled ?? true); },
};
if (import.meta.env.DEV) {
  console.log("[Config] 已加载 CONFIG.yaml | AI:", aiConfig.provider, "| endpoint:", aiConfig.endpoint);
}
