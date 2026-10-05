// ==========================================
// 全局配置 —— 启动时从 AppPaths.config_file 加载
// 所有模块都应从此处读取配置，不自行定义常量
// 设置修改直接回写该 CONFIG 文件，不再使用 localStorage 作为配置层
// ==========================================

// CONFIG.yaml 是**内置默认模板**（运行期真实配置经 read_runtime_config 读数据根）：
// 两种构建（Vite yaml 插件 / esbuild `--loader:.yaml=text`）统一交付 YAML 文本，
// 这里用 js-yaml 解析成对象 —— 装载方式只有这一处，不为某个 bundler 保留第二种形状。
import rawConfigText from "../../CONFIG.yaml";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { getHostBridge, getHostEnvironment } from "@/services/host";
import { DEFAULT_PROFILE } from "@/services/paths";
// 零依赖叶子：窗口语义的唯一定义点（默认 128k / 下限 64k），config 只做缺省引用。
import { DEFAULT_CONTEXT_WINDOW } from "./context/budget";
import { createLogger, LEVEL_ORDER, setLogLevel, type Level } from "@/services/logger";
import { formatError, reportError } from "@/services/error";

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
  /** 界面主题（产品级三套预设，与 Profile 正交） */
  theme: ThemeId;
  parallaxIntensity: number;
  /** 全局字体家族名（用户系统已安装的字体）；空串 = 跟随系统默认字体栈 */
  fontFamily: string;
  /** 全局字号 px */
  fontSize: number;
}

/**
 * 全局字号（`appearance.font.size`）的取值范围与默认值。
 *
 * 默认 15 延续聊天文本的实际渲染尺寸（15px；`--font-size` 变量没有消费者，
 * 文本尺寸由 clamp 上限决定）。字体服务在配置值非法时也回退到它。
 */
export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 24
export const DEFAULT_FONT_SIZE = 15

/**
 * 角色展示效果。单字段枚举 —— 用两个 bool 会允许同时为真；off 时按静态立绘渲染。
 * 取值定型为 off | parallax；非法枚举（含已删除的 dof）按读取期规则收拢，见 readEffectMode。
 */
export type EffectMode = "off" | "parallax"

/** 合法展示模式判定 —— 读取期收拢与设置页诊断共用，不建第二个校验点。 */
export function isEffectMode(raw: unknown): raw is EffectMode {
  return raw === "off" || raw === "parallax"
}

/**
 * 读取期收拢 `appearance.effectMode`（CONFIG 是用户可手写的 YAML）。
 *
 * 与其它字段的读取期规则一致：不把非法值透传给运行内核，也不为某个旧取值（如 dof）
 * 写专项兼容映射 —— 合法枚举之外一律按保守默认 `off` 读取。非法值只记一条中性诊断
 * （同一取值只提示一次），修正入口是设置页「外观 → 角色展示效果」。
 *
 * 只读：启动/读配置不写盘；最终有效值只在用户经设置页明确保存时由 userConfig.effectMode
 * 的 setter 写回。
 */
let warnedInvalidEffectMode: string | null = null
function readEffectMode(raw: unknown): EffectMode {
  if (isEffectMode(raw)) return raw
  if (raw !== undefined && raw !== null) {
    const text = String(raw)
    if (warnedInvalidEffectMode !== text) {
      warnedInvalidEffectMode = text
      log.warn(`appearance.effectMode 取值非法（${text}），已按 off 读取；请在设置页「外观 → 角色展示效果」重新选择并保存`)
    }
  }
  return "off"
}

/**
 * 界面主题：三套产品级预设，用户只能三选一，不能改值。
 *
 * 与 Profile **正交** —— 主题属于产品外观，住在 CONFIG；Profile 只管角色
 * （灵动图层与素材）。换 Profile 不换主题，换主题不换 Profile。
 * token 表与绘制实现在 Rust 侧 `crates/native-host/src/ui/theme/`，
 * 本类型只做「读配置 + 收拢非法值 + 推送宿主」。
 */
export type ThemeId = "brushed" | "chrome" | "verdigris" | "nightfall" | "azurite"

/** 主题的合法取值清单（设置页下拉与校验共用，不建第二个校验点）。 */
export const THEME_IDS: readonly ThemeId[] = [
  "brushed",
  "chrome",
  "verdigris",
  "nightfall",
  "azurite",
]

/** 主题中文显示名（设置页下拉标签）。 */
export const THEME_LABELS: Record<ThemeId, string> = {
  brushed: "拉丝金属",
  chrome: "铬",
  verdigris: "铜绿",
  nightfall: "暮蓝",
  azurite: "青花",
}

