// ==========================================
// 全局配置 —— 启动时从 AppPaths.config_file 加载
// 所有模块都应从此处读取配置，不自行定义常量
// 设置修改直接回写该 CONFIG 文件，不再使用 localStorage 作为配置层
// ==========================================

import rawConfig from "../../CONFIG.yaml";
import { invoke } from "@tauri-apps/api/core";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { DEFAULT_PROFILE } from "@/services/paths";
import { createLogger, LEVELS, LEVEL_ORDER, setLogLevel, type Level } from "@/services/logger";
import { reportError } from "@/services/error";

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
  effectMode: EffectMode;
  parallaxIntensity: number;
}

/**
 * 角色展示效果。单字段枚举 —— 灵动图层与景深互斥，
 * 用两个 bool 会允许同时为真；off 时按静态立绘渲染。
 */
export type EffectMode = "off" | "parallax" | "dof"

export interface BuiltinMcpServer {
  includeTools?: string[]
  excludeTools?: string[]
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
    }
    personality: {
      active: string
    }
    loop: {
      maxRetry: number
      maxToolCallsPerTurn: number
      toolTimeoutMs: number
      turnTimeoutMs: number
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
      cooldownMs: number
      samePageCooldownMs: number
      resumeExtraMs: number
    }
    safety: { mode: string; sessionTrustEnabled: boolean }
  }
  tools: {
    bash: { whitelist: string[] }
    file: { writeEnabled: boolean }
    mcp: {
      enabled: boolean
      servers: Record<string, unknown>[]
      builtin: Record<string, BuiltinMcpServer>
    }
    skill: { enabled: boolean }
  }
  appearance: {
    activeProfile: string
    /** 角色展示效果，唯一开关；灵动图层与景深互斥 */
    effectMode?: EffectMode
    /** 灵动图层的全局强度；逐层素材与参数在 Profile 的 theme.parallax.layers */
    parallax?: {
      intensity: number
    }
    soundAssignments?: Record<string, string>
  }
}

let cfg = structuredClone(rawConfig) as Config;
let configInitialized = false
let writeQueue: Promise<void> = Promise.resolve()
/** 最近一次写盘的真实失败；被后一次成功写入清空 */
let lastWriteError: unknown = null
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

// ── 配置写队列 ──
// 队列尾必须永远 fulfilled：Promise 链一旦 rejected，后续 `.then` 的回调就不再执行，
// 该会话内所有后续设置保存都会静默失效。真实失败只沿「本次调用返回的那条 promise」
// 传播（fire-and-forget 路径自行上报），链尾用 .catch 消化。
const WRITE_MAX_RETRIES = 1        // 首次之外再重试 1 次，不做无限重试
const WRITE_RETRY_BASE_MS = 250    // 指数退避基数
const WRITE_RETRY_CAP_MS = 1000    // 退避封顶

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 写盘（含有限重试）；重试耗尽后抛出最后一次错误，由调用方决定如何呈现 */
async function writeConfigFile(content: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await invoke<void>("write_runtime_config", { content })
      return
    } catch (error) {
      if (attempt >= WRITE_MAX_RETRIES) throw error
      await sleep(Math.min(WRITE_RETRY_BASE_MS * 2 ** attempt, WRITE_RETRY_CAP_MS))
    }
  }
}

/**
 * 入队一次配置写盘。
 * 返回的 promise 保留真实成功/失败（flushConfig 的调用方要 await 到它）；
 * 队列尾另行消化错误，保证一次失败不会让后续写入全部失效。
 */
function enqueueConfigWrite(content: string): Promise<void> {
  const run = writeQueue.then(async () => {
    try {
      await writeConfigFile(content)
      lastWriteError = null
    } catch (error) {
      lastWriteError = error
      throw error
    }
  })
  writeQueue = run.catch(() => { /* 队尾消化：链保持 fulfilled，后续写入照常执行 */ })
  return run
}

function queueConfigSave(): void {
  if (saveQueued) return
  saveQueued = true
  queueMicrotask(() => {
    saveQueued = false
    // 合并窗口内的保存没有调用方 await 这条 promise，失败必须主动上报，否则只会静默丢配置
    enqueueConfigWrite(serializeConfig()).catch((error) => {
      reportError("Config", error, { kind: "save" })
    })
  })
}

