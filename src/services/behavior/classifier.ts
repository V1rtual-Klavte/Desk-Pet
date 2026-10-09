import type { AppCategory } from "./types"

export type ClassificationMethod = "app_id" | "title" | "unclassified" | "unavailable"
export type ClassificationConfidence = "high" | "low" | "none"
export type ActivityHint = "media"

export interface AppClassification {
  category: AppCategory
  method: ClassificationMethod
  confidence: ClassificationConfidence
  activityHint?: ActivityHint
}

const APP_ID_RULES: ReadonlyArray<readonly [readonly string[], AppCategory]> = [
  [["code", "code-insiders", "com.microsoft.vscode", "com.microsoft.vscode-insiders", "cursor", "idea", "idea64", "pycharm", "pycharm64", "webstorm", "webstorm64", "rider", "rider64", "xcode", "terminal", "iterm", "iterm2", "wezterm", "wezterm-gui", "powershell", "pwsh", "windows terminal"], "development"],
  [["slack", "discord", "teams", "ms-teams", "wechat", "weixin", "qq", "dingtalk", "feishu", "lark", "telegram", "outlook", "mail", "wecom", "wxwork", "wemeetapp", "com.tencent.xinwechat", "com.tencent.qq", "com.tencent.weworkmac", "com.tencent.meeting"], "communication"],
  [["spotify", "vlc", "neteasemusic", "netease music", "qqmusic", "bilibili", "bili", "potplayer", "netflix", "twitch", "com.spotify.client", "org.videolan.vlc", "com.netease.163music", "com.tencent.qqmusicmac"], "media"],
  [["chrome", "google chrome", "safari", "firefox", "msedge", "edge", "brave", "brave-browser", "arc", "opera", "com.google.chrome", "com.apple.safari", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.browser"], "browser"],
  [["word", "winword", "excel", "powerpnt", "powerpoint", "notion", "obsidian", "pages", "numbers", "keynote", "wps", "wpp", "et", "wps office", "com.microsoft.word", "com.microsoft.excel", "com.microsoft.powerpoint", "md.obsidian", "notion.id", "com.kingsoft.wpsoffice.mac"], "work"],
]

// A window title is private, unstable content. Only inspect it transiently for a
// broad media cue; never return or persist any part of the title.
const MEDIA_TITLE_HINT = /(?:youtube|哔哩哔哩|bilibili|netflix|spotify|twitch|music|video|podcast|音乐|视频|直播|播客)/i

function normalizeAppId(value: string): string {
  const trimmed = value.trim()
  const parts = trimmed.split(/[\\/]/)
  const basename = parts[parts.length - 1] ?? trimmed
  return basename.replace(/\.exe$/i, "").trim().toLocaleLowerCase("en-US")
}

function matchesAppId(identity: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => identity === alias || identity.endsWith(`.${alias}`))
}

function categoryForAppId(appId: string): AppCategory | undefined {
  const identity = normalizeAppId(appId)
  for (const [aliases, category] of APP_ID_RULES) {
    if (matchesAppId(identity, aliases)) return category
  }
  return undefined
}

function hasMediaTitleHint(title: string | null): boolean {
  return title !== null && MEDIA_TITLE_HINT.test(title)
}

export function classifyApp(appId: string | null, title: string | null): AppClassification {
  const identity = appId?.trim() ?? ""
  const titleText = title?.trim() ?? ""
  const activityHint = hasMediaTitleHint(titleText) ? "media" : undefined

  if (!identity && !titleText) {
    return { category: "unknown", method: "unavailable", confidence: "none" }
  }

  if (identity) {
    const category = categoryForAppId(identity)
    if (category) return { category, method: "app_id", confidence: "high", ...(activityHint ? { activityHint } : {}) }
  }

  if (activityHint) return { category: "unknown", method: "title", confidence: "low", activityHint }
  return { category: "unknown", method: "unclassified", confidence: "none" }
}