/** 默认主题。与 Rust 侧 `ThemeId::default()` 一致（拉丝金属）。 */
export const DEFAULT_THEME: ThemeId = "brushed"

/** 合法主题判定 —— 读取期收拢与设置页诊断共用。 */
export function isThemeId(raw: unknown): raw is ThemeId {
  return typeof raw === "string" && (THEME_IDS as readonly string[]).includes(raw)
}

/**
 * 读取期收拢 `appearance.theme`（CONFIG 是用户可手写的 YAML）。
 *
 * 与 `readEffectMode` 同款规则：不把非法值透传给宿主，也不为旧取值写兼容映射 ——
 * 合法枚举之外一律按默认 `brushed` 读取，不写盘。非法值只记一条中性诊断
 * （同一取值只提示一次），修正入口是设置页「外观 → 界面主题」。
 */
let warnedInvalidTheme: string | null = null
function readThemeId(raw: unknown): ThemeId {
  if (isThemeId(raw)) return raw
  if (raw !== undefined && raw !== null) {
    const text = String(raw)
    if (warnedInvalidTheme !== text) {
      warnedInvalidTheme = text
      log.warn(`appearance.theme 取值非法（${text}），已按 ${DEFAULT_THEME} 读取；请在设置页「外观 → 界面主题」重新选择并保存`)
    }
  }
  return DEFAULT_THEME
}

// ── 三处频率档位（主动消息 / 静默了解 / 记忆整理）──
//
// 档位的**数值表**（唤醒区间、每日配额、token 等）的唯一真相源是
// `proactive/protocol.json` 的 `tiers`（经 `proactive/tiers.ts` 消费）；
// 这里只做 CONFIG 字符串的读取期收拢，不复制任何档位数值。

/** 四档频率：off = 不自动跑（手动入口保留）；low/medium/high 按档位表。 */
export type FrequencyTier = "off" | "low" | "medium" | "high"

/** 合法档位判定（读取期收拢共用；四值集合的唯一真相源，`proactive/tiers.ts` 复用本判定）。 */
export function isFrequencyTier(raw: unknown): raw is FrequencyTier {
  return raw === "off" || raw === "low" || raw === "medium" || raw === "high"
}

/** 非法取值只记一条中性诊断（同一字段同一取值只提示一次）。 */
const warnedInvalidTierValues = new Set<string>()

/**
 * 读取期收拢一档频率（CONFIG 是用户可手写的 YAML）。
 *
 * 与 `readEffectMode` 同款规则：不把非法值透传给运行内核，也不为旧取值写兼容映射 ——
 * 合法四值之外一律按默认 `medium` 读取，不写盘。同一非法取值只记一条诊断，
 * 修正入口是设置页对应档位下拉。
 */
function readFrequencyTier(raw: unknown, key: string): FrequencyTier {
  if (isFrequencyTier(raw)) return raw
  if (raw !== undefined && raw !== null) {
    const marker = `${key}=${String(raw)}`
    if (!warnedInvalidTierValues.has(marker)) {
      warnedInvalidTierValues.add(marker)
      log.warn(`${key} 取值非法（${String(raw)}），已按 medium 读取；请在设置页对应档位重新选择并保存`)
    }
  }
  return "medium"
}

/**
 * 读取期收拢静默小时（`ai.proactive.quietStartHour/quietEndHour`）：
 * 0–23 的整数原样（0 是合法小时，不得用 `||` 兜底吞掉）；其余按默认读取。
 */
function readQuietHour(raw: unknown, key: string, fallback: number): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 23) return raw
  if (raw !== undefined && raw !== null) {
    const marker = `${key}=${String(raw)}`
    if (!warnedInvalidTierValues.has(marker)) {
      warnedInvalidTierValues.add(marker)
      log.warn(`${key} 取值非法（${String(raw)}），已按 ${fallback} 读取；请在设置页重新填写并保存`)
    }
  }
  return fallback
}

/**
 * 用户可选的投递意图：steer=插话（当前响应及工具批次结束后处理），
 * followUp=稍后继续（当前运行自然准备结束时继续）。与 Pi 函数名解耦，UI 不显示这两个词。
 */
export type DeliveryIntent = "steer" | "followUp"

/** 队列批量策略：all=同一安全边界前积压的补充一起进入下一次请求；one-at-a-time=逐条。 */
export type QueueMode = "all" | "one-at-a-time"

