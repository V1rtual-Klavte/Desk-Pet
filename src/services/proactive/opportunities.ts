import type { Opportunity, ProactiveOwner, ProactiveSourceRef, ProactiveTask, ProactiveMemoryTarget } from "./types"
import { DAY_MS, FINISH_WORK_DELAY_MS } from "./config"
import { PROACTIVE_LIMITS } from "./protocol"
import { checkinWindows, localDayKey, localDayWindow, localToInstant, zonedParts, weekKey, calendarAnniversary, shiftLocalDate, isNightlyWindow, isQuietTime } from "./time"
import { getCalendarEvents } from "./content/calendar"
import type { BehaviorSnapshot } from "@/services/behavior"
import { IDLE_ACTIVE_LIMIT_MS } from "@/services/window/types"

export type MemoryTarget = ProactiveMemoryTarget
export interface FinishedWorkTracker { workEndedAt:number; restingSince:number; lastRestObservationAt:number; wasWorking:boolean }
export function isLeisureOrIdle(category:string|null,idleForMs:number|null):boolean {
  return (idleForMs!==null&&idleForMs>=IDLE_ACTIVE_LIMIT_MS)||category==="media"
}
/**
 * 事件驱动采样下两次观察的间隔不再代表观察中断，收工追踪仅按明确的
 * 工作/闲暇状态转移重置；锁屏、挂起等中断由调用方在非 observed 分支清零。
 */
export function advanceFinishedWorkTracker(state:FinishedWorkTracker,input:{now:number;working:boolean;leisureOrIdle:boolean}):FinishedWorkTracker {
  if(input.working)return {workEndedAt:0,restingSince:0,lastRestObservationAt:0,wasWorking:true}
  const workEndedAt=state.wasWorking?input.now:state.workEndedAt
  if(!input.leisureOrIdle)return {workEndedAt,restingSince:0,lastRestObservationAt:0,wasWorking:false}
  const reset=!state.restingSince||!state.lastRestObservationAt
  return {workEndedAt,restingSince:reset?input.now:state.restingSince,lastRestObservationAt:input.now,wasWorking:false}
}
export function qualifiesFinishedWork(input:{workEndedAt:number;restingSince:number;now:number;wasWorking:boolean;reliable:boolean}):boolean {
  return input.workEndedAt>0&&input.restingSince>0&&!input.wasWorking&&input.reliable
    &&input.now-input.restingSince>=FINISH_WORK_DELAY_MS&&input.now-input.workEndedAt<=DAY_MS
}
export interface RuleInput {
  owner:ProactiveOwner; now:number; timezone:string; tasks:ProactiveTask[]; memoryTargets:MemoryTarget[]
  memoryEnabled:boolean; behavior:BehaviorSnapshot; topic: {key:string;context:string;source:ProactiveSourceRef;targets:Array<{id:string;version:number}>} | null
}
export function source(kind:ProactiveSourceRef["kind"],id:string,revision:number,fingerprint:string,owner:ProactiveOwner):ProactiveSourceRef {
  return {kind,id,version:revision,revision,scope:"card",scopeId:owner.cardId,fingerprint,validUntil:null}
}

export function usesRandomFallbackInterval(ruleId:string):boolean {
  return ruleId==="topic_share"||ruleId==="curiosity"
}
export function opportunity(owner:ProactiveOwner,ruleId:string,slot:string,refs:ProactiveSourceRef[],from:number,until:number,
  priority:number,context:string,explicit=false,targets:Opportunity["targets"]=[]):Opportunity {
  const fingerprint=`${owner.cardId}:${owner.sessionId}:${ruleId}:${slot}`
  return {id:fingerprint,ruleId,sourceRefs:refs,owner,intentKey:slot,validFrom:from,validUntil:until,priority,fingerprint,context,explicit,targets}
}

