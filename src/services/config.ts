// ==========================================
// 全局配置 —— 从根目录 CONFIG.yaml 加载
// 所有模块都应从此处读取配置，不自行定义常量
// 运行时用户设置通过 localStorage 持久化覆盖 CONFIG 默认值
// ==========================================

import rawConfig from "../../CONFIG.yaml";
import type { ParallaxLayerCfg } from "@/composables/useParallax";
import { DEFAULT_LAYERS } from "@/composables/useParallax";

// ── 类型定义 ──

interface UserSettings {
  popupMode: "cursor" | "fixed";
  fixedPosition: { x: number; y: number } | null;
  popupSize: { w: number; h: number };
  shortcutKey: string;
  shortcutMacModifiers: string[];
  shortcutWinModifiers: string[];
  autoPopupOnMessage: boolean;
  parallaxEnabled: boolean;
  parallaxIntensity: number;
  parallaxLayers: ParallaxLayerCfg[];
}

export interface BuiltinMcpServer {
  enabled: boolean
  command: string
  args: string[]
  env?: Record<string, string>
  description?: string
}

interface Config {
  general: {
    mode: { assistant: boolean }
    popup: {
      mode: "cursor" | "fixed"
      autoPopupOnMessage: boolean
      defaultSize: { w: number; h: number }
    }
    shortcut: {
      key: string
      macModifiers: string[]
      winModifiers: string[]
    }
    logging: { level: "debug" | "info" | "warn" | "error" }
    desktop: {
      pollingIntervalMs: number
      pauseExtraMs: number
      waitTimeoutMs: number
    }
  }
  ai: {
    provider: string
    endpoint: string
    apiKey: string
    requireApiKey: boolean
    model: string
    contextMaxTokens: number
    thinking: {
      effort: string
      budget: { low: number; medium: number; high: number }
    }
    personality: {
      active: string
      cards: { id: string; name: string; path: string; description: string }[]
    }
    loop: {
      maxRetry: number
      maxToolCallsPerTurn: number
      toolTimeoutMs: number
      turnTimeoutMs: number
      contextCompactAt: number
      dedupWindowMs: number
      maxVisibleMessages: number
    }
    memory: { maxEntries: number; maxSessions: number }
    plan: {
      enabled: boolean
      complexityThreshold: number
      maxSteps: number
      stepTimeoutMs: number
      stepMaxRounds: number
      thinkingEffort: string
      stepThinkingEffort: string
      onStepFailure: string
      keywords: string[]
    }
    lock: { safetyTimeoutMs: number }
    windowMonitor: {
      enabled: boolean
      staySeconds: number
      settleMs: number
      cooldownSeconds: number
      samePageCooldownSeconds: number
      defaultCooldownMs: number
      resumeExtraMs: number
    }
    safety: { mode: string; sessionTrustEnabled: boolean }
  }
  tools: {
    bash: { enabled: boolean; whitelist: string[] }
    file: { enabled: boolean; writeEnabled: boolean }
    mcp: {
      enabled: boolean
      servers: Record<string, unknown>[]
      builtin: Record<string, BuiltinMcpServer>
    }
    skill: { enabled: boolean; skills: { raw: string }[] }
  }
  appearance: {
    activeProfile: string
  }
}

const cfg = rawConfig as Config;

// ==========================================
// 运行时用户配置（localStorage 持久化）
// ==========================================
const STORAGE_KEY = "deskpet_user_settings";

const USER_DEFAULTS: UserSettings = {
  popupMode: cfg.general?.popup?.mode || "cursor",
  fixedPosition: null,
  popupSize: cfg.general?.popup?.defaultSize || { w: 730, h: 450 },
  shortcutKey: cfg.general?.shortcut?.key || "P",
  shortcutMacModifiers: cfg.general?.shortcut?.macModifiers || ["Control", "Command"],
  shortcutWinModifiers: cfg.general?.shortcut?.winModifiers || ["Control", "Alt"],
  autoPopupOnMessage: cfg.general?.popup?.autoPopupOnMessage ?? false,
  parallaxEnabled: false,
  parallaxIntensity: 1.0,
  parallaxLayers: DEFAULT_LAYERS.map(l => ({ ...l })),
};