interface Config {
  general: {
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
  }
  ai: {
    provider: string
    endpoint: string
    apiKey: string
    requireApiKey: boolean
    model: string
    /** 辅助模型（子代理 / 主动扫描规划 / 记忆整理）；空 = 跟随聊天模型 */
    auxModel: string
    contextMaxTokens: number
    thinking: {
      effort: string
    }
    conversation: {
      /** 忙碌时未显式选择意图的默认投递方式（steer / followUp） */
      defaultDelivery: string
      /** 插话批量策略：all / one-at-a-time */
      steeringMode: string
      /** 稍后继续的批量策略：all / one-at-a-time */
      followUpMode: string
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
      /** 同时执行的只读（shared_read）工具数上限；运行期所有者是 Rust 许可池 */
      maxParallelTools: number
    }
    memory: {
      enabled: boolean
      coreTokenBudget: number
      recallTokenBudget: number
      rerank: "off" | "adaptive"
      recallTimeoutMs: number
      rerankTimeoutMs: number
      dreaming: {
        /** 整理档位：off = 不自动跑（手动入口保留）；low/medium/high 按档位表 */
        tier: FrequencyTier
        /** 单次 Review 的输出上限；null 表示按模型输出预算自动推导 */
        reviewMaxTokens: number | null
      }
      maxSessions: number
    }
    plan: {
      enabled: boolean
      complexityThreshold: number
      complexityEval: string
      maxSteps: number
      stepTimeoutMs: number
      stepMaxRounds: number
      thinkingEffort: string
      stepThinkingEffort: string
      onStepFailure: string
      keywords: string[]
    }
    lock: { safetyTimeoutMs: number }
    humanizer: { enabled: boolean }
    /** 主动消息：总闸 + 频率 + 静默时间段（静默时段仅约束主动消息） */
    proactive: {
      frequency: FrequencyTier
      /** 静默开始/结束（本地小时 0–23）；跨夜语义 start > end，start == end = 不静默 */
      quietStartHour: number
      quietEndHour: number
    }
    silentAccess: {
      /** 静默了解总闸 + 频率 */
      frequency: FrequencyTier
    }
    safety: { mode: string; sessionTrustEnabled: boolean }
  }
  tools: {
    bash: { whitelist: string[] }
    mcp: {
      servers: Record<string, unknown>[]
    }
  }
  appearance: {
    activeProfile: string
    /** 角色展示效果，唯一开关：off | parallax（非法值按读取期规则收拢，见 readEffectMode） */
    effectMode?: EffectMode
    /** 界面主题：brushed | chrome | verdigris | nightfall | azurite（非法值按读取期规则收拢，见 readThemeId） */
    theme?: ThemeId
    /**
     * 聊天图片自动预览：关闭（默认）时历史只显示占位、不读取图片字节；开启时只为
     * 当前可见消息按需加载内联预览。只影响聊天历史的内联呈现，不影响模型看图、
     * 图片选择/发送、截图与 JSONL 里的原路径。
     */
    chatImagePreview?: boolean
    /** 灵动图层的全局强度；逐层素材与参数在 Profile 的 theme.parallax.layers */
    parallax?: {
      intensity: number
    }
    /** 全局字体（不随 Profile）：family 为空串时跟随系统默认字体栈 */
    font?: {
      family: string
      size: number
    }
    soundAssignments?: Record<string, string>
  }
}

/** 内置默认的 CONFIG.yaml（模块级解析一次；initConfig 前与读取失败时的兜底值）。 */
const rawConfig = loadYaml(rawConfigText) as Config;

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
  const text = await getHostBridge().request("read_runtime_config", {})
  const parsed = loadYaml(text)
  if (!isConfig(parsed)) throw new Error("CONFIG 缺少 general/ai/tools/appearance 根节点")
  cfg = parsed
  leadingComments = extractLeadingComments(text)
  configInitialized = true
  // 开发模式打印一次生效来源（原为模块加载期的 dev 日志；模块加载早于配置读取与
  // 环境端口注入，移到读取成功点才有真实值）。
  if (getHostEnvironment().runtimeMode === "development") {
    log.info("已加载运行时 CONFIG | AI:", aiConfig.provider, "| endpoint:", aiConfig.endpoint)
  }
}

