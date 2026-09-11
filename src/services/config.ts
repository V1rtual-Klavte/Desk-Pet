// ==========================================
// 全局配置 —— 启动时从 AppPaths.config_file 加载
// 所有模块都应从此处读取配置，不自行定义常量
// 设置修改直接回写该 CONFIG 文件，不再使用 localStorage 作为配置层
// ==========================================

import rawConfig from "../../CONFIG.yaml";
import { invoke } from "@tauri-apps/api/core";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import type { ParallaxLayerCfg } from "@/composables/useParallax";
import { DEFAULT_LAYERS } from "@/composables/useParallax";
import { createLogger, LEVELS, LEVEL_ORDER, setLogLevel, type Level } from "@/services/logger";
import { formatError } from "@/services/error";

const log = createLogger("Config");

// ── 类型定义 ──

interface UserSettings {
  popupMode: "cursor" | "fixed";
  fixedPosition: { x: number; y: number } | null;
  popupSize: { w: number; h: number };
  chatWidth: number;
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
      fixedPosition?: { x: number; y: number } | null
      chatWidth?: number
    }
    shortcut: {
      key: string
      macModifiers: string[]
      winModifiers: string[]
    }
    logging: { level: "debug" | "info" | "warn" | "error" }
    errors: { overlay: "auto" | "always" | "never" }
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
    parallax?: {
      enabled: boolean
      intensity: number
      layers: ParallaxLayerCfg[]
    }
    soundAssignments?: Record<string, string>
  }
}

let cfg = structuredClone(rawConfig) as Config;
let configInitialized = false
let writeQueue: Promise<void> = Promise.resolve()
let saveQueued = false
let leadingComments = ""  // 首次读取时保留的头部注释块

// 提取文件顶部注释块（含空行），写回时原样拼回，避免设置页保存抹掉配置说明
function extractLeadingComments(text: string): string {
  const head: string[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) head.push(line)
    else break
  }
  while (head.length && head[head.length - 1].trim() === "") head.pop()
  return head.length ? head.join("\n") + "\n\n" : ""
}

// 序列化配置：头部注释 + YAML 正文
function serializeConfig(): string {
  return leadingComments + dumpYaml(cfg, { lineWidth: -1, noRefs: true })
}

function isConfig(value: unknown): value is Config {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<Config>
  return Boolean(candidate.general && candidate.ai && candidate.tools && candidate.appearance)
}

export async function initConfig(): Promise<void> {
  if (configInitialized) return
  const text = await invoke<string>("read_runtime_config")
  const parsed = loadYaml(text)
  if (!isConfig(parsed)) throw new Error("CONFIG 缺少 general/ai/tools/appearance 根节点")
  cfg = parsed
  leadingComments = extractLeadingComments(text)
  configInitialized = true
  clearLegacyConfigCache()
}

export async function reloadConfig(): Promise<void> {
  configInitialized = false
  await initConfig()
  // 配置可能改了日志级别，立刻作用到前端与 Rust，不必等重启
  applyLogLevel()
}

function clearLegacyConfigCache(): void {
  try {
    const exact = new Set([
      "deskpet_user_settings", "deskpet_config_overrides", "deskpet_chat_history",
      "deskpet_sessions", "deskpet_active_session", "deskpet_parallax_layers",
      "deskpet_parallax_offset_v2", "deskpet_parallax_dirty", "deskpet_divider_pos",
      "deskpet_sound_assignments",
    ])
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    for (const key of keys) {
      if (key && (exact.has(key) || key.startsWith("deskpet_chat_") || key.startsWith("deskpet_unanswered_") || key.startsWith("deskpet_live_test_"))) {
        localStorage.removeItem(key)
      }
    }
  } catch { /* WebView storage may be unavailable in tests. */ }
}

function queueConfigSave(): void {
  if (saveQueued) return
  saveQueued = true
  queueMicrotask(() => {
    saveQueued = false
    const content = serializeConfig()
    writeQueue = writeQueue.then(() => invoke<void>("write_runtime_config", { content }))
    void writeQueue
  })
}

export async function flushConfig(): Promise<void> {
  if (saveQueued) {
    saveQueued = false
    const content = serializeConfig()
    writeQueue = writeQueue.then(() => invoke<void>("write_runtime_config", { content }))
  }
  await writeQueue
}

function cloneConfig(): Config {
  return structuredClone(cfg)
}