function loadUserOverrides(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...USER_DEFAULTS, ...parsed };
    }
  } catch (e) {
    console.warn("[Config] localStorage 数据损坏，回退默认值", e instanceof Error ? e.message : String(e))
  }
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

export function refreshUserCache(): void {
  _cache = null;
  _overridesCache = null;
}

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
  get parallaxEnabled() { return getUser().parallaxEnabled; },
  set parallaxEnabled(v: boolean) { const u = loadUserOverrides(); u.parallaxEnabled = v; _cache = u; saveUserOverrides(u); },
  get parallaxIntensity() { return getUser().parallaxIntensity; },
  set parallaxIntensity(v: number) { const u = loadUserOverrides(); u.parallaxIntensity = v; _cache = u; saveUserOverrides(u); },
  get parallaxLayers() { return getUser().parallaxLayers; },
  set parallaxLayers(v: ParallaxLayerCfg[]) { const u = loadUserOverrides(); u.parallaxLayers = v; _cache = u; saveUserOverrides(u); },
  getAll(): UserSettings { return { ...getUser() }; },
  setAll(s: Partial<UserSettings>) { const u = { ...loadUserOverrides(), ...s }; _cache = u; saveUserOverrides(u); },
  resetAll() { try { localStorage.removeItem(STORAGE_KEY); } catch {} _cache = null; },
};

// ==========================================
// 配置覆盖（设置面板保存的全部覆盖 → localStorage）
// ==========================================
const OVERRIDES_KEY = "deskpet_config_overrides";

// ★ 旧配置 key 迁移映射
const KEY_MIGRATION: Record<string, string> = {
  "mode.assistant":                    "general.mode.assistant",
  "personality.active":                "ai.personality.active",
  "windowMonitor.enabled":             "ai.windowMonitor.enabled",
  "windowMonitor.staySeconds":         "ai.windowMonitor.staySeconds",
  "windowMonitor.settleMs":            "ai.windowMonitor.settleMs",
  "windowMonitor.cooldownSeconds":     "ai.windowMonitor.cooldownSeconds",
  "windowMonitor.samePageCooldownSeconds": "ai.windowMonitor.samePageCooldownSeconds",
  "aiLock.safetyTimeoutMs":            "ai.lock.safetyTimeoutMs",
  "memory.maxEntries":                 "ai.memory.maxEntries",
  "desktop.pollingIntervalMs":         "general.desktop.pollingIntervalMs",
  "desktop.pauseExtraMs":              "general.desktop.pauseExtraMs",
  "desktop.waitTimeoutMs":             "general.desktop.waitTimeoutMs",
  "logging.level":                     "general.logging.level",
  "safety.mode":                       "ai.safety.mode",
  "safety.sessionTrustEnabled":        "ai.safety.sessionTrustEnabled",
};

let _overridesCache: Record<string, any> | null = null;
let _migrationDone = false;

function getOverrides(): Record<string, any> {
  if (!_overridesCache) {
    try {
      const raw = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}");
      // ★ 自动迁移旧 key → 新 key
      if (!_migrationDone) {
        let migrated = false;
        for (const [oldKey, newKey] of Object.entries(KEY_MIGRATION)) {
          if (raw[oldKey] !== undefined && raw[newKey] === undefined) {
            raw[newKey] = raw[oldKey];
            delete raw[oldKey];
            migrated = true;
          }
        }
        if (migrated) {
          localStorage.setItem(OVERRIDES_KEY, JSON.stringify(raw));
        }
        _migrationDone = true;
      }
      _overridesCache = raw;
    } catch {
      _overridesCache = {};
    }
  }
  return _overridesCache!;
}

export function getOverride<T>(key: string): T | undefined {
  const v = getOverrides()[key];
  return v !== undefined ? (v as T) : undefined;
}

export function setOverride(key: string, value: any): void {
  const ov = getOverrides();
  ov[key] = value;
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(ov));
}