/** Calendar cycles are resolved from local dates, never a fixed 24h recurrence. */
export function recurrenceSlot(task:ProactiveTask,now:number):{id:string;from:number;until:number}|null {
  if(typeof task.nextCheckinAt==="number" && now<task.nextCheckinAt)return null
  const recurrence=task.recurrence
  if(!recurrence || typeof recurrence!=="object") {
    const from=task.nextCheckinAt
    if(typeof from!=="number") return null
    return {id:`${task.id}:v${task.version}:once`,from,until:typeof task.validUntil==="number"?task.validUntil:from+2*DAY_MS}
  }
  const day=localDayKey(now,recurrence.timezone),p=zonedParts(now,recurrence.timezone)
  const weekday=new Date(`${day}T00:00:00Z`).getUTCDay()
  if(recurrence.frequency==="weekly" && !recurrence.weekdays?.includes(weekday)) return null
  if(recurrence.frequency==="monthly" && day!==calendarAnniversary(p.year,p.month,recurrence.dayOfMonth??1)) return null
  if(recurrence.frequency==="yearly" && day!==calendarAnniversary(p.year,recurrence.month??1,recurrence.dayOfMonth??1)) return null
  const from=localToInstant(day,recurrence.localTime,recurrence.timezone)
  const until=localDayWindow(day,recurrence.timezone).until
  return {id:`${task.id}:v${task.version}:${day}:${recurrence.localTime}`,from,until:Math.min(until,typeof task.validUntil==="number"?task.validUntil:until)}
}

// ── 机会优先级（数值越大越优先；同批机会的取舍规则由 scanner 消费）──
const PRIORITY = {
  scheduledTask: 100,
  checkinBefore: 90,
  checkinAfter: 85,
  anniversary: 75,
  calendar: 75,
  retrospective: 65,
  openEndFollowup: 45,
  rhythm: 35,
  topicShare: 30,
  curiosity: 25,
  goodnight: 20,
} as const

// ── 发话时段（本地时刻）：开/收与全局静默窗衔接，中段为日间分界 ──
const SHARE_START_HOUR = PROACTIVE_LIMITS.quietEndHour      // 09
const SHARE_END_HOUR = PROACTIVE_LIMITS.quietStartHour - 1  // 22
const MIDDAY_HOUR = 12
const EVENING_HOUR = 18
const clock = (hour: number): string => `${String(hour).padStart(2, "0")}:00`