// ==========================================
// 运行时用户配置（CONFIG 中的便捷视图）
// ==========================================
const USER_DEFAULTS: UserSettings = {
  popupMode: cfg.general?.popup?.mode || "cursor",
  fixedPosition: cfg.general?.popup?.fixedPosition ?? null,
  popupSize: cfg.general?.popup?.defaultSize || { w: 730, h: 450 },
  chatWidth: cfg.general?.popup?.chatWidth ?? 220,
  shortcutKey: cfg.general?.shortcut?.key || "P",
  shortcutMacModifiers: cfg.general?.shortcut?.macModifiers || ["Control", "Command"],
  shortcutWinModifiers: cfg.general?.shortcut?.winModifiers || ["Control", "Alt"],
  autoPopupOnMessage: cfg.general?.popup?.autoPopupOnMessage ?? false,
  parallaxEnabled: cfg.appearance?.parallax?.enabled ?? false,
  parallaxIntensity: cfg.appearance?.parallax?.intensity ?? 1.0,
  parallaxLayers: cfg.appearance?.parallax?.layers ?? DEFAULT_LAYERS.map(l => ({ ...l })),
};

function loadUserOverrides(): UserSettings {
  return {
    popupMode: cfg.general?.popup?.mode ?? USER_DEFAULTS.popupMode,
    fixedPosition: cfg.general?.popup?.fixedPosition ?? null,
    popupSize: cfg.general?.popup?.defaultSize ?? USER_DEFAULTS.popupSize,
    chatWidth: cfg.general?.popup?.chatWidth ?? USER_DEFAULTS.chatWidth,
    shortcutKey: cfg.general?.shortcut?.key ?? USER_DEFAULTS.shortcutKey,
    shortcutMacModifiers: cfg.general?.shortcut?.macModifiers ?? USER_DEFAULTS.shortcutMacModifiers,
    shortcutWinModifiers: cfg.general?.shortcut?.winModifiers ?? USER_DEFAULTS.shortcutWinModifiers,
    autoPopupOnMessage: cfg.general?.popup?.autoPopupOnMessage ?? USER_DEFAULTS.autoPopupOnMessage,
    parallaxEnabled: cfg.appearance?.parallax?.enabled ?? USER_DEFAULTS.parallaxEnabled,
    parallaxIntensity: cfg.appearance?.parallax?.intensity ?? USER_DEFAULTS.parallaxIntensity,
    parallaxLayers: cfg.appearance?.parallax?.layers ?? USER_DEFAULTS.parallaxLayers,
  }
}

function saveUserOverrides(s: UserSettings): void {
  cfg.general.popup.mode = s.popupMode
  cfg.general.popup.fixedPosition = s.fixedPosition
  cfg.general.popup.defaultSize = s.popupSize
  cfg.general.popup.chatWidth = s.chatWidth
  cfg.general.popup.autoPopupOnMessage = s.autoPopupOnMessage
  cfg.general.shortcut.key = s.shortcutKey
  cfg.general.shortcut.macModifiers = s.shortcutMacModifiers
  cfg.general.shortcut.winModifiers = s.shortcutWinModifiers
  cfg.appearance.parallax = {
    enabled: s.parallaxEnabled,
    intensity: s.parallaxIntensity,
    layers: s.parallaxLayers,
  }
  queueConfigSave()
}

// 不再缓存 UserSettings：cfg 是唯一真相源，loadUserOverrides() 只是读它几个字段。
// 派生出第二份状态就得处处同步，正是过去不一致的来源。
function getUser(): UserSettings {
  return loadUserOverrides();
}

export function getDefaultSize(): { w: number; h: number } {
  return userConfig.popupSize;
}

export const userConfig = {
  get popupMode() { return getUser().popupMode; },
  set popupMode(v: "cursor" | "fixed") { const u = loadUserOverrides(); u.popupMode = v; saveUserOverrides(u); },
  get fixedPosition() { const p = getUser().fixedPosition; return (p && Math.abs(p.x) > 5000) ? null : (p && Math.abs(p.y) > 5000) ? null : p; },
  set fixedPosition(v: { x: number; y: number } | null) { const u = loadUserOverrides(); u.fixedPosition = v; saveUserOverrides(u); },
  get popupSize() { const sz = getUser().popupSize; return (!sz || sz.w > 2000 || sz.h > 2000 || sz.w < 50 || sz.h < 50) ? { w: 730, h: 450 } : sz; },
  set popupSize(v: { w: number; h: number }) { const u = loadUserOverrides(); u.popupSize = v; saveUserOverrides(u); },
  get chatWidth() { return getUser().chatWidth; },
  set chatWidth(v: number) { const u = loadUserOverrides(); u.chatWidth = v; saveUserOverrides(u); },
  get shortcutKey() { return getUser().shortcutKey; },
  set shortcutKey(v: string) { const u = loadUserOverrides(); u.shortcutKey = v; saveUserOverrides(u); },
  get shortcutMacModifiers() { return getUser().shortcutMacModifiers; },
  set shortcutMacModifiers(v: string[]) { const u = loadUserOverrides(); u.shortcutMacModifiers = v; saveUserOverrides(u); },
  get shortcutWinModifiers() { return getUser().shortcutWinModifiers; },
  set shortcutWinModifiers(v: string[]) { const u = loadUserOverrides(); u.shortcutWinModifiers = v; saveUserOverrides(u); },
  get autoPopupOnMessage() { return getUser().autoPopupOnMessage; },
  set autoPopupOnMessage(v: boolean) { const u = loadUserOverrides(); u.autoPopupOnMessage = v; saveUserOverrides(u); },
  get parallaxEnabled() { return getUser().parallaxEnabled; },
  set parallaxEnabled(v: boolean) { const u = loadUserOverrides(); u.parallaxEnabled = v; saveUserOverrides(u); },
  get parallaxIntensity() { return getUser().parallaxIntensity; },
  set parallaxIntensity(v: number) { const u = loadUserOverrides(); u.parallaxIntensity = v; saveUserOverrides(u); },
  get parallaxLayers() { return getUser().parallaxLayers; },
  set parallaxLayers(v: ParallaxLayerCfg[]) { const u = loadUserOverrides(); u.parallaxLayers = v; saveUserOverrides(u); },
  getAll(): UserSettings { return { ...getUser() }; },
  setAll(s: Partial<UserSettings>) { const u = { ...loadUserOverrides(), ...s }; saveUserOverrides(u); },
  resetAll() {
    const defaults = structuredClone(rawConfig) as Config
    cfg.general.popup = defaults.general.popup
    cfg.general.shortcut = defaults.general.shortcut
    cfg.appearance.parallax = defaults.appearance.parallax
    queueConfigSave()
  },
};

