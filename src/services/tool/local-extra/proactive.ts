import { defineTool } from "../policy"
import { register } from "../registry"
import { TOOL_POLICY_VERSION } from "../types"
import type { ToolContext } from "../types"
import { getActiveCard } from "@/services/personality"
import { collectMemorySources } from "@/services/agent/memory"
import { query, change, cancelCurrent } from "@/services/proactive"
import type { ProactiveOwner, ProactiveSourceRef, ProactiveRecurrence } from "@/services/proactive"
import { localDayKey, localToInstant, nextSpeakingTime } from "@/services/proactive/time"
import { formatError } from "@/services/error"
import { DAY_MS } from "@/services/proactive/config"

function owner(ctx:ToolContext):ProactiveOwner {
  const card=getActiveCard()
  if(!ctx.sessionId||ctx.runGeneration===undefined||!card||!ctx.isCurrent?.())throw new Error("主动治理必须绑定当前会话和运行代际")
  return {sessionId:ctx.sessionId,cardId:card.id,cardHash:card.hash,runGeneration:ctx.runGeneration}
}
export function validateRecurrence(value:unknown,evidence:string):ProactiveRecurrence|null {
  if(value===undefined||value===null)return null
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("周期协议无效")
  if(!/每天|每日|每周|每星期|每月|每年|每天都|每日都|定期|周期/.test(evidence))throw new Error("周期约定需要用户明确同意；提议本身不能成为周期任务")
  const row=value as Record<string,unknown>
  if(!["daily","weekly","monthly","yearly"].includes(String(row.frequency))||typeof row.localTime!=="string"||typeof row.timezone!=="string")throw new Error("周期必须有频率、当地时间和时区")
  localToInstant(localDayKey(Date.now(),row.timezone),row.localTime,row.timezone)
  if(row.frequency==="weekly"&&(!Array.isArray(row.weekdays)||!row.weekdays.length||row.weekdays.some(day=>!Number.isInteger(day)||Number(day)<0||Number(day)>6)))throw new Error("每周周期必须指定合法星期")
  if(["monthly","yearly"].includes(String(row.frequency))&&(!Number.isInteger(row.dayOfMonth)||Number(row.dayOfMonth)<1||Number(row.dayOfMonth)>31))throw new Error("周期日无效")
  if(row.frequency==="yearly"&&(!Number.isInteger(row.month)||Number(row.month)<1||Number(row.month)>12))throw new Error("周期月无效")
  if(Object.keys(row).some(key=>!["frequency","localTime","timezone","weekdays","dayOfMonth","month"].includes(key)))throw new Error("未知周期字段")
  return row as unknown as ProactiveRecurrence
}

const queryTool=defineTool({id:"local-proactive-query",name:"proactive_query",description:"只读查询当前可见的约定、事项与提醒任务，返回精确id/version；多个目标相近时先澄清。",
  parameters:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:10}},required:[]},safetyLevel:"SAFE",source:"local",sourceId:"",actionCategory:"_default",
  policy:{version:TOOL_POLICY_VERSION,permission:{defaultDecision:"passthrough"},execution:{effect:"read",isolation:"shared_read",replay:"safe"},context:{resultProjection:"preserve",historyCompaction:"summarize"}}},async(params,ctx)=>{
  try {const result=await query({owner:owner(ctx),limit:Math.min(10,Math.max(1,Number(params.limit)||2))});return {success:true,content:JSON.stringify({revision:result.revision,tasks:result.tasks})}}
  catch(error){return {success:false,content:"",error:formatError(error)}}
})
const changeTool=defineTool({id:"local-proactive-change",name:"proactive_change",
  description:"根据本轮用户的明确指示创建、完成、取消、改期或延后约定，或开关/暂停主动陪伴。歧义须先澄清；改期改变事项时间，延后只改变下次提问时间。周期必须用户明确同意。",
  parameters:{type:"object",properties:{action:{type:"string",enum:["create","reschedule","snooze","complete","cancel","control"]},taskId:{type:"string"},expectedVersion:{type:"integer"},
    intent:{type:"string",maxLength:1000},nextCheckinAt:{type:"number",description:"UTC毫秒，用户只说日期时使用合法发话窗口，不伪造用户指定钟点"},validUntil:{type:"number"},
    eventAt:{type:"object",description:"{precision:day,localDate:YYYY-MM-DD,timezone:IANA} 或 {precision:minute,instant:UTC毫秒,timezone:IANA}"},dueAt:{type:"object"},
    recurrence:{type:"object",description:"frequency daily/weekly/monthly/yearly +localTime HH:mm+timezone；weekly带weekdays(0周日)，monthly/yearly带dayOfMonth/yearly带month"},
    enabled:{type:"boolean"},muteUntil:{type:"number",description:"暂停到UTC毫秒；不能用模型理由替用户关掉主动"}},required:["action"]},
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
    const state=await query({owner:frozen,limit:100}),action=String(params.action)
    const now=Date.now(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone
    const patch:Record<string,unknown>={}
    if(action==="create") {
      if(typeof params.intent!=="string"||!params.intent.trim())throw new Error("约定意图不能为空")
      if(typeof params.nextCheckinAt!=="number"||!Number.isFinite(params.nextCheckinAt)||params.nextCheckinAt<now)throw new Error("约定需要合法未来时间，有歧义请先问用户")
      const recurrence=validateRecurrence(params.recurrence,user.evidence??"")
      const next=params.nextCheckinAt,until=typeof params.validUntil==="number"?params.validUntil:recurrence?null:next+2*DAY_MS
      if(until!==null&&(!Number.isFinite(until)||until<=next))throw new Error("有效窗口必须晚于下次检查时间")
      Object.assign(patch,{id:crypto.randomUUID(),scope:"session",scopeId:frozen.sessionId,sourceRefs:[ref],intent:{text:params.intent},nextCheckinAt:next,
        validUntil:until,timezone,recurrence,eventAt:params.eventAt??null,dueAt:params.dueAt??null})
    } else if(action==="snooze"||action==="reschedule") {
      if(typeof params.nextCheckinAt!=="number"||!Number.isFinite(params.nextCheckinAt)||params.nextCheckinAt<now)throw new Error("需要合法未来时间")
      patch.nextCheckinAt=params.nextCheckinAt
      patch.validUntil=typeof params.validUntil==="number"?params.validUntil:params.nextCheckinAt+2*DAY_MS
      if(!Number.isFinite(patch.validUntil as number)||(patch.validUntil as number)<=(patch.nextCheckinAt as number))throw new Error("有效窗口无效")
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
      expectedVersion:typeof params.expectedVersion==="number"?params.expectedVersion:undefined,trustedUserEventId:ctx.trustedUserEventId,sourceRefs:[ref],taskPatch:patch,
      controlPatch:action==="control"?{...(typeof params.enabled==="boolean"?{enabled:params.enabled}:{}),...(typeof params.muteUntil==="number"?{muteUntil:params.muteUntil}:{})}:undefined})
    return {success:true,content:JSON.stringify({revision:result.revision,task:result.task})}
  }catch(error){return {success:false,content:"",error:formatError(error)}}
})
export function registerProactiveTools():void {register(queryTool);register(changeTool)}
