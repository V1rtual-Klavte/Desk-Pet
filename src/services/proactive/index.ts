export type * from "./types"
export { proactiveEvent, createRuntimeTraceContext } from "./trace"
export { query, change } from "./ipc"
export { start, stop, tick, offer, configureProactive, cancelCurrent, refreshProactive } from "./scanner"
export { createActiveExpressionAdapter } from "./delivery"
export { getPresence, subscribePresence, setPresence, clearPresence, requestBriefMotion, stopPresence } from "./presence"
export type { PresenceState, PresenceSnapshot } from "./presence"
// 这里只导出主动控制的领域侧入口：处理请求与接状态分发（原生宿主迁移过程记录 §9.4 第 7 条）。
export { handleProactiveControlRequest, publishProactiveControl, subscribeProactiveControl } from "./control"
export { reserveAuxiliaryBudget, settleAuxiliaryBudget } from "./auxiliary-budget"
export { OBSERVATION_MAX_AGE_MS } from "./config"
import * as ipc from "./ipc"
import { accountedUsage } from "./usage"
import { cancelCurrent, applyEnabled, discardDerivedSources } from "./scanner"
import { clearBehavior as clearDerivedBehavior, getBehaviorSnapshot } from "@/services/behavior"
import { getActiveCard } from "@/services/personality"
import { readActiveAttemptEvidence } from "@/services/engine/harness"
import { readPiSessionEntriesOnce } from "@/services/session"
import type { ProactiveOwner, ProactiveSourceRef, ProactiveTask } from "./protocol"
import type { ProactiveTurnContext, RecurrenceProposal } from "./types"
import { contentPool } from "./content/pool"
import { localDayKey } from "./time"
import { RECENT_TARGET_LIMIT } from "./config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
const log=createLogger("ProactiveContext")
import { createRuntimeTraceContext, trace } from "./trace"
import { publishProactiveControl } from "./control"