// ==========================================
// 点路径配置 API（保留调用接口，实际直接修改 cfg）
// ==========================================
function getAtPath(key: string): any {
  return key.split(".").reduce<any>((value, part) => value?.[part], cfg)
}

function setAtPath(key: string, value: any): void {
  const parts = key.split(".")
  let cursor: Record<string, any> = cfg as unknown as Record<string, any>
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
}

export function getOverride<T>(key: string): T | undefined {
  const v = getAtPath(key);
  return v !== undefined ? (v as T) : undefined;
}

export function setOverride(key: string, value: any): void {
  setAtPath(key, value)
  queueConfigSave()
}

export function setOverrides(map: Record<string, any>): void {
  for (const [key, value] of Object.entries(map)) setAtPath(key, value)
  queueConfigSave()
}

export function getAllOverrides(): Record<string, any> {
  return cloneConfig() as unknown as Record<string, any>
}

export function clearOverrides(): void {
  cfg = structuredClone(rawConfig) as Config
  queueConfigSave()
}

function overrideOr<T>(key: string, fallback: T): T {
  const ov = getAtPath(key);
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

/**
 * 运行期真正生效的日志级别 —— logger 的唯一依据。
 *
 * 与 `generalConfig.loggingLevel` 的区别很重要：那个 getter 是**配置的读写接口**
 * （设置面板用它做下拉初值并回写 YAML），不能在 dev 下改写，否则在 dev 里
 * 保存任何设置都会把 `level: debug` 静默写进 CONFIG-DEV.yaml。
 */
export function computeLogLevel(): Level {
  const env = import.meta.env.VITE_LOG_LEVEL as Level | undefined;
  if (env && LEVELS.includes(env)) return env;
  if (import.meta.env.DEV) return "debug";   // dev 全量打印，忽略配置
  return generalConfig.loggingLevel;
}

/**
 * 重新计算并应用运行期日志级别（前端 + Rust）。
 * 设置面板保存后经 reloadConfig() 调用，让级别改动**立即生效**而不必重启。
 */
export function applyLogLevel(): Level {
  const level = computeLogLevel();
  setLogLevel(level);
  // 推给 Rust，保持两端过滤一致；Rust 未就绪时忽略（它有各自的构建默认值）
  invoke("set_log_config", { level: LEVEL_ORDER[level] }).catch(() => {});
  return level;
}

export const shortcutConfig = {
  get key() { return generalConfig.shortcutKey; },
  get macModifiers() { return generalConfig.shortcutMacModifiers; },
  get winModifiers() { return generalConfig.shortcutWinModifiers; },
};

export const loggingConfig = {
  get level() { return generalConfig.loggingLevel; },
};

/** 未捕获异常覆盖层的行为 */
export type OverlayMode = "auto" | "always" | "never";

export const errorsConfig = {
  /** auto = dev 弹、生产不弹；always / never 强制。见 error/global.ts 的 shouldShowOverlay() */
  get overlay() { return overrideOr("general.errors.overlay", cfg.general?.errors?.overlay ?? "auto") as OverlayMode; },
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
      log.warn("config 键缺失，回退默认值", formatError(e))
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
  get fileWriteEnabled() { return overrideOr("tools.file.writeEnabled", cfg.tools?.file?.writeEnabled ?? true); },
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
  log.info("已加载运行时 CONFIG | AI:", aiConfig.provider, "| endpoint:", aiConfig.endpoint);
}
