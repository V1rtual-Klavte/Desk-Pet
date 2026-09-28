// ==========================================
// /skill <技能名> [额外指示] — 显式调用技能
//
// 命令只做两件事：判定这次调用能不能启动（索引 → 名字 → 开关 → 正文），以及把准入意图交出去。
// 落盘与驱动都在运行入口：正文由 Pi 在 `accept` 内按技能文件构造并提交（先落盘再投递），
// 命令层不写会话条目 —— 一条命令只能落一条用户正文，宿主再投一次就是第二份。
// ==========================================

import type { SlashCommand, SlashCommandResult } from "../types"
import { summarizeError } from "@/services/error"
import { getCommandReply } from "@/services/personality"
import { getSkillCatalogError, listSkills, syncSkillCatalog } from "@/services/skill"

/**
 * 终态句取当前 Card（`getCommandReply`）；技能名与失败原因是诊断事实，只作中性明细附在句后
 * （与 `/compact` 的排队明细同一口径：角色台词里塞插值会让用户分不清「命令没跑成」和「角色在说话」）。
 */
function withSkillName(line: string, name: string): string {
  return `${line}\n技能名：${name}`
}

export const skillCommand: SlashCommand<SlashCommandResult> = {
  name: "skill",
  description: "调用技能：把技能正文加入本次对话",
  category: "skill",
  args: "<技能名> [额外指示]",
  // 启动技能要一次运行代际（Harness 在 accept 内落盘）：忙碌期由运行入口按并发拒绝如实回复，
  // 不在回合中途排队，也不谎称已启动。
  busyPolicy: "coordinated",
  acceptsArgs: true,
  async execute(args) {
    const text = (args ?? "").trim()
    if (!text) {
      // 没给名字就无从查找：说清用法，不把它当「技能不存在」（那会把命令的输入错误说成技能的问题）。
      return `${getCommandReply("skillUnknown")}\n未给出技能名（用法：/skill <技能名> [额外指示]）`
    }
    const separator = text.search(/\s/)
    const name = separator < 0 ? text : text.slice(0, separator)
    const additionalInstructions = separator < 0 ? "" : text.slice(separator).trim()

    // 技能清单的唯一刷新入口：名字能不能启动只能按当前清单判。核对失败时清单是上一份（首次启动时为空），
    // 那种状态必须先报「查不了」—— 此时任何名字都会在 Harness 边界表现成 UnknownSkill。
    await syncSkillCatalog()
    const catalogError = getSkillCatalogError()
    if (catalogError) {
      // 系统故障中性报出：不套 Card 的终态句（「未找到该技能」会把读取失败说成技能不存在）。
      // 这条回复由 runner 经 pushSystemMessage 落盘（deskpet.system_message），按落盘口径用脱敏摘要。
      return `技能索引不可用，技能没有启动：${summarizeError(catalogError)}`
    }

    const skill = listSkills().find(candidate => candidate.name === name)
    if (!skill) return withSkillName(getCommandReply("skillUnknown"), name)
    // 被关闭（frontmatter `enabled: false`）与不存在是两回事：前者用户能自己打开，报「不存在」会把人引向错误的方向。
    if (!skill.enabled) return withSkillName(getCommandReply("skillDisabled"), name)
    if (!skill.content.trim()) return withSkillName(getCommandReply("skillEmpty"), name)

    // 余下文本是附加指示，可为空；「是否启动得了」由运行入口按运行代际与 lane 准入裁定。
    return additionalInstructions
      ? { name: skill.name, additionalInstructions }
      : { name: skill.name }
  },
}
