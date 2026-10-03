import type { AppCategory } from "./types"

const APP_RULES: ReadonlyArray<[RegExp, AppCategory]> = [
  [/\b(code|visualstudio|vscode|idea|pycharm|xcode|terminal|iterm|wezterm|powershell|cursor)\b/i, "development"],
  [/\b(slack|discord|teams|zoom|wechat|dingtalk|telegram|mail|outlook)\b/i, "communication"],
  [/\b(video|youtube|netflix|spotify|music|vlc|bilibili|twitch)\b/i, "media"],
  [/\b(chrome|safari|firefox|edge|browser|brave)\b/i, "browser"],
  [/\b(word|excel|powerpoint|notion|obsidian|pages|numbers|keynote)\b/i, "work"],
]

export function classifyApp(appId: string | null, title: string | null): AppCategory {
  const identity = appId?.trim() ?? ""
  const titleText = title?.trim() ?? ""
  for (const [rule, category] of APP_RULES) if (rule.test(identity)) return category
  for (const [rule, category] of APP_RULES) if (rule.test(titleText)) return category
  return identity || titleText ? "other" : "unknown"
}
