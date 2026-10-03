import type { SlashCommand } from "../types"
import { getCommandReply, getActiveCard } from "@/services/personality"
import { getActiveSessionId } from "@/services/session"
import { harnessSlots } from "@/services/engine/harness"
import { clearBehavior, setEnabled, proactiveStatus } from "@/services/proactive"
import type { ProactiveOwner } from "@/services/proactive"
import { formatError } from "@/services/error"

function owner():ProactiveOwner {
  const sessionId=getActiveSessionId(),card=getActiveCard()
  if(!sessionId||!card)throw new Error("当前没有会话或Card")
  return {sessionId,cardId:card.id,cardHash:card.hash,runGeneration:harnessSlots.snapshot(sessionId)?.generation??0}
}
export const proactiveCommands:SlashCommand[]=[
  {name:"proactive on",description:"开启主动陪伴",category:"general",busyPolicy:"exclusive",async execute(){try{await setEnabled(true,owner());return getCommandReply("proactiveEnabled")}catch(error){return `主动陪伴设置失败：${formatError(error)}`}}},
  {name:"proactive off",description:"关闭主动陪伴",category:"general",busyPolicy:"coordinated",async execute(){try{await setEnabled(false,owner());return getCommandReply("proactiveDisabled")}catch(error){return `主动陪伴设置失败：${formatError(error)}`}}},
  {name:"proactive status",description:"查询主动陪伴控制与当日额度",category:"general",busyPolicy:"immediate",async execute(){try{const status=await proactiveStatus(owner());return `${getCommandReply("proactiveStatus")}\n${status.control.enabled?"已开启":"已关闭"} · 今日主动送达 ${status.budget.successfulMessages} 次${status.control.muteUntil?" · 暂停中":""}`}catch(error){return `主动陪伴状态读取失败：${formatError(error)}`}}},
  {name:"behavior clear",description:"清除行为画像与其派生机会",category:"general",busyPolicy:"exclusive",async execute(){try{await clearBehavior(owner());return getCommandReply("behaviorCleared")}catch(error){return `行为画像清除失败：${formatError(error)}`}}},
]
