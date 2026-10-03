export type * from "./types"
export { query, change } from "./ipc"
export { start, stop, tick, offer, configureProactive, cancelCurrent, refreshProactive } from "./scanner"
export { createActiveExpressionAdapter } from "./delivery"
export { getPresence, subscribePresence, setPresence, clearPresence, requestBriefMotion, stopPresence } from "./presence"
export type { PresenceState, PresenceSnapshot } from "./presence"
import * as ipc from "./ipc"
import { accountedUsage } from "./usage"
import { cancelCurrent, applyEnabled, discardDerivedSources } from "./scanner"
import { clearBehavior as clearDerivedBehavior, getBehaviorSnapshot } from "@/services/behavior"
import { getActiveCard } from "@/services/personality"
import { recallMemory } from "@/services/agent/memory"
import { readActiveAttemptEvidence } from "@/services/engine/harness"
import { readPiSessionEntriesOnce } from "@/services/session"
import type { ProactiveOwner } from "./protocol"
import { contentPool } from "./content/pool"
import { localDayKey } from "./time"
import { SOURCE_CONTEXT_BUDGET, RECENT_TARGET_LIMIT } from "./config"
import { createRuntimeTraceContext, trace } from "./trace"

/** SQLite is authoritative; the session reader never interprets a UI counter as delivery proof. */
export async function readReceipt(sessionId:string,attemptId:string,assistantEntryId:string):Promise<boolean> {
  const card=getActiveCard()
  if(!card)return false
  const owner:ProactiveOwner={sessionId,cardId:card.id,cardHash:card.hash,runGeneration:0}
  const result=await ipc.query({owner,sessionId,attemptIds:[attemptId],limit:1})
  const attempt=result.attempts[0]
  return attempt?.status==="committed"&&attempt.assistantEntryId===assistantEntryId
}

export async function reconcileSession(sessionId:string):Promise<void> {
  const card=getActiveCard()
  if(!card)return
  const owner:ProactiveOwner={sessionId,cardId:card.id,cardHash:card.hash,runGeneration:0}
  const result=await ipc.query({owner,sessionId,limit:100})
  for(const attempt of result.attempts) {
    if(attempt.status!=="unresolved"&&attempt.status!=="reserved"&&attempt.status!=="generating")continue
    const proof=await readActiveAttemptEvidence(sessionId,attempt.attemptId,attempt.requestId)
    // Missing proof is still unknown. An old attempt cannot cause an automatic external replay.
    if(!proof)continue
    await ipc.reconcile({attemptId:attempt.attemptId,owner:attempt.owner,sourceFingerprint:attempt.sourceFingerprint,localDate:attempt.localDate,assistantEntryId:proof.assistantEntryId,committed:true,usage:accountedUsage(proof.usage)})
    trace(createRuntimeTraceContext(sessionId,attempt.requestId),"proactive_reconciled",()=>({attemptId:attempt.attemptId,assistantEntryId:proof.assistantEntryId,status:"committed"}))
  }
}

export async function getTurnContext(owner:ProactiveOwner):Promise<{text:string;taskRefs:Array<{taskId:string;memoryItemId?:string;expectedVersion:number}>}|undefined> {
  const result=await ipc.query({owner,limit:RECENT_TARGET_LIMIT})
  const tasks=result.tasks.slice(0,RECENT_TARGET_LIMIT)
  const targets=[...new Map(tasks.flatMap(task=>task.sourceRefs.filter(ref=>ref.kind==="memory").map(ref=>({id:ref.id,version:ref.version}))).map(ref=>[ref.id,ref])).values()]
  const evidence=targets.length?await recallMemory({requestId:`proactive-turn-${crypto.randomUUID()}`,sessionId:owner.sessionId,
    cardId:owner.cardId,runGeneration:owner.runGeneration,purpose:"proactive",targets,allowExpiredTargets:true,query:"",tokenBudget:SOURCE_CONTEXT_BUDGET}):[]
  const card=getActiveCard()
  const entries=await readPiSessionEntriesOnce(owner.sessionId)
  const user=entries.slice().reverse().find(entry=>entry.type==="message"&&entry.message.role==="user")
  const userText=user?.type==="message"&&"content" in user.message
    ?((user.message.content as Array<{type:string;text?:string}>).filter(part=>part.type==="text").map(part=>part.text??"").join("")):""
  const topic=card&&/聊聊|聊点|随便聊|没事聊|说点什么|讲个.*故事/.test(userText)?contentPool(card,getBehaviorSnapshot(),owner,localDayKey(Date.now(),Intl.DateTimeFormat().resolvedOptions().timeZone)):null
  if(!tasks.length&&!topic)return undefined
  return {text:JSON.stringify({tasks:tasks.map(task=>({id:task.id,version:task.version,intent:task.intent,nextCheckinAt:task.nextCheckinAt,
    recurrence:task.recurrence,state:task.state})),memoryEvidence:evidence,topic:topic?.context,
    instruction:"任务元数据只用于澄清、完成、改期或延后；多个候选目标有歧义时先问用户，不自行挑选。来源正文仍以MemoryProvider投影为准。"}),
    taskRefs:tasks.map(task=>({taskId:task.id,expectedVersion:task.version,...(task.sourceRefs.find(ref=>ref.kind==="memory")?{memoryItemId:task.sourceRefs.find(ref=>ref.kind==="memory")!.id}:{})}))}
}

export async function setEnabled(enabled:boolean,owner:ProactiveOwner):Promise<void> {
  cancelCurrent("control_changed")
  const state=await ipc.query({owner,limit:1})
  await ipc.control({operationId:crypto.randomUUID(),baseRevision:state.revision,owner,patch:{enabled}})
  applyEnabled(enabled)
}
export async function clearBehavior(owner:ProactiveOwner):Promise<void> {
  cancelCurrent("behavior_cleared")
  const state=await ipc.query({owner,limit:1})
  await ipc.control({operationId:crypto.randomUUID(),baseRevision:state.revision,owner,patch:{clearBehaviorSources:true}})
  discardDerivedSources()
  await clearDerivedBehavior()
  trace(createRuntimeTraceContext(owner.sessionId),"behavior_cleared",()=>({status:"committed"}))
}
export async function proactiveStatus(owner:ProactiveOwner) {
  const now=Date.now(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone
  return ipc.scan({owner,now,localDate:localDayKey(now,timezone),limit:1})
}