export function setOverrides(map: Record<string, any>): void {
  const ov = getOverrides();
  Object.assign(ov, map);
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(ov));
}

export function getAllOverrides(): Record<string, any> {
  return { ...getOverrides() };
}

export function clearOverrides(): void {
  localStorage.removeItem(OVERRIDES_KEY);
  _overridesCache = null;
  _migrationDone = false;
}

function overrideOr<T>(key: string, fallback: T): T {
  const ov = getOverrides()[key];
  return ov !== undefined ? (ov as T) : fallback;
}

// ══════════════════════════════════════════
// 1. 通用配置 (General)
// ══════════════════════════════════════════
export const generalConfig = {
  get assistantMode() { return overrideOr("general.mode.assistant", cfg.general?.mode?.assistant ?? false); },
  get popupMode() { return overrideOr("general.popup.mode", cfg.general?.popup?.mode ?? "cursor") as "cursor" | "fixed"; },
  get autoPopupOnMessage() { return overrideOr("general.popup.autoPopupOnMessage", cfg.general?.popup?.autoPopupOnMessage ?? false); },
  get defaultPopupSize() { return overrideOr("general.popup.defaultSize", cfg.general?.popup?.defaultSize ?? { w: 730, h: 450 }); },
  get shortcutKey() { return overrideOr("general.shortcut.key", cfg.general?.shortcut?.key ?? "P"); },
  get shortcutMacModifiers() { return overrideOr("general.shortcut.macModifiers", cfg.general?.shortcut?.macModifiers ?? ["Control", "Command"]); },
  get shortcutWinModifiers() { return overrideOr("general.shortcut.winModifiers", cfg.general?.shortcut?.winModifiers ?? ["Control", "Alt"]); },
  get loggingLevel() { return overrideOr("general.logging.level", cfg.general?.logging?.level ?? (import.meta.env.DEV ? "debug" : "info")) as "debug" | "info" | "warn" | "error"; },
  get pollingIntervalMs() { return overrideOr("general.desktop.pollingIntervalMs", cfg.general?.desktop?.pollingIntervalMs ?? 3000); },
  get pauseExtraMs() { return overrideOr("general.desktop.pauseExtraMs", cfg.general?.desktop?.pauseExtraMs ?? 5000); },
  get waitTimeoutMs() { return overrideOr("general.desktop.waitTimeoutMs", cfg.general?.desktop?.waitTimeoutMs ?? 5000); },
};

export const shortcutConfig = {
  get key() { return generalConfig.shortcutKey; },
  get macModifiers() { return generalConfig.shortcutMacModifiers; },
  get winModifiers() { return generalConfig.shortcutWinModifiers; },
};

export const loggingConfig = {
  get level() { return generalConfig.loggingLevel; },
};

export const desktopConfig = {
  get pollingIntervalMs() { return generalConfig.pollingIntervalMs; },
  get pauseExtraMs() { return generalConfig.pauseExtraMs; },
  get waitTimeoutMs() { return generalConfig.waitTimeoutMs; },
};

// ══════════════════════════════════════════
// 2. AI 配置
// ══════════════════════════════════════════
const _ai = {
  get provider() { return overrideOr("ai.provider", cfg.ai?.provider ?? "deepseek"); },
  get endpoint() { return overrideOr("ai.endpoint", cfg.ai?.endpoint || import.meta.env.VITE_API_ENDPOINT || ""); },
  get apiKey() { return overrideOr("ai.apiKey", cfg.ai?.apiKey || import.meta.env.VITE_API_KEY || ""); },
  get model() { return overrideOr("ai.model", cfg.ai?.model || import.meta.env.VITE_MODEL || "deepseek-chat"); },
  get contextMaxTokens() { return overrideOr("ai.contextMaxTokens", cfg.ai?.contextMaxTokens ?? 16000); },
  get thinkingEffort() { return overrideOr("ai.thinking.effort", cfg.ai?.thinking?.effort || "auto") as import("@/services/agent/types").ThinkingEffort; },
  get requireApiKey() { return overrideOr("ai.requireApiKey", cfg.ai?.requireApiKey ?? true); },
  get thinkingBudget() {
    try {
      return {
        low: overrideOr("ai.thinking.budget.low", cfg.ai?.thinking?.budget?.low ?? 1000),
        medium: overrideOr("ai.thinking.budget.medium", cfg.ai?.thinking?.budget?.medium ?? 4000),
        high: overrideOr("ai.thinking.budget.high", cfg.ai?.thinking?.budget?.high ?? 16000),
      }
    } catch (e) {
      console.warn("config 键缺失，回退默认值", e instanceof Error ? e.message : String(e))
      return { low: 1000, medium: 4000, high: 16000 }
    }
  },
  get configured() { if (!this.endpoint) return false; if (!this.requireApiKey) return true; return Boolean(this.apiKey); },
};