/** SQLite is authoritative; the session reader never interprets a UI counter as delivery proof. */
export async function readReceipt(sessionId:string,attemptId:string,assistantEntryId:string):Promise<boolean> {
  const card=getActiveCard()
  const owner:ProactiveOwner={sessionId,cardId:card?.id??"",cardHash:card?.hash??"",runGeneration:0}
  const result=await ipc.query({owner,sessionId,receiptLookup:{attemptId,assistantEntryId},limit:1})
  return result.receipt?.committed===true
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

/** A proposal is a committed successful tool exchange, followed by an actual proposal to the user. */
function readRecurrenceProposals(entries: Awaited<ReturnType<typeof readPiSessionEntriesOnce>>, owner: ProactiveOwner): RecurrenceProposal[] {
  const messages = entries.filter(entry => entry.type === "message")
  const latestUser = messages.reduce((latest, entry, index) => entry.message.role === "user" ? index : latest, -1)
  const tail = messages.slice(latestUser + 1)
  const assistant = [...tail].reverse().find(entry => entry.message.role === "assistant")
  if (!assistant || assistant.message.role !== "assistant") return []
  const visible = assistant.message.content.filter(part => part.type === "text").map(part => part.text).join("\n")
  if (!/[?？]|要不要|是否|好吗|可以吗/.test(visible)) return []
  const calls = new Map<string, { entryId: string; intent: unknown }>()
  for (const entry of tail) {
    if (entry.message.role !== "assistant") continue
    for (const part of entry.message.content) {
      if (part.type === "toolCall" && part.name === "proactive_change" && part.arguments.action === "propose") {
        calls.set(part.id, { entryId: entry.id, intent: part.arguments.intent })
      }
    }
  }
  const proposals: RecurrenceProposal[] = []
  for (const entry of tail) {
    if (entry.message.role !== "toolResult" || entry.message.isError || entry.seq >= assistant.seq) continue
    const call = calls.get(entry.message.toolCallId)
    if (!call) continue
    const text = entry.message.content.filter(part => part.type === "text").map(part => part.text).join("")
    try {
      const result = JSON.parse(text) as { proposal?: Omit<RecurrenceProposal, "assistantEntryId"> }
      const proposal = result.proposal
      if (!proposal || proposal.proposalId !== entry.message.toolCallId || proposal.intent !== call.intent
        || !proposal.recurrence || proposal.nextCheckinAt <= Date.now()
        || (proposal.validUntil !== null && proposal.validUntil <= Date.now())
        || proposal.owner?.sessionId !== owner.sessionId || proposal.owner.cardId !== owner.cardId || proposal.owner.cardHash !== owner.cardHash
        || !visible.includes(proposal.intent)) continue
      proposals.push({ ...proposal, assistantEntryId: call.entryId })
    } catch (error) {
      // Only structured successful exchanges can confer proposal identity; malformed results remain in JSONL.
      log.warn("周期提议证据无效，忽略该提议:", formatError(error))
    }
  }
  return proposals
}

export async function getTurnContext(owner: ProactiveOwner, userText: string): Promise<ProactiveTurnContext | undefined> {
  const [result, delivered, entries] = await Promise.all([
    ipc.query({owner,limit:100}), ipc.query({owner,recentDelivered:true,limit:RECENT_TARGET_LIMIT}), readPiSessionEntriesOnce(owner.sessionId),
  ])
  const traceContext = createRuntimeTraceContext(owner.sessionId)
  type FeedbackTarget = { key:string; updatedAt:number; task?:ProactiveTask; attemptId?:string; assistantEntryId?:string; refs:ProactiveSourceRef[]; decision?:unknown }
  const recent:FeedbackTarget[]=[]
  for (const attempt of delivered.attempts) {
    if (attempt.status!=="committed" || !attempt.assistantEntryId) continue
    const proof=await readActiveAttemptEvidence(owner.sessionId,attempt.attemptId,attempt.requestId)
    if (!proof || proof.assistantEntryId!==attempt.assistantEntryId) continue
    const taskRef=attempt.sourceRefs.find(ref=>ref.kind==="task")
    const task=taskRef?result.tasks.find(item=>item.id===taskRef.id&&item.version===taskRef.version):undefined
    const memoryRefs=attempt.sourceRefs.filter(ref=>ref.kind==="memory")
    if (!task&&!memoryRefs.length) continue
    recent.push({key:task?`task:${task.id}`:`attempt:${attempt.attemptId}`,updatedAt:attempt.updatedAt,
      ...(task?{task}:{}),attemptId:attempt.attemptId,assistantEntryId:attempt.assistantEntryId,
      refs:task?[...task.sourceRefs,...memoryRefs]:memoryRefs,decision:attempt.decision})
  }
  const explicitlyMentioned=result.tasks.filter(task=>userText.includes(task.id)||
    (typeof task.intent.text==="string"&&task.intent.text.length>=2&&userText.includes(task.intent.text)))
  const candidates:FeedbackTarget[]=[...explicitlyMentioned.map(task=>({key:`task:${task.id}`,updatedAt:task.updatedAt,task,refs:task.sourceRefs})),
    ...recent.sort((left,right)=>right.updatedAt-left.updatedAt),
    ...result.tasks.map(task=>({key:`task:${task.id}`,updatedAt:task.updatedAt,task,refs:task.sourceRefs}))]
  const unique=new Map<string,FeedbackTarget>()
  for (const target of candidates) if (!unique.has(target.key)) unique.set(target.key,target)
  const selected=[...unique.values()].slice(0,RECENT_TARGET_LIMIT)
  const card=getActiveCard()
  const topic=card&&/聊聊|聊点|随便聊|没事聊|说点什么|讲个.*故事/.test(userText)
    ?contentPool(card,getBehaviorSnapshot(),owner,localDayKey(Date.now(),Intl.DateTimeFormat().resolvedOptions().timeZone)):null
  const recurrenceProposals=readRecurrenceProposals(entries,owner)
  if (!selected.length&&!topic&&!recurrenceProposals.length) return undefined
  trace(traceContext,"proactive_feedback",()=>({feedbackKind:"context",status:"prepared",count:selected.length,attemptId:recent[0]?.attemptId}))
  return {text:JSON.stringify({targets:selected.map(target=>({attemptId:target.attemptId,assistantEntryId:target.assistantEntryId,
    ...(target.task?{taskId:target.task.id,version:target.task.version,intent:target.task.intent,nextCheckinAt:target.task.nextCheckinAt,
      recurrence:target.task.recurrence,state:target.task.state,eventAt:target.task.eventAt,dueAt:target.task.dueAt}:{}),
    memoryTargets:target.refs.filter(ref=>ref.kind==="memory").map(ref=>({id:ref.id,version:ref.version})),decision:target.decision})),
    recurrenceProposals,topic:topic?.context,
    instruction:"只按当前用户指示与精确版本治理；延后提醒不改变事情时间，改期须改权威锚。多个目标有歧义先澄清。周期提议本身不授权，仅本轮明确同意并引用proposalId后可建约定。来源正文只以MemoryProvider投影为准。"}),
    taskRefs:selected.flatMap(target=>target.task?[{taskId:target.task.id,expectedVersion:target.task.version,
      ...(target.refs.find(ref=>ref.kind==="memory")?{memoryItemId:target.refs.find(ref=>ref.kind==="memory")!.id}:{})}]:[]),
    memoryRefs:[...new Map(selected.flatMap(target=>target.refs.filter(ref=>ref.kind==="memory")).map(ref=>[ref.id,ref])).values()],recurrenceProposals}
}

export async function setEnabled(enabled:boolean,owner:ProactiveOwner):Promise<void> {
  cancelCurrent("control_changed")
  const state=await ipc.query({owner,limit:1})
  const control=await ipc.control({operationId:crypto.randomUUID(),baseRevision:state.revision,owner,patch:{enabled}})
  applyEnabled(enabled)
  await publishProactiveControl(control)
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
