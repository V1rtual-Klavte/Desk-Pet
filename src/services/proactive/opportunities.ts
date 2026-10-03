import type { Opportunity, ProactiveOwner, ProactiveSourceRef, ProactiveTask, ProactiveMemoryTarget } from "./types"
import { DAY_MS, FINISH_WORK_DELAY_MS } from "./config"
import { checkinWindows, localDayKey, localDayWindow, localToInstant, zonedParts, weekKey, calendarAnniversary, shiftLocalDate } from "./time"
import { getCalendarEvents } from "./content/calendar"
import type { BehaviorSnapshot } from "@/services/behavior"

export type MemoryTarget = ProactiveMemoryTarget
export interface FinishedWorkTracker { workEndedAt:number; restingSince:number; lastRestObservationAt:number; wasWorking:boolean }
export function isLeisureOrIdle(category:string|null,idleForMs:number|null):boolean {
  return (idleForMs!==null&&idleForMs>=5*60_000)||category==="media"
}
export function advanceFinishedWorkTracker(state:FinishedWorkTracker,input:{now:number;working:boolean;leisureOrIdle:boolean;maxGap:number}):FinishedWorkTracker {
  if(input.working)return {workEndedAt:0,restingSince:0,lastRestObservationAt:0,wasWorking:true}
  const workEndedAt=state.wasWorking?input.now:state.workEndedAt
  if(!input.leisureOrIdle)return {workEndedAt,restingSince:0,lastRestObservationAt:0,wasWorking:false}
  const reset=!state.restingSince||!state.lastRestObservationAt||input.now-state.lastRestObservationAt>input.maxGap
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

export function collectOpportunities(input:RuleInput):Opportunity[] {
  const {owner,now,timezone}=input, day=localDayKey(now,timezone), p=zonedParts(now,timezone)
  const out:Opportunity[]=[]
  for(const task of input.tasks) {
    if(task.state!=="active" || (!input.memoryEnabled && task.sourceRefs.some(ref=>ref.kind==="memory")))continue
    const slot=recurrenceSlot(task,now)
    if(!slot || now<slot.from || now>=slot.until)continue
    const targets=task.sourceRefs.filter(ref=>ref.kind==="memory").map(ref=>({id:ref.id,version:ref.version}))
    const taskRef:ProactiveSourceRef={kind:"task",id:task.id,version:task.version,revision:task.version,scope:task.scope,scopeId:task.scopeId,fingerprint:`${task.id}:${task.version}`,validUntil:null}
    out.push({...opportunity(owner,"scheduled_task",slot.id,[taskRef,...task.sourceRefs],slot.from,slot.until,100,
      JSON.stringify({taskId:task.id,intent:task.intent,recurrence:task.recurrence}),task.sourceRefs.some(ref=>ref.kind==="user_entry"),targets),task})
  }
  if(input.memoryEnabled) for(const target of input.memoryTargets) {
    if(!target.sourceIds?.length)continue
    const ref:ProactiveSourceRef={kind:"memory",id:target.id,version:target.version,revision:target.version,
      scope:target.scope,scopeId:target.scopeId,fingerprint:`${target.id}:${target.version}`,validUntil:null}
    if(target.kind!=="working" && target.eventAt && target.aliases?.some((alias: string)=>["生日","birthday","纪念日","anniversary"].includes(alias.toLowerCase()))) {
      const anchor=target.eventAt,p=anchor.precision==="day"?{month:Number(anchor.localDate.slice(5,7)),day:Number(anchor.localDate.slice(8,10))}:zonedParts(anchor.instant,anchor.timezone)
      const local=localDayKey(now,anchor.timezone),year=zonedParts(now,anchor.timezone).year
      if(local===calendarAnniversary(year,p.month,p.day))out.push(opportunity(owner,"anniversary",`${target.id}:v${target.version}:${year}`,[ref],
        localToInstant(local,"09:00",anchor.timezone),localToInstant(local,"22:00",anchor.timezone),75,"用户明确日期的生日或纪念日，只根据来源表达，不捏造年龄、庆祝安排或共同经历。",true,[{id:target.id,version:target.version}]))
    }
    if(target.kind!=="working" || target.workingState!=="open")continue
    if(!target.eventAt&&!target.dueAt&&now<target.updatedAt+7*DAY_MS)out.push(opportunity(owner,"open_end_followup",`${target.id}:v${target.version}:untimed`,[ref],target.updatedAt,target.updatedAt+7*DAY_MS,45,
      "这是用户来源的无日期未完事项；有持续价值才安排未来1到7天一次跟进，否则decline。未回应后不再次排期。",false,[{id:target.id,version:target.version}]))
    for(const [key,anchor] of [["eventAt",target.eventAt],["dueAt",target.dueAt]] as const) {
      if(!anchor || typeof anchor!=="object")continue
      for(const window of checkinWindows(anchor)) if(now>=window.from && now<window.until)out.push(opportunity(owner,"memory_checkin",
        `${target.id}:v${target.version}:${key}:${window.anchorKey}:${window.phase}`,[ref],window.from,window.until,window.phase==="before"?90:85,
        JSON.stringify({targetId:target.id,anchor:key,phase:window.phase,time:anchor}),true,[{id:target.id,version:target.version}]))
    }
  }
  const open=localToInstant(day,"09:00",timezone),close=localToInstant(day,"22:00",timezone)
  const events=getCalendarEvents(day)
  if(events.status==="covered")for(const event of events.events) {
    const ref=source("calendar",event.key,1,event.sourceHash,owner)
    out.push(opportunity(owner,"calendar",`${event.key}:${day}`,[ref],open,close,75,`本地历表明确：${event.name}；只分享该日期的节令，不推断用户在放假或已庆祝。`))
  }
  const clockRef=source("calendar",`rhythm:${day}`,1,day,owner)
  const weekday=new Date(`${day}T00:00:00Z`).getUTCDay()
  const observedHours=weekday===0||weekday===6?input.behavior.rhythm.weekends:input.behavior.rhythm.weekdays
  const rhythmEligible=input.behavior.quality.status!=="reliable"||observedHours[p.hour]!>0
  if(rhythmEligible && p.hour>=9 && p.hour<12)out.push(opportunity(owner,"rhythm",`${day}:morning`,[clockRef],open,localToInstant(day,"12:00",timezone),35,"晨间问候，可邀请聊今天的安排；不知道的安排不能编造。"))
  if(rhythmEligible && p.hour>=18 && p.hour<22)out.push(opportunity(owner,"rhythm",`${day}:evening`,[clockRef],localToInstant(day,"18:00",timezone),close,35,"晚间问候，可邀请讲讲今天；不假定工作成果。"))
  if(input.behavior.quality.status==="reliable") {
    const b=input.behavior
    const ref=source("behavior",`behavior:${day}`,b.revision,`${b.revision}:${day}`,owner)
    const weekday=new Date(`${day}T00:00:00Z`).getUTCDay()
    if(weekday===0 && p.hour>=18 && p.hour<22) out.push(opportunity(owner,"retrospective",weekKey(now,timezone),[ref],localToInstant(day,"18:00",timezone),close,65,
      JSON.stringify({quality:b.quality,days7:b.weekly.days,observedActivity:b.weekly.activity,focus:b.weekly.focus,instruction:"仅描述合格观测，不声称现实成就；过去7天一份回顾。"})))
  }
  if(input.topic) {
    const topic=input.topic
    out.push({...opportunity(owner,"topic_share",`${day}:${topic.key}`,[topic.source],open,close,30,topic.context,false,topic.targets),topicKey:topic.key})
    out.push(opportunity(owner,"curiosity",weekKey(now,timezone),[topic.source],open,localToInstant(shiftLocalDate(weekKey(now,timezone),7),"00:00",timezone),25,
      `${topic.context}\n就这个有依据的话题问一个小问题；可提议习惯，但没有新用户同意不得建立周期任务。`,false,topic.targets))
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
export function selectOpportunities(items:Opportunity[],evaluated:ReadonlySet<string>,now:number,unanswered:number,working:boolean):Opportunity[] {
  const deduped=new Map<string,Opportunity>()
  for(const item of items) {
    if(now<item.validFrom||now>=item.validUntil||evaluated.has(item.fingerprint)
      ||unanswered>=4||(unanswered>=2&&!item.explicit)||(working&&!item.explicit))continue
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