export function collectOpportunities(input:RuleInput):Opportunity[] {
  const {owner,now,timezone}=input, day=localDayKey(now,timezone), p=zonedParts(now,timezone)
  if (isQuietTime(now, timezone)) return []
  const out:Opportunity[]=[]
  for(const task of input.tasks) {
    if(task.state!=="active" || (!input.memoryEnabled && task.sourceRefs.some(ref=>ref.kind==="memory")))continue
    const slot=recurrenceSlot(task,now)
    if(!slot || now<slot.from || now>=slot.until)continue
    const targets=task.sourceRefs.filter(ref=>ref.kind==="memory").map(ref=>({id:ref.id,version:ref.version}))
    const taskRef:ProactiveSourceRef={kind:"task",id:task.id,version:task.version,revision:task.version,scope:task.scope,scopeId:task.scopeId,fingerprint:`${task.id}:${task.version}`,validUntil:null}
    out.push({...opportunity(owner,"scheduled_task",slot.id,[taskRef,...task.sourceRefs],slot.from,slot.until,PRIORITY.scheduledTask,
      JSON.stringify({taskId:task.id,intent:task.intent,recurrence:task.recurrence}),task.sourceRefs.some(ref=>ref.kind==="user_entry"),targets),task,expectsReply:true,selfSufficient:true})
  }
  if(input.memoryEnabled) for(const target of input.memoryTargets) {
    if(!target.sourceIds?.length)continue
    const ref:ProactiveSourceRef={kind:"memory",id:target.id,version:target.version,revision:target.version,
      scope:target.scope,scopeId:target.scopeId,fingerprint:`${target.id}:${target.version}`,validUntil:null}
    if(target.kind!=="working" && target.eventAt && target.aliases?.some((alias: string)=>["生日","birthday","纪念日","anniversary"].includes(alias.toLowerCase()))) {
      const anchor=target.eventAt,p=anchor.precision==="day"?{month:Number(anchor.localDate.slice(5,7)),day:Number(anchor.localDate.slice(8,10))}:zonedParts(anchor.instant,anchor.timezone)
      const local=localDayKey(now,anchor.timezone),year=zonedParts(now,anchor.timezone).year
      if(local===calendarAnniversary(year,p.month,p.day))out.push({...opportunity(owner,"anniversary",`${target.id}:v${target.version}:${year}`,[ref],
        localToInstant(local,clock(SHARE_START_HOUR),anchor.timezone),localToInstant(local,clock(SHARE_END_HOUR),anchor.timezone),PRIORITY.anniversary,"用户明确日期的生日或纪念日，只根据来源表达，不捏造年龄、庆祝安排或共同经历。",true,[{id:target.id,version:target.version}]),expectsReply:false,selfSufficient:true})
    }
    if(target.kind!=="working" || target.workingState!=="open")continue
    if(!target.eventAt&&!target.dueAt&&now<target.updatedAt+7*DAY_MS)out.push(opportunity(owner,"open_end_followup",`${target.id}:v${target.version}:untimed`,[ref],target.updatedAt,target.updatedAt+7*DAY_MS,PRIORITY.openEndFollowup,
      "这是用户来源的无日期未完事项；有持续价值才安排未来1到7天一次跟进，否则decline。未回应后不再次排期。",false,[{id:target.id,version:target.version}]))
    for(const [key,anchor] of [["eventAt",target.eventAt],["dueAt",target.dueAt]] as const) {
      if(!anchor || typeof anchor!=="object")continue
      for(const window of checkinWindows(anchor)) if(now>=window.from && now<window.until)out.push(opportunity(owner,"memory_checkin",
        `${target.id}:v${target.version}:${key}:${window.anchorKey}:${window.phase}`,[ref],window.from,window.until,window.phase==="before"?PRIORITY.checkinBefore:PRIORITY.checkinAfter,
        JSON.stringify({targetId:target.id,anchor:key,phase:window.phase,time:anchor}),true,[{id:target.id,version:target.version}]))
    }
  }
  const open=localToInstant(day,clock(SHARE_START_HOUR),timezone),close=localToInstant(day,clock(SHARE_END_HOUR),timezone)
  if (isNightlyWindow(now,timezone)) {
    out.push({...opportunity(owner,"late_goodnight",`${day}:goodnight`,[source("calendar",`goodnight:${day}`,1,day,owner)],
      localToInstant(day,clock(SHARE_END_HOUR),timezone),localToInstant(shiftLocalDate(day,1),clock(0),timezone),PRIORITY.goodnight,
      "一条简短、温柔的晚安分享，不询问、不追问，也不要求回应。"),expectsReply:false,selfSufficient:true})
    return out
  }
  const events=getCalendarEvents(day)
  if(events.status==="covered")for(const event of events.events) {
    const ref=source("calendar",event.key,1,event.sourceHash,owner)
    out.push({...opportunity(owner,"calendar",`${event.key}:${day}`,[ref],open,close,PRIORITY.calendar,`本地历表明确：${event.name}；只分享该日期的节令，不推断用户在放假或已庆祝。`),expectsReply:false,selfSufficient:true})
  }
  const clockRef=source("calendar",`rhythm:${day}`,1,day,owner)
  const weekday=new Date(`${day}T00:00:00Z`).getUTCDay()
  const observedHours=weekday===0||weekday===6?input.behavior.rhythm.weekends:input.behavior.rhythm.weekdays
  const rhythmEligible=input.behavior.quality.status!=="reliable"||observedHours[p.hour]!>0
  if(rhythmEligible && p.hour>=SHARE_START_HOUR && p.hour<MIDDAY_HOUR)out.push({...opportunity(owner,"rhythm",`${day}:morning`,[clockRef],open,localToInstant(day,clock(MIDDAY_HOUR),timezone),PRIORITY.rhythm,"晨间问候，可邀请聊今天的安排；不知道的安排不能编造。"),expectsReply:true})
  if(rhythmEligible && p.hour>=EVENING_HOUR && p.hour<SHARE_END_HOUR)out.push({...opportunity(owner,"rhythm",`${day}:evening`,[clockRef],localToInstant(day,clock(EVENING_HOUR),timezone),close,PRIORITY.rhythm,"晚间问候，可邀请讲讲今天；不假定工作成果。"),expectsReply:true})
  if(input.behavior.quality.status==="reliable") {
    const b=input.behavior
    const ref=source("behavior",`behavior:${day}`,b.revision,`${b.revision}:${day}`,owner)
    const weekday=new Date(`${day}T00:00:00Z`).getUTCDay()
    if(weekday===0 && p.hour>=EVENING_HOUR && p.hour<SHARE_END_HOUR) out.push({...opportunity(owner,"retrospective",weekKey(now,timezone),[ref],localToInstant(day,clock(EVENING_HOUR),timezone),close,PRIORITY.retrospective,
      JSON.stringify({quality:b.quality,days7:b.weekly.days,observedActivity:b.weekly.activity,focus:b.weekly.focus,instruction:"仅描述合格观测，不声称现实成就；过去7天一份回顾。"})),expectsReply:true})
  }
  if(input.topic) {
    const topic=input.topic
    out.push({...opportunity(owner,"topic_share",`${day}:${topic.key}`,[topic.source],open,close,PRIORITY.topicShare,topic.context,false,topic.targets),topicKey:topic.key,expectsReply:false,selfSufficient:true})
    out.push({...opportunity(owner,"curiosity",weekKey(now,timezone),[topic.source],open,localToInstant(shiftLocalDate(weekKey(now,timezone),7),clock(0),timezone),PRIORITY.curiosity,
      `${topic.context}\n就这个有依据的话题问一个小问题；可提议习惯，但没有新用户同意不得建立周期任务。`,false,topic.targets),expectsReply:true})
  }
  // Do not cap here: scanner still has to remove already-evaluated occurrences and apply
  // interruption/priority rules. A large prefix of stale tasks must never hide later valid work.
  const unique = new Map<string,Opportunity>()
  for (const item of out) {
    if (now < item.validFrom || now >= item.validUntil) continue
    const previous = unique.get(item.fingerprint)
    if (!previous || item.priority > previous.priority) unique.set(item.fingerprint,item)
  }
  return [...unique.values()].sort((a,b)=>b.priority-a.priority||a.validUntil-b.validUntil||a.id.localeCompare(b.id))
}

/** Merge overlapping anchors/duplicate rules for the same target without consuming two deliveries. */
export function selectOpportunities(items:Opportunity[],evaluated:ReadonlySet<string>,now:number,working:boolean):Opportunity[] {
  const deduped=new Map<string,Opportunity>()
  for(const item of items) {
    if(now<item.validFrom||now>=item.validUntil||evaluated.has(item.fingerprint)
      ||(working&&!item.explicit&&!item.selfSufficient))continue
    const prior=deduped.get(item.fingerprint)
    if(!prior||item.priority>prior.priority)deduped.set(item.fingerprint,item)
  }
  const sorted=[...deduped.values()]
    .sort((a,b)=>b.priority-a.priority||a.validUntil-b.validUntil||a.id.localeCompare(b.id))
  if(!sorted.length)return []
  const first=sorted[0]!
  return [first,...sorted.slice(1).filter(item=>(item.targets.some(t=>first.targets.some(f=>t.id===f.id))&&new Set([...first.targets,...item.targets].map(target=>target.id)).size<=2) || (item.ruleId==="calendar"&&first.ruleId==="calendar"))]
    .slice(0,2)
}
