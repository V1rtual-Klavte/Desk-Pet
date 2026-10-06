import type { SlashCommand } from "../types"
import { getCommandReply, getActiveCard } from "@/services/personality"
import { getActiveSessionId } from "@/services/session"
import { harnessSlots } from "@/services/engine/harness"
import { clearBehavior, proactiveStatus } from "@/services/proactive"
import type { ProactiveOwner } from "@/services/proactive"
import { proactiveConfig, setProactiveFrequency } from "@/services/config"
import { formatError } from "@/services/error"

function owner():ProactiveOwner {
  const sessionId=getActiveSessionId(),card=getActiveCard()
  if(!sessionId||!card)throw new Error("当前没有会话或Card")
  return {sessionId,cardId:card.id,cardHash:card.hash,runGeneration:harnessSlots.snapshot(sessionId)?.generation??0}
}

/** 档位显示名（与设置页四档「关/低/中/高」同口径；斜杠状态行是系统文本）。 */
const TIER_LABELS:Record<string,string>={off:"关",low:"低",medium:"中",high:"高"}

// 档位（`ai.proactive.frequency`）是主动消息的唯一开关：
// - `on` 恢复为出厂默认「高」档（同步点：CONFIG.yaml 与 CONFIG-DEV.yaml.example 的
//   ai.proactive.frequency；改出厂值须同步此处），不记忆上次档位（用户说「开」是恢复默认陪伴，不是恢复上次调参）；
// - `off` 即总闸关闭（不唤醒 / 不产生机会 / 不发送），与设置页「关」同一语义。
export const proactiveCommands:SlashCommand[]=[
  {name:"proactive on",description:"开启主动陪伴（档位恢复出厂默认「高」）",category:"general",busyPolicy:"coordinated",async execute(){try{await setProactiveFrequency("high");return getCommandReply("proactiveEnabled")}catch(error){return `主动陪伴设置失败：${formatError(error)}`}}},
  {name:"proactive off",description:"关闭主动陪伴（档位置「关」）",category:"general",busyPolicy:"coordinated",async execute(){try{await setProactiveFrequency("off");return getCommandReply("proactiveDisabled")}catch(error){return `主动陪伴设置失败：${formatError(error)}`}}},
  {name:"proactive status",description:"查询主动陪伴档位与当日额度",category:"general",busyPolicy:"immediate",async execute(){try{const status=await proactiveStatus(owner());const tier=proactiveConfig.frequency;return `${getCommandReply("proactiveStatus")}\n当前档位 ${TIER_LABELS[tier]}（${tier}） · 今日主动送达 ${status.budget.successfulMessages} 次${status.control.muteUntil?" · 暂停中":""}`}catch(error){return `主动陪伴状态读取失败：${formatError(error)}`}}},
  {name:"behavior clear",description:"清除行为画像与其派生机会",category:"general",busyPolicy:"exclusive",async execute(){try{await clearBehavior(owner());return getCommandReply("behaviorCleared")}catch(error){return `行为画像清除失败：${formatError(error)}`}}},
]