export const aiConfig = _ai;

export const personalityConfig = {
  get active() { return overrideOr("ai.personality.active", cfg.ai?.personality?.active || ""); },
  get cards() { return overrideOr("ai.personality.cards", cfg.ai?.personality?.cards || []); },
};

export const windowMonitorConfig = {
  get enabled() { return overrideOr("ai.windowMonitor.enabled", cfg.ai?.windowMonitor?.enabled ?? true); },
  get staySeconds() { return overrideOr("ai.windowMonitor.staySeconds", cfg.ai?.windowMonitor?.staySeconds || 60); },
  get settleMs() { return overrideOr("ai.windowMonitor.settleMs", cfg.ai?.windowMonitor?.settleMs || 2000); },
  get cooldownSeconds() { return overrideOr("ai.windowMonitor.cooldownSeconds", cfg.ai?.windowMonitor?.cooldownSeconds || 5000); },
  get samePageCooldownSeconds() { return overrideOr("ai.windowMonitor.samePageCooldownSeconds", cfg.ai?.windowMonitor?.samePageCooldownSeconds || 7800); },
  get defaultCooldownMs() { return overrideOr("ai.windowMonitor.defaultCooldownMs", cfg.ai?.windowMonitor?.defaultCooldownMs || 12000); },
  get resumeExtraMs() { return overrideOr("ai.windowMonitor.resumeExtraMs", cfg.ai?.windowMonitor?.resumeExtraMs || 2000); },
};

export const aiLockConfig = {
  get safetyTimeoutMs() { return overrideOr("ai.lock.safetyTimeoutMs", cfg.ai?.lock?.safetyTimeoutMs || 30000); },
};

export const memoryConfig = {
  get maxEntries() { return overrideOr("ai.memory.maxEntries", cfg.ai?.memory?.maxEntries || 200); },
  get maxSessions() { return overrideOr("ai.memory.maxSessions", cfg.ai?.memory?.maxSessions ?? 20); },
};

export const planConfig = {
  get enabled() { return overrideOr("ai.plan.enabled", cfg.ai?.plan?.enabled ?? true); },
  get complexityThreshold() { return overrideOr("ai.plan.complexityThreshold", cfg.ai?.plan?.complexityThreshold ?? 3); },
  get maxSteps() { return overrideOr("ai.plan.maxSteps", cfg.ai?.plan?.maxSteps ?? 8); },
  get stepTimeoutMs() { return overrideOr("ai.plan.stepTimeoutMs", cfg.ai?.plan?.stepTimeoutMs ?? 90000); },
  get stepMaxRounds() { return overrideOr("ai.plan.stepMaxRounds", cfg.ai?.plan?.stepMaxRounds ?? 5); },
  get thinkingEffort() { return overrideOr("ai.plan.thinkingEffort", cfg.ai?.plan?.thinkingEffort || "medium") as import("@/services/agent/types").ThinkingEffort; },
  get stepThinkingEffort() { return overrideOr("ai.plan.stepThinkingEffort", cfg.ai?.plan?.stepThinkingEffort || "low") as import("@/services/agent/types").ThinkingEffort; },
  get onStepFailure() { return overrideOr("ai.plan.onStepFailure", cfg.ai?.plan?.onStepFailure || "continue") as "continue" | "abort" | "ask"; },
  get keywords() { return overrideOr("ai.plan.keywords", cfg.ai?.plan?.keywords || ["分析", "整理", "重构", "修复", "审查", "合并", "总结", "生成", "创建项目"]) as string[]; },
};