export async function reloadConfig(): Promise<void> {
  configInitialized = false
  await initConfig()
  // 配置可能改了日志级别，立刻作用到前端与 Rust，不必等重启
  applyLogLevel()
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
      await getHostBridge().request("write_runtime_config", { content })
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
  effectMode: readEffectMode(cfg.appearance?.effectMode),
  theme: readThemeId(cfg.appearance?.theme),
  parallaxIntensity: cfg.appearance?.parallax?.intensity ?? 1.0,
  fontFamily: cfg.appearance?.font?.family ?? "",
  fontSize: cfg.appearance?.font?.size ?? DEFAULT_FONT_SIZE,
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
    effectMode: readEffectMode(cfg.appearance?.effectMode),
    theme: readThemeId(cfg.appearance?.theme),
    parallaxIntensity: cfg.appearance?.parallax?.intensity ?? USER_DEFAULTS.parallaxIntensity,
    fontFamily: cfg.appearance?.font?.family ?? USER_DEFAULTS.fontFamily,
    fontSize: cfg.appearance?.font?.size ?? USER_DEFAULTS.fontSize,
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
  cfg.appearance.theme = s.theme
  cfg.appearance.parallax = {
    intensity: s.parallaxIntensity,
  }
  cfg.appearance.font = {
    family: s.fontFamily,
    size: s.fontSize,
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
  get theme() { return getUser().theme; },
  set theme(v: ThemeId) { const u = loadUserOverrides(); u.theme = v; saveUserOverrides(u); },
  get parallaxIntensity() { return getUser().parallaxIntensity; },
  set parallaxIntensity(v: number) { const u = loadUserOverrides(); u.parallaxIntensity = v; saveUserOverrides(u); },
  get fontFamily() { return getUser().fontFamily; },
  set fontFamily(v: string) { const u = loadUserOverrides(); u.fontFamily = v; saveUserOverrides(u); },
  get fontSize() { return getUser().fontSize; },
  set fontSize(v: number) { const u = loadUserOverrides(); u.fontSize = v; saveUserOverrides(u); },
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

/**
 * 内置默认 CONFIG 的深拷贝（设置窗「↺ 默认」的唯一默认值来源）。
 *
 * 默认值只在 `CONFIG.yaml` 模板定义（模块级解析的 `rawConfig`）；调用方不得
 * 复制默认值、不得改返回值（深拷贝隔离）。
 */
export function getBundledDefaults(): Record<string, any> {
  return structuredClone(rawConfig) as unknown as Record<string, any>
}

/** 导出当前运行时 CONFIG 的 YAML 文本（含头部注释；设置窗「导出配置」用）。 */
export function exportConfigYaml(): string {
  return serializeConfig()
}

/**
 * 导入整份 CONFIG（设置窗「导入配置」）：解析 → 校验根节点 → 替换内存配置 →
 * 原子写盘 → 重应用日志级别。
 *
 * 校验失败在替换内存之前抛出（磁盘与内存都不变）；写盘失败如实抛出（内存已替换、
 * 磁盘未落，与设置保存同口径：错误摆给用户，由用户重试）。导入文件是完整配置
 * （含嵌套结构），缺键由各 getter 的既有兜底承担，不在这里补默认值。
 */
export async function importConfigYaml(text: string): Promise<void> {
  const parsed = loadYaml(text)
  if (!isConfig(parsed)) {
    throw new Error("导入的 CONFIG 缺少 general/ai/tools/appearance 根节点")
  }
  cfg = parsed
  leadingComments = extractLeadingComments(text)
  queueConfigSave()
  await flushConfig()
  applyLogLevel()
  await refreshConfigConsumers()
}

/**
 * 配置整份导入后的消费者刷新（`importConfigYaml` 的收尾）：
 * - 静默了解调度按 `silentAccessConfig.frequency` 起停（off = 停）；
 * - 主动扫描 `refreshProactive()`（档位与静默时段都是 scanner 的运行期配置输入）。
 *
 * 动态 `import()` 是刻意的：`observation` / `proactive` 都依赖本模块的 getter，
 * 静态导入会形成循环依赖；这条刷新链只在一次用户动作里跑，动态开销可忽略。
 *
 * 失败只留痕不抛出：配置已写盘成功，消费者刷新失败不该把导入报成失败
 * （与 `host-requests` 的 `reapplyRuntimeSettings` 同口径——失败项在下次启动时生效）。
 */
async function refreshConfigConsumers(): Promise<void> {
  try {
    const { startSilentUnderstanding, stopSilentUnderstanding } = await import("@/services/observation")
    if (silentAccessConfig.frequency !== "off") startSilentUnderstanding()
    else await stopSilentUnderstanding()
  } catch (error) {
    log.warn("导入配置后静默了解未重应用（配置已落盘；失败项在下次启动时生效）", formatError(error))
  }
  await refreshProactiveConsumer()
}

/**
 * 主动扫描的消费者刷新（动态 `import()`：`proactive` 依赖本模块的 getter，
 * 静态导入会成环；失败只留痕——配置已落盘，刷新失败不该把写入报成失败）。
 */
async function refreshProactiveConsumer(): Promise<void> {
  try {
    const { refreshProactive } = await import("@/services/proactive")
    refreshProactive()
  } catch (error) {
    log.warn("主动扫描未重应用（配置已落盘；失败项在下次启动时生效）", formatError(error))
  }
}

function overrideOr<T>(key: string, fallback: T): T {
  const ov = getAtPath(key);
  return ov !== undefined ? (ov as T) : fallback;
}

// ══════════════════════════════════════════
// 1. 通用配置 (General)
// ══════════════════════════════════════════
export const generalConfig = {
  get popupMode() { return overrideOr("general.popup.mode", cfg.general?.popup?.mode ?? "cursor") as "cursor" | "fixed"; },
  get autoPopupOnMessage() { return overrideOr("general.popup.autoPopupOnMessage", cfg.general?.popup?.autoPopupOnMessage ?? false); },
  get defaultPopupSize() { return overrideOr("general.popup.defaultSize", cfg.general?.popup?.defaultSize ?? { w: 730, h: 450 }); },
  get shortcutKey() { return overrideOr("general.shortcut.key", cfg.general?.shortcut?.key ?? "P"); },
  get shortcutMacModifiers() { return overrideOr("general.shortcut.macModifiers", cfg.general?.shortcut?.macModifiers ?? ["Control", "Command"]); },
  get shortcutWinModifiers() { return overrideOr("general.shortcut.winModifiers", cfg.general?.shortcut?.winModifiers ?? ["Control", "Alt"]); },
  get loggingLevel() { return overrideOr("general.logging.level", cfg.general?.logging?.level ?? (getHostEnvironment().runtimeMode === "development" ? "debug" : "info")) as "debug" | "info" | "warn" | "error"; },
  // `general.desktop.pollingIntervalMs` 已随退役批次彻底删除（原生事件驱动，无轮询间隔）：
  // 没有 getter、无运行期消费者，键与类型块已从 CONFIG.yaml / CONFIG-DEV.yaml.example /
  // 本文件的类型定义里一并移除，原生设置窗的 schema 字段同批删除。不存在兼容读取。
};

/**
 * 运行期真正生效的日志级别 —— logger 的唯一依据。
 *
 * 与 `generalConfig.loggingLevel` 的区别很重要：那个 getter 是**配置的读写接口**
 * （设置面板用它做下拉初值并回写 YAML），不能在 dev 下改写，否则在 dev 里
 * 保存任何设置都会把 `level: debug` 静默写进 CONFIG-DEV.yaml。
 */
export function computeLogLevel(): Level {
  // 开发模式全量打印，忽略配置；生产读 general.logging.level。判据来自宿主运行模式
  // （ServerWelcome.runtimeMode，见 @/services/host 的 HostEnvironment 端口），
  // 不再读 import.meta.env。
  if (getHostEnvironment().runtimeMode === "development") return "debug";
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
  // 有意降级不是掩盖：日志级别下发失败时两端过滤级别不一致，Rust 侧会按其构建默认值过滤，
  // 所以留 debug 级并写明后果（T4.41）。
  getHostBridge().request("set_log_config", { level: LEVEL_ORDER[level] }).catch((error: unknown) =>
    log.debug("日志级别下发 Rust 失败：两端过滤级别不一致，Rust 侧日志会按其构建默认值过滤", formatError(error)));
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

// desktopConfig 随窗口观察事件驱动一起退场：采样不再有轮询间隔这一输入。

// ══════════════════════════════════════════
// 2. AI 配置
// ══════════════════════════════════════════
const _ai = {
  get provider() { return overrideOr("ai.provider", cfg.ai?.provider ?? "deepseek"); },
  get endpoint() { return overrideOr("ai.endpoint", cfg.ai?.endpoint || ""); },
  get apiKey() { return overrideOr("ai.apiKey", cfg.ai?.apiKey || ""); },
  get model() { return overrideOr("ai.model", cfg.ai?.model || "deepseek-chat"); },
  get auxModel() { return overrideOr("ai.auxModel", cfg.ai?.auxModel || ""); },
  get contextMaxTokens() { return overrideOr("ai.contextMaxTokens", cfg.ai?.contextMaxTokens ?? DEFAULT_CONTEXT_WINDOW); },
  get thinkingEffort() { return overrideOr("ai.thinking.effort", cfg.ai?.thinking?.effort || "auto") as import("@/services/agent/types").ThinkingEffort; },
  get requireApiKey() { return overrideOr("ai.requireApiKey", cfg.ai?.requireApiKey ?? true); },
  get configured() { if (!this.endpoint) return false; if (!this.requireApiKey) return true; return Boolean(this.apiKey); },
};

export const aiConfig = _ai;

export const personalityConfig = {
  get active() { return overrideOr("ai.personality.active", cfg.ai?.personality?.active || ""); },
};

/**
 * 对话投递（§3.1）：defaultDelivery 只决定忙碌时未显式选择意图的默认；
 * steeringMode / followUpMode 是队列批量策略，按运行冻结（运行开始前下发）。
 * 手写 YAML 里的未知取值一律按保守默认读取，不把非法值透传到运行内核。
 */
export const conversationConfig = {
  get defaultDelivery() {
    const value = overrideOr("ai.conversation.defaultDelivery", cfg.ai?.conversation?.defaultDelivery);
    return (value === "followUp" ? "followUp" : "steer") as DeliveryIntent;
  },
  get steeringMode() {
    const value = overrideOr("ai.conversation.steeringMode", cfg.ai?.conversation?.steeringMode);
    return (value === "one-at-a-time" ? "one-at-a-time" : "all") as QueueMode;
  },
  get followUpMode() {
    const value = overrideOr("ai.conversation.followUpMode", cfg.ai?.conversation?.followUpMode);
    return (value === "all" ? "all" : "one-at-a-time") as QueueMode;
  },
};

export const humanizerConfig = {
  get enabled() { return overrideOr("ai.humanizer.enabled", cfg.ai?.humanizer?.enabled ?? true); },
};

/**
 * 主动消息档位与静默时间段（契约 §2.1）。
 *
 * `frequency` 是主动消息的总闸 + 频率（off = 不唤醒、不产生机会、不发送）；
 * 静默时间段只约束主动消息（该时段不唤醒 / 不产生机会 / 不发送），夜间判定由
 * `proactive/time.ts` 按同一份值负责；白天不设窗口。档位数值表在 `proactive/tiers.ts`。
 */
export const proactiveConfig = {
  get frequency() { return readFrequencyTier(overrideOr("ai.proactive.frequency", cfg.ai?.proactive?.frequency), "ai.proactive.frequency"); },
  /** 静默开始（本地小时 0–23）；跨夜语义 start > end，start == end = 不静默。 */
  get quietStartHour() { return readQuietHour(overrideOr("ai.proactive.quietStartHour", cfg.ai?.proactive?.quietStartHour), "ai.proactive.quietStartHour", 23); },
  /** 静默结束（本地小时 0–23）；非静默从该时刻起。 */
  get quietEndHour() { return readQuietHour(overrideOr("ai.proactive.quietEndHour", cfg.ai?.proactive?.quietEndHour), "ai.proactive.quietEndHour", 9); },
};

/**
 * 写入主动消息档位（斜杠命令 `/proactive on|off` 的唯一入口；设置页走 `settings_commit`）。
 *
 * 与设置保存共用同一条写路径：`setOverride`（写内存 cfg + 入写队列）→ `flushConfig()`
 * 原子写盘，不新建第二条写盘路径。写盘成功后刷新主动扫描消费者；写盘失败如实抛出
 * （配置未落盘），由调用方决定如何向用户呈现。
 */
export async function setProactiveFrequency(tier: FrequencyTier): Promise<void> {
  setOverride("ai.proactive.frequency", tier)
  await flushConfig()
  await refreshProactiveConsumer()
}

export const silentAccessConfig = {
  /** 静默了解总闸 + 频率（off = 调度器不启动；读取靠手动）。 */
  get frequency() { return readFrequencyTier(overrideOr("ai.silentAccess.frequency", cfg.ai?.silentAccess?.frequency), "ai.silentAccess.frequency"); },
};

export const aiLockConfig = {
  get safetyTimeoutMs() { return overrideOr("ai.lock.safetyTimeoutMs", cfg.ai?.lock?.safetyTimeoutMs || 30000); },
};

export const memoryConfig = {
  get enabled() { return overrideOr("ai.memory.enabled", cfg.ai?.memory?.enabled ?? true); },
  get coreTokenBudget() { return overrideOr("ai.memory.coreTokenBudget", cfg.ai?.memory?.coreTokenBudget ?? 320); },
  get recallTokenBudget() { return overrideOr("ai.memory.recallTokenBudget", cfg.ai?.memory?.recallTokenBudget ?? 1000); },
  get rerank() { return overrideOr("ai.memory.rerank", cfg.ai?.memory?.rerank || "off") as "off" | "adaptive"; },
  get recallTimeoutMs() { return overrideOr("ai.memory.recallTimeoutMs", cfg.ai?.memory?.recallTimeoutMs ?? 4000); },
  get rerankTimeoutMs() { return overrideOr("ai.memory.rerankTimeoutMs", cfg.ai?.memory?.rerankTimeoutMs ?? 2500); },
  /** 整理档位（off = 不自动跑，手动入口保留）；档位数值表在 `proactive/tiers.ts`。 */
  get dreamingTier() { return readFrequencyTier(overrideOr("ai.memory.dreaming.tier", cfg.ai?.memory?.dreaming?.tier), "ai.memory.dreaming.tier"); },
  /** Review 输出上限：null/未配置=按模型输出预算自动推导（仍受上下文窗口约束）；显式值只作为更小的上限。 */
  get dreamingReviewMaxTokens(): number | null { return overrideOr("ai.memory.dreaming.reviewMaxTokens", cfg.ai?.memory?.dreaming?.reviewMaxTokens ?? null); },
  get maxSessions() { return overrideOr("ai.memory.maxSessions", cfg.ai?.memory?.maxSessions ?? 20); },
};

export const planConfig = {
  get enabled() { return overrideOr("ai.plan.enabled", cfg.ai?.plan?.enabled ?? true); },
  get complexityThreshold() { return overrideOr("ai.plan.complexityThreshold", cfg.ai?.plan?.complexityThreshold ?? 3); },
  /** 复杂度评估方式：keyword 只用关键词（未命中直接低分，不发请求）；llm 未命中时再发一次独立请求。 */
  get complexityEval() { return overrideOr("ai.plan.complexityEval", cfg.ai?.plan?.complexityEval || "keyword") as "keyword" | "llm" },
  get maxSteps() { return overrideOr("ai.plan.maxSteps", cfg.ai?.plan?.maxSteps ?? 8); },
  get stepTimeoutMs() { return overrideOr("ai.plan.stepTimeoutMs", cfg.ai?.plan?.stepTimeoutMs ?? 90000); },
  get stepMaxRounds() { return overrideOr("ai.plan.stepMaxRounds", cfg.ai?.plan?.stepMaxRounds ?? 5); },
  get thinkingEffort() { return overrideOr("ai.plan.thinkingEffort", cfg.ai?.plan?.thinkingEffort || "medium") as import("@/services/agent/types").ThinkingEffort; },
  get stepThinkingEffort() { return overrideOr("ai.plan.stepThinkingEffort", cfg.ai?.plan?.stepThinkingEffort || "low") as import("@/services/agent/types").ThinkingEffort; },
  get onStepFailure() { return overrideOr("ai.plan.onStepFailure", cfg.ai?.plan?.onStepFailure || "continue") as "continue" | "abort" | "ask"; },
  get keywords() { return overrideOr("ai.plan.keywords", cfg.ai?.plan?.keywords || ["分析", "整理", "重构", "修复", "审查", "合并", "总结", "生成", "创建项目"]) as string[]; },
};

/**
 * 共享读并行上限（`ai.loop.maxParallelTools`）的取值范围与默认值。
 *
 * Rust 是上限的所有者与默认值来源（crates/native-host/src/commands/tool_permit.rs 是宿主侧
 * 唯一的额度定义点）：这里的常量是设置校验副本，不构成第二个所有者；两者一致性由
 * `tool-execution-permit` 场景的可执行边界钉保证（上限原值被接受、两侧越界被拒绝）。
 */
export const MIN_PARALLEL_TOOLS = 1
export const MAX_PARALLEL_TOOLS = 8
export const DEFAULT_PARALLEL_TOOLS = 4

/**
 * 手写 YAML 的共享读上限收拢成范围内的整数：非数值按默认值，越界按最近边界。
 * 不把非法值透传给运行内核（设置页保存会先报错，Rust 下发还会再拒绝一次越界）。
 */
export function clampParallelTools(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PARALLEL_TOOLS
  return Math.min(MAX_PARALLEL_TOOLS, Math.max(MIN_PARALLEL_TOOLS, Math.floor(value)))
}

/** 设置页保存前的范围校验：合法返回 undefined（与 contextWindowError 同一用法）。 */
export function parallelToolsError(value: number): string | undefined {
  if (!Number.isInteger(value) || value < MIN_PARALLEL_TOOLS || value > MAX_PARALLEL_TOOLS) {
    return `同时执行的只读工具数必须是 ${MIN_PARALLEL_TOOLS}-${MAX_PARALLEL_TOOLS} 的整数（当前 ${value}）`
  }
  return undefined
}

export const loopConfig = {
  get maxRetry() { return overrideOr("ai.loop.maxRetry", cfg.ai?.loop?.maxRetry ?? 3); },
  get maxToolCallsPerTurn() { return overrideOr("ai.loop.maxToolCallsPerTurn", cfg.ai?.loop?.maxToolCallsPerTurn ?? 5); },
  get toolTimeoutMs() { return overrideOr("ai.loop.toolTimeoutMs", cfg.ai?.loop?.toolTimeoutMs ?? 30000); },
  get turnTimeoutMs() { return overrideOr("ai.loop.turnTimeoutMs", cfg.ai?.loop?.turnTimeoutMs ?? 120000); },
  get dedupWindowMs() { return overrideOr("ai.loop.dedupWindowMs", cfg.ai?.loop?.dedupWindowMs ?? 30000); },
  get maxVisibleMessages() { return overrideOr("ai.loop.maxVisibleMessages", cfg.ai?.loop?.maxVisibleMessages ?? 200); },
  /** 同时执行的只读工具数（`ai.loop.maxParallelTools`）；每个 run 开始前下发给许可所有者。 */
  get maxParallelTools() { return clampParallelTools(overrideOr("ai.loop.maxParallelTools", cfg.ai?.loop?.maxParallelTools)); },
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
  get mcpServers() { return overrideOr("tools.mcp.servers", cfg.tools?.mcp?.servers || []); },
};

/** CONFIG 里每服务器条目的最小读面：只取名字与启用位，其余字段由工具层归一化。 */
type McpServerEntry = { name?: unknown; enabled?: unknown };

/** 单条 MCP 服务器配置是否启用：缺省即启用，只有显式 `enabled: false` 才算关闭。 */
function mcpServerEnabled(entry: McpServerEntry | null | undefined): boolean {
  return entry?.enabled !== false;
}

/**
 * 启用的 MCP 服务器名（来自 `tools.mcp.servers` 的自定义列表）。
 *
 * 这是「MCP 是否生效」与「本轮该借用哪些服务器」的唯一口径：`computeMcpEnabled()`
 * 与 `init.ts` 的按 run 借用遍历都读本函数，两处不再各自判一遍（决策 8：控制面在
 * 每服务器的 `enabled`，没有总闸；全部关掉即为未启用）。
 */
export function enabledMcpServerNames(): string[] {
  return (toolsConfig.mcpServers as McpServerEntry[])
    .filter(mcpServerEnabled)
    .map(entry => String(entry.name || ""));
}

/**
 * 运行期 MCP 是否生效：至少一个服务器启用。
 * 派生值只服务运行期消费者，不回写设置页读写 —— 否则打开设置再保存会把用户配置
 * 静默改写成派生结果（同 generalConfig.loggingLevel 与 computeLogLevel 的分工）。
 */
export function computeMcpEnabled(): boolean {
  return enabledMcpServerNames().length > 0;
}

// ══════════════════════════════════════════
// 4. 外观 — Profile 系统
// 主题/角色/音效由运行时 data_root/profiles/ 管理
// ==========================================
export const appearanceConfig = {
  get activeProfile() { return overrideOr("appearance.activeProfile", cfg.appearance?.activeProfile ?? DEFAULT_PROFILE); },
  /**
   * 聊天图片自动预览开关；默认 false —— **唯一默认值在本 getter**，设置页与消费方都不复制它。
   *
   * 关闭（默认）：历史/滚动/切会话/初次加载只显示图片占位（序号/文件名/可用状态），
   * 不读取图片字节、不解码、不生成缩略图；点击占位仍可打开独立查看器。
   * 开启：只为当前可见消息按需加载内联预览；离开视口、切会话、收起或关闭聊天视图时
   * 释放内联资源。两者都不影响模型看图、图片选择/发送、截图与 JSONL 原路径。
   */
  get chatImagePreview() { return overrideOr("appearance.chatImagePreview", cfg.appearance?.chatImagePreview ?? false); },
  /** 全局字体家族名；空串 = 跟随系统默认字体栈（由消费方决定具体栈） */
  get fontFamily() { return overrideOr("appearance.font.family", cfg.appearance?.font?.family ?? ""); },
  get fontSize() { return overrideOr("appearance.font.size", cfg.appearance?.font?.size ?? DEFAULT_FONT_SIZE); },
};

/** 设置页保存前的范围校验：合法返回 undefined（与 parallelToolsError 同一用法）。 */
export function fontSizeError(value: number): string | undefined {
  if (!Number.isInteger(value) || value < MIN_FONT_SIZE || value > MAX_FONT_SIZE) {
    return `全局字号必须是 ${MIN_FONT_SIZE}-${MAX_FONT_SIZE} 的整数（当前 ${value}）`
  }
  return undefined
}

// 开发时日志已并入 initConfig()（模块加载早于配置读取；那里才有真实的 endpoint/provider）。