export async function flushConfig(): Promise<void> {
  if (saveQueued) {
    saveQueued = false
    // 这条不做消化：调用方 await 到的就是本次写盘的真实成功/失败
    await enqueueConfigWrite(serializeConfig())
    return
  }
  await writeQueue
  // 队尾消化过错误，但最后一次写盘失败意味着磁盘上的配置已经过期，调用方有权知道
  if (lastWriteError !== null) throw lastWriteError
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
  effectMode: cfg.appearance?.effectMode ?? "off",
  parallaxIntensity: cfg.appearance?.parallax?.intensity ?? 1.0,
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
    effectMode: cfg.appearance?.effectMode ?? USER_DEFAULTS.effectMode,
    parallaxIntensity: cfg.appearance?.parallax?.intensity ?? USER_DEFAULTS.parallaxIntensity,
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
  cfg.appearance.effectMode = s.effectMode
  cfg.appearance.parallax = {
    intensity: s.parallaxIntensity,
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
  get effectMode() { return getUser().effectMode; },
  set effectMode(v: EffectMode) { const u = loadUserOverrides(); u.effectMode = v; saveUserOverrides(u); },
  get parallaxIntensity() { return getUser().parallaxIntensity; },
  set parallaxIntensity(v: number) { const u = loadUserOverrides(); u.parallaxIntensity = v; saveUserOverrides(u); },
};

function setAtPath(key: string, value: any): void {
  const parts = key.split(".")
  let cursor: Record<string, any> = cfg as unknown as Record<string, any>
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
}

// ==========================================
// 点路径配置 API（保留调用接口，实际直接修改 cfg）
// ==========================================
function getAtPath(key: string): any {
  return key.split(".").reduce<any>((value, part) => value?.[part], cfg)
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
  get configured() { if (!this.endpoint) return false; if (!this.requireApiKey) return true; return Boolean(this.apiKey); },
};

export const aiConfig = _ai;

export const personalityConfig = {
  get active() { return overrideOr("ai.personality.active", cfg.ai?.personality?.active || ""); },
};

export const windowMonitorConfig = {
  get enabled() { return overrideOr("ai.windowMonitor.enabled", cfg.ai?.windowMonitor?.enabled ?? true); },
  get staySeconds() { return overrideOr("ai.windowMonitor.staySeconds", cfg.ai?.windowMonitor?.staySeconds || 60); },
  get settleMs() { return overrideOr("ai.windowMonitor.settleMs", cfg.ai?.windowMonitor?.settleMs || 2000); },
  // 冷却时长统一用毫秒。早先这里是 `cooldownSeconds: 5000` 由调用方当秒乘 1000，
  // 于是「5 秒」静默变成 83 分钟；同一个量还有第二个键 `defaultCooldownMs` 喂同一变量，
  // 两者只保留了前者。
  get cooldownMs() { return overrideOr("ai.windowMonitor.cooldownMs", cfg.ai?.windowMonitor?.cooldownMs || 5000); },
  /** 同一页面内容重复触发时的抑制窗口；消费者在 `services/agent/active.ts` */
  get samePageCooldownMs() { return overrideOr("ai.windowMonitor.samePageCooldownMs", cfg.ai?.windowMonitor?.samePageCooldownMs || 7800); },
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
  get bashWhitelist() { return overrideOr("tools.bash.whitelist", cfg.tools?.bash?.whitelist || ["ls", "cat", "head", "tail", "grep", "find", "which", "echo", "pwd", "date", "whoami", "uname", "df", "du", "ps"]); },
  get fileWriteEnabled() { return overrideOr("tools.file.writeEnabled", cfg.tools?.file?.writeEnabled ?? true); },
  // 读写值：设置页勾选框的初值与回写都读它，宠物模式下也如实反映用户配置。
  get mcpEnabled() { return overrideOr("tools.mcp.enabled", cfg.tools?.mcp?.enabled ?? false); },
  get mcpServers() { return overrideOr("tools.mcp.servers", cfg.tools?.mcp?.servers || []); },
  get builtinMcpServers() { return overrideOr("tools.mcp.builtin", cfg.tools?.mcp?.builtin || {}) as Record<string, BuiltinMcpServer>; },
  // Skill 是按 invocationPolicy 过滤的对话说明，不等同于助手工具；轻量模式可使用
  // 明确声明 pet/both 的 Skill，但不能因此获得 bash、MCP 或写入权限。
  get skillEnabled() { return overrideOr("tools.skill.enabled", cfg.tools?.skill?.enabled ?? false); },
};

/**
 * 运行期 MCP 是否生效：助手模式与配置读写值的合取。
 * 派生值只服务运行期消费者，不得回流设置页读写——否则宠物模式下打开设置再保存，
 * 会把用户配置里的 true 静默改写成 false（同 generalConfig.loggingLevel 与 computeLogLevel 的分工）。
 */
export function computeMcpEnabled(): boolean {
  return generalConfig.assistantMode && toolsConfig.mcpEnabled;
}

// ══════════════════════════════════════════
// 4. 外观 — Profile 系统
// 主题/角色/音效由运行时 data_root/profiles/ 管理
// ==========================================
export const appearanceConfig = {
  get activeProfile() { return overrideOr("appearance.activeProfile", cfg.appearance?.activeProfile || DEFAULT_PROFILE); },
};

// ══════════════════════════════════════════
// 开发时日志
// ══════════════════════════════════════════
if (import.meta.env.DEV) {
  log.info("已加载运行时 CONFIG | AI:", aiConfig.provider, "| endpoint:", aiConfig.endpoint);
}
