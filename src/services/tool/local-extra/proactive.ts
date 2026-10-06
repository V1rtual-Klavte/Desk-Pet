import { defineTool } from "../policy"
import { register } from "../registry"
import { TOOL_POLICY_VERSION } from "../types"
import type { ToolContext } from "../types"
import { getActiveCard } from "@/services/personality"
import { collectMemorySources } from "@/services/agent/memory"
import { query, change, cancelCurrent, createRuntimeTraceContext, proactiveEvent } from "@/services/proactive"
import type { ProactiveOwner, ProactiveSourceRef, ProactiveRecurrence, RecurrenceProposal } from "@/services/proactive"
import { localDayKey, localToInstant, nextSpeakingTime } from "@/services/proactive/time"
import { formatError } from "@/services/error"
import { DAY_MS, QUERY_LIMIT } from "@/services/proactive/config"

function owner(ctx:ToolContext):ProactiveOwner {
  const card=getActiveCard()
  if(!ctx.sessionId||ctx.runGeneration===undefined||!card||!ctx.isCurrent?.())throw new Error("主动治理必须绑定当前会话和运行代际")
  return {sessionId:ctx.sessionId,cardId:card.id,cardHash:card.hash,runGeneration:ctx.runGeneration}
}
export function validateRecurrence(value:unknown,evidence:string):ProactiveRecurrence|null {
  if(value===undefined||value===null)return null
  if(!/每天|每日|每周|每星期|每月|每年|每天都|每日都|定期|周期/.test(evidence))throw new Error("周期约定需要用户明确同意；提议本身不能成为周期任务")
  return validateRecurrenceShape(value)
}
function validateRecurrenceShape(value:unknown):ProactiveRecurrence {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("周期协议无效")
  const row=value as Record<string,unknown>
  if(!["daily","weekly","monthly","yearly"].includes(String(row.frequency))||typeof row.localTime!=="string"||typeof row.timezone!=="string")throw new Error("周期必须有频率、当地时间和时区")
  localToInstant(localDayKey(Date.now(),row.timezone),row.localTime,row.timezone)
  if(row.frequency==="weekly"&&(!Array.isArray(row.weekdays)||!row.weekdays.length||row.weekdays.some(day=>!Number.isInteger(day)||Number(day)<0||Number(day)>6)))throw new Error("每周周期必须指定合法星期")
  if(["monthly","yearly"].includes(String(row.frequency))&&(!Number.isInteger(row.dayOfMonth)||Number(row.dayOfMonth)<1||Number(row.dayOfMonth)>31))throw new Error("周期日无效")
  if(row.frequency==="yearly"&&(!Number.isInteger(row.month)||Number(row.month)<1||Number(row.month)>12))throw new Error("周期月无效")
  if(Object.keys(row).some(key=>!["frequency","localTime","timezone","weekdays","dayOfMonth","month"].includes(key)))throw new Error("未知周期字段")
  return row as unknown as ProactiveRecurrence
}
function isShortAcceptance(evidence:string):boolean {
  return /^(?:好|好的|可以|行|没问题|同意|照这个|按这个)(?:\s*[，,、]\s*(?:就这样|按这个|按刚才的|照这个))?[。！!\s]*$/.test(evidence.trim())
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`
  if(value&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)??"undefined"
}
export function acceptRecurrenceProposal(proposals:readonly RecurrenceProposal[],proposalId:string|undefined,owner:ProactiveOwner,
  intent:string,recurrence:unknown,nextCheckinAt:number,validUntil:number|null,evidence:string,now=Date.now()):ProactiveRecurrence {
  const proposal=proposals.find(row=>row.proposalId===proposalId)
  // 提议在提出它的回合之后才被用户接受，runGeneration 每轮递增，不作为提议身份；
  // 归属仍按会话/Card/hash 精确核对，内容仍逐字段比对。
  const sameOwner=proposal?.owner.sessionId===owner.sessionId&&proposal.owner.cardId===owner.cardId&&proposal.owner.cardHash===owner.cardHash
  if(!proposal||!proposal.assistantEntryId||!sameOwner||!isShortAcceptance(evidence))throw new Error("本轮没有匹配且仍有效的明确周期提议")
  if(proposal.intent!==intent.trim()||canonical(proposal.recurrence)!==canonical(recurrence)||proposal.nextCheckinAt!==nextCheckinAt||proposal.validUntil!==validUntil)
    throw new Error("接受内容与当前有效提议不一致")
  if(proposal.nextCheckinAt<now||(proposal.validUntil!==null&&proposal.validUntil<=now))throw new Error("周期提议已过期")
  return validateRecurrenceShape(proposal.recurrence)
}
export function resolveRescheduledValidUntil(task:{recurrence:ProactiveRecurrence|null;validUntil:number|null},nextCheckinAt:number,requested?:number,action:"snooze"|"reschedule"="reschedule"):number|null {
  const validUntil=requested??(action==="snooze"||task.recurrence?task.validUntil:nextCheckinAt+2*DAY_MS)
  if(validUntil!==null&&(!Number.isFinite(validUntil)||validUntil<=nextCheckinAt))throw new Error("有效窗口无效；周期约定不能被延后截短")
  return validUntil
}

const queryTool=defineTool({id:"local-proactive-query",name:"proactive_query",description:"只读查询当前可见的约定、事项与提醒任务，返回精确id/version；多个目标相近时先澄清。",
  parameters:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:10}},required:[]},safetyLevel:"SAFE",source:"local",sourceId:"",actionCategory:"_default",
  policy:{version:TOOL_POLICY_VERSION,permission:{defaultDecision:"passthrough"},execution:{effect:"read",isolation:"shared_read",replay:"safe"},context:{resultProjection:"preserve",historyCompaction:"summarize"}}},async(params,ctx)=>{
  try {const result=await query({owner:owner(ctx),limit:Math.min(10,Math.max(1,Number(params.limit)||2))});return {success:true,content:JSON.stringify({revision:result.revision,tasks:result.tasks})}}
  catch(error){return {success:false,content:"",error:formatError(error)}}
})
const changeTool=defineTool({id:"local-proactive-change",name:"proactive_change",
  description:"根据本轮用户的明确指示创建、完成、取消、改期或延后约定，或暂停主动陪伴。歧义须先澄清；改期改变事项时间，延后只改变下次提问时间。周期必须用户明确同意。开关主动陪伴不在此工具（归设置页档位）。",
  parameters:{type:"object",properties:{action:{type:"string",enum:["propose","create","reschedule","snooze","complete","cancel","control"]},proposalId:{type:"string",description:"只用于接受本轮上下文中仍有效的明确提议"},taskId:{type:"string"},expectedVersion:{type:"integer"},memoryItemId:{type:"string",description:"将本轮明确要求延后的某条记忆事项绑定到任务时，必须使用上下文给出的精确记忆ID"},expectedMemoryVersion:{type:"integer",description:"与memoryItemId配对，必须匹配冻结上下文版本"},
    intent:{type:"string",maxLength:1000},nextCheckinAt:{type:"number",description:"UTC毫秒，用户只说日期时使用合法发话窗口，不伪造用户指定钟点"},validUntil:{type:"number"},
    eventAt:{type:"object",description:"{precision:day,localDate:YYYY-MM-DD,timezone:IANA} 或 {precision:minute,instant:UTC毫秒,timezone:IANA}"},dueAt:{type:"object"},
    recurrence:{type:"object",description:"frequency daily/weekly/monthly/yearly +localTime HH:mm+timezone；weekly带weekdays(0周日)，monthly/yearly带dayOfMonth/yearly带month"},
    muteUntil:{type:"number",description:"暂停到UTC毫秒；不能用模型理由替用户关掉主动；开关主动陪伴已归设置页档位，不在此工具"}},required:["action"]},
  safetyLevel:"NORMAL",source:"local",sourceId:"",actionCategory:"_default",
  policy:{version:TOOL_POLICY_VERSION,permission:{defaultDecision:"passthrough"},execution:{effect:"local_mutation",isolation:"exclusive_effect",replay:"never"},context:{resultProjection:"preserve",historyCompaction:"summarize"}}},async(params,ctx)=>{
  try {
    const frozen=owner(ctx)
    if(!ctx.trustedUserEventId)throw new Error("缺少本轮已提交可信用户事件")
    const sources=(await collectMemorySources(frozen.sessionId)).filter(source=>source.eventId===ctx.trustedUserEventId)
    if(sources.length!==1)throw new Error("本轮可信来源缺失或不唯一")
    const user=sources[0]!
    const ref:ProactiveSourceRef={kind:"user_entry",id:user.sourceId,version:1,revision:user.seq,scope:"session",scopeId:frozen.sessionId,
      fingerprint:`${user.sessionId}:${user.entryId}:${user.contentHash}`,validUntil:null}
    const state=await query({owner:frozen,limit:QUERY_LIMIT}),action=String(params.action)
    const now=Date.now(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone
    const patch:Record<string,unknown>={}
    let sourceRefs:ProactiveSourceRef[]=[ref]
    const turnContext=ctx.proactiveTurnContext
    if(action==="propose") {
      if(typeof params.intent!=="string"||!params.intent.trim())throw new Error("周期提议意图不能为空")
      const recurrence=validateRecurrenceShape(params.recurrence)
      const next=params.nextCheckinAt
      if(typeof next!=="number"||!Number.isFinite(next)||next<now)throw new Error("周期提议需要合法未来时间")
      const until=typeof params.validUntil==="number"?params.validUntil:null
      if(until!==null&&(!Number.isFinite(until)||until<=next))throw new Error("周期提议有效期必须晚于下次提醒")
      if(!ctx.toolCallId)throw new Error("周期提议缺少稳定调用身份")
      if(!ctx.isCurrent?.()||ctx.signal?.aborted)throw new Error("运行已失效")
      proactiveEvent(createRuntimeTraceContext(frozen.sessionId),"proactive_task",()=>({operation:"propose",status:"proposed",taskIds:[],reason:"awaiting_user_consent"}))
      return {success:true,content:JSON.stringify({proposal:{proposalId:ctx.toolCallId,intent:params.intent.trim(),recurrence,nextCheckinAt:next,validUntil:until,owner:frozen}})}
    }
    if(action==="create") {
      if(typeof params.intent!=="string"||!params.intent.trim())throw new Error("约定意图不能为空")
      if(typeof params.nextCheckinAt!=="number"||!Number.isFinite(params.nextCheckinAt)||params.nextCheckinAt<now)throw new Error("约定需要合法未来时间，有歧义请先问用户")
      let recurrence:ProactiveRecurrence|null=null
      if(params.recurrence!==undefined&&params.recurrence!==null) {
        try { recurrence=validateRecurrence(params.recurrence,user.evidence??"") }
        catch(error) {
          recurrence=acceptRecurrenceProposal(turnContext?.recurrenceProposals??[],typeof params.proposalId==="string"?params.proposalId:undefined,
            frozen,params.intent,params.recurrence,params.nextCheckinAt,typeof params.validUntil==="number"?params.validUntil:null,user.evidence??"",now)
        }
      }
      const next=params.nextCheckinAt,until=typeof params.validUntil==="number"?params.validUntil:recurrence?null:next+2*DAY_MS
      if(until!==null&&(!Number.isFinite(until)||until<=next))throw new Error("有效窗口必须晚于下次检查时间")
      if(params.memoryItemId!==undefined||params.expectedMemoryVersion!==undefined) {
        if(typeof params.memoryItemId!=="string"||!params.memoryItemId||typeof params.expectedMemoryVersion!=="number")throw new Error("记忆关联必须同时提供精确ID和版本")
        const memoryRef=(turnContext?.memoryRefs??[]).find(source=>source.kind==="memory"&&source.id===params.memoryItemId&&source.version===params.expectedMemoryVersion)
        if(!memoryRef||(memoryRef.validUntil!==null&&memoryRef.validUntil<=now))throw new Error("该记忆不在本轮冻结的有效目标中")
        sourceRefs=[ref,memoryRef]
      }
      Object.assign(patch,{id:crypto.randomUUID(),scope:"session",scopeId:frozen.sessionId,sourceRefs,intent:{text:params.intent},nextCheckinAt:next,
        validUntil:until,timezone,recurrence,eventAt:params.eventAt??null,dueAt:params.dueAt??null})
    } else if(action==="snooze"||action==="reschedule") {
      if(typeof params.nextCheckinAt!=="number"||!Number.isFinite(params.nextCheckinAt)||params.nextCheckinAt<now)throw new Error("需要合法未来时间")
      patch.nextCheckinAt=params.nextCheckinAt
      const task=state.tasks.find(task=>task.id===params.taskId&&task.version===params.expectedVersion)
      if(!task)throw new Error("目标缺失或版本已变化，请重新查询；不能猜选事项")
      if(action==="snooze"&&params.validUntil!==undefined)throw new Error("延后只改变下次提醒时间，不改约定有效期")
      const validUntil=resolveRescheduledValidUntil(task,params.nextCheckinAt,typeof params.validUntil==="number"?params.validUntil:undefined,action)
      if(action==="reschedule")patch.validUntil=validUntil
      if(action==="reschedule"&&task.sourceRefs.some(source=>source.kind==="memory")&&params.eventAt===undefined&&params.dueAt===undefined)
        throw new Error("关联记忆事项改期必须更新事项时间锚；只改下次提醒请使用延后")
      if(action==="reschedule"){if(params.eventAt!==undefined)patch.eventAt=params.eventAt;if(params.dueAt!==undefined)patch.dueAt=params.dueAt}
    }
    if(action!=="create"&&action!=="control") {
      const task=state.tasks.find(task=>task.id===params.taskId)
      if(!task||task.version!==params.expectedVersion)throw new Error("目标缺失或版本已变化，请重新查询；不能猜选事项")
    }
    if(!ctx.isCurrent?.()||ctx.signal?.aborted)throw new Error("运行已失效")
    cancelCurrent("task_governance_changed")
    const result=await change({operationId:ctx.operationId??ctx.toolCallId??crypto.randomUUID(),baseRevision:state.revision,
      action:action as "create"|"reschedule"|"snooze"|"complete"|"cancel"|"control",owner:frozen,taskId:typeof params.taskId==="string"?params.taskId:undefined,
      expectedVersion:typeof params.expectedVersion==="number"?params.expectedVersion:undefined,trustedUserEventId:ctx.trustedUserEventId,sourceRefs,taskPatch:patch,
      controlPatch:action==="control"?{...(typeof params.muteUntil==="number"?{muteUntil:params.muteUntil}:{})}:undefined})
    proactiveEvent(createRuntimeTraceContext(frozen.sessionId),"proactive_task",()=>({operation:action,status:"committed",taskIds:result.task?.id?[result.task.id]:[],reason:"user_governance"}))
    return {success:true,content:JSON.stringify({revision:result.revision,task:result.task})}
  }catch(error){
    if(ctx.sessionId)proactiveEvent(createRuntimeTraceContext(ctx.sessionId),"proactive_task",()=>({operation:"governance",status:"failed",taskIds:[],reason:"validation_or_transaction_failed"}))
    return {success:false,content:"",error:formatError(error)}
  }
})
export function registerProactiveTools():void {register(queryTool);register(changeTool)}