export const loopConfig = {
  get maxRetry() { return overrideOr("ai.loop.maxRetry", cfg.ai?.loop?.maxRetry ?? 3); },
  get maxToolCallsPerTurn() { return overrideOr("ai.loop.maxToolCallsPerTurn", cfg.ai?.loop?.maxToolCallsPerTurn ?? 5); },
  get toolTimeoutMs() { return overrideOr("ai.loop.toolTimeoutMs", cfg.ai?.loop?.toolTimeoutMs ?? 30000); },
  get turnTimeoutMs() { return overrideOr("ai.loop.turnTimeoutMs", cfg.ai?.loop?.turnTimeoutMs ?? 120000); },
  get contextCompactAt() { return overrideOr("ai.loop.contextCompactAt", cfg.ai?.loop?.contextCompactAt ?? 0.95); },
  get dedupWindowMs() { return overrideOr("ai.loop.dedupWindowMs", cfg.ai?.loop?.dedupWindowMs ?? 30000); },
  get maxVisibleMessages() { return overrideOr("ai.loop.maxVisibleMessages", cfg.ai?.loop?.maxVisibleMessages ?? 200); },
};

export const safetyConfig = {
  get mode() { return overrideOr("ai.safety.mode", cfg.ai?.safety?.mode || "tell_me"); },
  get sessionTrustEnabled() { return overrideOr("ai.safety.sessionTrustEnabled", cfg.ai?.safety?.sessionTrustEnabled ?? true); },
};

// ══════════════════════════════════════════
// 3. 工具配置
// ══════════════════════════════════════════
export const toolsConfig = {
  get bashEnabled() { return overrideOr("tools.bash.enabled", cfg.tools?.bash?.enabled ?? true); },
  get bashWhitelist() { return overrideOr("tools.bash.whitelist", cfg.tools?.bash?.whitelist || ["ls", "cat", "head", "tail", "grep", "find", "which", "echo", "pwd", "date", "whoami", "uname", "df", "du", "ps"]); },
  get fileEnabled() { return overrideOr("tools.file.enabled", cfg.tools?.file?.enabled ?? true); },
  get fileWriteEnabled() { return generalConfig.assistantMode && (overrideOr("tools.file.writeEnabled", cfg.tools?.file?.writeEnabled ?? false)); },
  get mcpEnabled() { return generalConfig.assistantMode && (overrideOr("tools.mcp.enabled", cfg.tools?.mcp?.enabled ?? false)); },
  get mcpServers() { return overrideOr("tools.mcp.servers", cfg.tools?.mcp?.servers || []); },
  get builtinMcpServers() { return overrideOr("tools.mcp.builtin", cfg.tools?.mcp?.builtin || {}) as Record<string, BuiltinMcpServer>; },
  get skillEnabled() { return generalConfig.assistantMode && (overrideOr("tools.skill.enabled", cfg.tools?.skill?.enabled ?? false)); },
  get skillSkills() { return overrideOr("tools.skill.skills", cfg.tools?.skill?.skills || []) as { raw: string }[]; },
};

// ══════════════════════════════════════════
// 4. 外观 — Profile 系统
// 主题/角色/音效由 Profile 管理 (public/profiles/)
// ==========================================
export const appearanceConfig = {
  get activeProfile() { return overrideOr("appearance.activeProfile", cfg.appearance?.activeProfile || "sugar-pink"); },
};

// ══════════════════════════════════════════
// 开发时日志
// ══════════════════════════════════════════
if (import.meta.env.DEV) {
  console.log("[Config] 已加载 CONFIG.yaml | AI:", aiConfig.provider, "| endpoint:", aiConfig.endpoint);
}
