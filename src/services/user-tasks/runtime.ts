import { watch } from "vue"
import { getHostBridge } from "@/services/host"
import { internalScheduler } from "@/services/scheduler"
import type { SchedulerRunRecord, SchedulerArtifact, SchedulerPeriodRecord } from "@/services/scheduler"
import { getActiveCard, getActivePersonalityId } from "@/services/personality"
import { activeSessionId } from "@/services/session"
import { SUB_AGENT_RUN_TIMEOUT_MS } from "@/services/agent"
import { runPiSubAgent } from "@/services/engine/harness"
import { listAll, releaseMcpOwner } from "@/services/tool"
import { createLogger } from "@/services/logger"
import { summarizeError } from "@/services/error"
import { getLatestWindowObservation, subscribeWindowObservations } from "@/services/window"
import { getBehaviorSnapshot } from "@/services/behavior"
import { loopConfig, silentAccessConfig } from "@/services/config"
import { offer, opportunity, tick, registerScheduledDeliveryHooks, query as queryReceipts, reconcileSession } from "@/services/proactive"
import type { Opportunity, ProactiveOwner, ProactiveTask } from "@/services/proactive"
import { activeSchedulePeriods, currentSchedulePeriod, nextScheduleBoundary, sampleSchedulePeriod } from "./calendar"
import { queryUserTasks, subscribeUserTaskChanges } from "./client"
import { parseUserTaskDefinition } from "./validation"
import { taskContentFingerprint } from "./proposals"
import { isTaskReadCapability, taskCapabilityScopeAllows } from "./capabilities"
import { workPrompt, validateWorkArtifact } from "./work"
import type { ObservedScheduleEvent, SchedulePeriod, UserTaskDefinition } from "./types"

const log=createLogger("UserTasks")
const TASK_CHECK_MS=60_000
const TASK_RUN_MS=SUB_AGENT_RUN_TIMEOUT_MS
const WORK_ENDED_REST_MS=10*60_000
let stopJob:(()=>void)|undefined, nextAt=0
const cleanups:Array<()=>void>=[]
const active=new Map<string,AbortController>()
const pendingExecutions=new Map<string,Promise<void>>()
let lastCategory:string|null=null,restSince=0,hadWorking=false,event:ObservedScheduleEvent|undefined
function wake():void {internalScheduler.wake("user_tasks")}
function resetWorkObservation():void {lastCategory=null;restSince=0;hadWorking=false;event=undefined}
/** Observation events describe state changes; unchanged leisure still matures on the scheduler clock. */
function refreshWorkEndedEvent(now:number):void {
  const observation=getLatestWindowObservation()
  if(silentAccessConfig.frequency==="off"||!observation||observation.observationState!=="observed"||observation.isPetForeground){resetWorkObservation();return}
  const snapshot=getBehaviorSnapshot(now)
  if(snapshot.quality.status!=="reliable"){resetWorkObservation();return}
  if(!["leisure","idle"].includes(snapshot.focus.currentCategory??"")){restSince=0;return}
  if(hadWorking&&restSince&&now-restSince>=WORK_ENDED_REST_MS){
    event={event:"work_ended",signal:"working_to_idle",occurredAt:restSince+WORK_ENDED_REST_MS}
    hadWorking=false
  }
}
function current(owner:ProactiveOwner):boolean {
  const card=getActiveCard()
  return !!stopJob&&activeSessionId.value===owner.sessionId&&card?.id===owner.cardId&&card.hash===owner.cardHash
}
async function loadTask(owner:ProactiveOwner,id:string,version:number):Promise<ProactiveTask|undefined> {
  const result=await queryUserTasks({owner,taskId:id,statuses:["active"],limit:1})
  return result.tasks.find(task=>task.id===id&&task.version===version)
}
async function readRun(owner:ProactiveOwner,task:ProactiveTask,occurrenceId:string):Promise<SchedulerRunRecord|undefined> {
  const response=await getHostBridge().request("scheduler_state",{request:{operation:"run_get",owner,taskId:task.id,taskVersion:task.version,occurrenceId}})
  return "run" in response?response.run??undefined:undefined
}
async function updateRun(run:SchedulerRunRecord,status:SchedulerRunRecord["status"],patch:{artifact?:SchedulerArtifact;error?:string;attemptId?:string;assistantEntryId?:string}={}):Promise<SchedulerRunRecord> {
  const result=await getHostBridge().request("scheduler_state",{request:{operation:"run_update",owner:run.owner,taskId:run.taskId,taskVersion:run.taskVersion,runId:run.runId,expectedRevision:run.revision,status,...patch,operationId:crypto.randomUUID(),now:Date.now()}})
  if(!("run" in result)||!result.run)throw new Error("scheduler_run_update_missing")
  return result.run
}
async function execute(owner:ProactiveOwner,task:ProactiveTask,definition:UserTaskDefinition,occurrenceId:string,until:number):Promise<SchedulerRunRecord|undefined> {
  const result=await getHostBridge().request("scheduler_state",{request:{operation:"run_claim",owner,taskId:task.id,taskVersion:task.version,occurrenceId,runId:crypto.randomUUID(),leaseMs:TASK_RUN_MS+TASK_CHECK_MS,operationId:crypto.randomUUID(),now:Date.now()}})
  if(!("run" in result)||!result.run)return
  let run=result.run
  if(!result.claimed)return run
  if(definition.kind==="reminder")return updateRun(run,"ready_to_deliver",{artifact:{text:definition.text,execution:{until}}})
  const controller=new AbortController()
  const activeKey=`${task.id}:${run.runId}`
  active.set(activeKey,controller)
  const capabilityOwner=`scheduled-prepare:${run.runId}`
  const deadlineAt=Math.min(until,Date.now()+TASK_RUN_MS)
  let workStarted=false
  try {
    const assertCurrent=()=>{if(!stopJob||controller.signal.aborted||Date.now()>=deadlineAt)throw new Error("任务已取消、调度停止或执行时限已到")}
    assertCurrent()
    const grant=definition.authorization
    if(!grant||grant.contentFingerprint!==taskContentFingerprint(definition)||!definition.work) return updateRun(run,"needs_input",{error:"任务缺少可核验的持久授权"})
    const {prepareRunCapabilities}=await import("@/services/init")
    await prepareRunCapabilities(capabilityOwner,assertCurrent)
    const tools=listAll().filter(tool=>definition.work!.capabilities.includes(tool.name)&&isTaskReadCapability(tool))
    workStarted=true
    const output=await runPiSubAgent({
      owner:{kind:"scheduled",runId:run.runId,sessionId:owner.sessionId,cardId:owner.cardId,taskId:task.id,taskVersion:task.version,occurrenceId,
        signal:controller.signal,isCurrent:()=>!!stopJob&&!controller.signal.aborted,
        authorization:{reference:grant.contentFingerprint,taskId:task.id,taskVersion:task.version,authorize:async(tool,params)=>{
          const latest=await loadTask(owner,task.id,task.version)
          const value=latest&&parseUserTaskDefinition(latest.intent)
          return !!value&&!!stopJob&&!controller.signal.aborted&&value.authorization?.contentFingerprint===grant.contentFingerprint
            &&taskContentFingerprint(value)===grant.contentFingerprint&&taskCapabilityScopeAllows(tool,params,value)
        }}},
      task:workPrompt(definition.work,Date.now(),definition.schedule.calendar.timezone),
      systemPrompt:"你执行已获授权的后台任务，独立工作并返回有证据的产物。你不代表用户发言，不更新用户记忆，不向其他会话发消息，不创建子代理。",
      tools,capabilities:{requiredToolNames:definition.work.capabilities},thinkingEffort:definition.execution.thinkingEffort,
      timeoutMs:TASK_RUN_MS,deadlineAt,maxToolCalls:loopConfig.subAgentRounds,maxOutputTokens:2000,
      outputContract:{kind:"json",validate:({artifact,evidence})=>{
        const check=validateWorkArtifact(artifact,definition.work!,evidence,Date.now(),definition.schedule.calendar.timezone)
        return typeof check==="string"?check:true
      }},audit:{reference:`scheduler_runs:${run.runId}`},
    })
    if(!await loadTask(owner,task.id,task.version))return
    if(!output.success) return updateRun(run,output.evidence.unconfirmedEffects?"unresolved":output.status==="needs_input"||output.status==="completed"?"needs_input":"failed",{
      error:summarizeError(output.error??"任务完成条件未通过"),artifact:{text:output.reply,structured:output.artifact,evidence:output.evidence.tools,execution:{...output.resolved,status:output.status,until},audit:{...output.audit}}})
    const artifact=validateWorkArtifact(output.artifact,definition.work,output.evidence,Date.now(),definition.schedule.calendar.timezone)
    if(typeof artifact==="string")return updateRun(run,"needs_input",{error:artifact})
    return updateRun(run,"ready_to_deliver",{artifact:{text:artifact.text,structured:artifact,evidence:output.evidence.tools,execution:{...output.resolved,until,usage:output.usage},audit:{...output.audit}}})
  } catch(error) {
    if(await loadTask(owner,task.id,task.version))run=await updateRun(run,workStarted?"unresolved":"failed",{error:summarizeError(error)})
    log.warn("定时任务执行未收口",{taskId:task.id,runId:run.runId},summarizeError(error))
    return run
  } finally {active.delete(activeKey);await releaseMcpOwner(capabilityOwner)}
}
/** Work outlives a dispatcher tick; reminders must keep their own due-time checks. */
function launchExecution(owner:ProactiveOwner,task:ProactiveTask,definition:UserTaskDefinition,occurrenceId:string,until:number):void {
  if(!stopJob||pendingExecutions.has(occurrenceId))return
  const pending=execute(owner,task,definition,occurrenceId,until)
    .then(()=>{if(stopJob)wake()})
    .catch(error=>log.warn("后台任务执行未收口",{taskId:task.id,occurrenceId},summarizeError(error)))
    .finally(()=>{pendingExecutions.delete(occurrenceId)})
  pendingExecutions.set(occurrenceId,pending)
}
async function periodFor(owner:ProactiveOwner,task:ProactiveTask,definition:UserTaskDefinition,period:SchedulePeriod):Promise<SchedulerPeriodRecord|undefined> {
  const identity={owner,taskId:task.id,taskVersion:task.version,periodKey:period.key}
  const existing=await getHostBridge().request("scheduler_state",{request:{operation:"period_get",...identity}})
  if("period" in existing&&existing.period)return existing.period
  if(period.awaitingEvent||!period.windows.length)return
  const sample=sampleSchedulePeriod(definition.schedule,period,Math.random)
  const result=await getHostBridge().request("scheduler_state",{request:{operation:"period_put",owner,operationId:crypto.randomUUID(),now:Date.now(),period:{taskId:task.id,taskVersion:task.version,periodKey:period.key,timezone:definition.schedule.calendar.timezone,from:period.from,until:sample.windowUntil,targetCount:sample.targetCount,times:sample.instants}}})
  return "period" in result?result.period??undefined:undefined
}
async function reconcile(run:SchedulerRunRecord):Promise<SchedulerRunRecord> {
  if(!run.attemptId)return run
  await reconcileSession(run.owner.sessionId)
  const result=await queryReceipts({owner:run.owner,sessionId:run.owner.sessionId,attemptIds:[run.attemptId],limit:1})
  const attempt=result.attempts[0]
  if(attempt?.status==="committed"&&attempt.assistantEntryId)return updateRun(run,"delivered",{assistantEntryId:attempt.assistantEntryId})
  if(attempt&&["reserved","generating","unresolved"].includes(attempt.status))return {...run,status:"unresolved"}
  return run
}
async function offerReady(owner:ProactiveOwner,task:ProactiveTask,definition:UserTaskDefinition,run:SchedulerRunRecord,from:number,until:number):Promise<void> {
  if(!current(owner))return
  run=await reconcile(run)
  if(run.status!=="ready_to_deliver"||!run.artifact?.text)return
  const ref={kind:"task" as const,id:task.id,version:task.version,revision:task.version,scope:task.scope,scopeId:task.scopeId,fingerprint:`${task.id}:${task.version}`,validUntil:null}
  const context=definition.kind==="agent_job"?JSON.stringify({purpose:"交付已经完成的用户定时任务产物",result:run.artifact,expression:definition.delivery?.expression,
    instruction:"仅根据已保存产物，以当前Card和拟人化设置做简短表达；保留来源与不足，不重新执行查询，不要求用户回复，不把交付当作现实事项完成。"}):JSON.stringify({purpose:"用户主动约定的提醒",intent:definition.text,instruction:"按当前Card自然提醒，不声称用户已完成事项，不要求用户回复。"})
  offer({...opportunity(owner,"scheduled_task",run.occurrenceId,[ref,...task.sourceRefs],from,until,100,context,true),task,expectsReply:false,selfSufficient:true})
}
async function lastDelivery(owner:ProactiveOwner,taskId:string):Promise<number> {
  let cursor:string|undefined,latest=0
  do {
    const result=await getHostBridge().request("scheduler_state",{request:{operation:"run_list",owner,taskId,statuses:["delivered"],cursor,limit:20}})
    if(!("runs" in result))throw new Error("scheduler_run_list_missing")
    for(const run of result.runs)latest=Math.max(latest,run.updatedAt)
    if(result.nextCursor&&result.nextCursor===cursor)throw new Error("scheduler_run_cursor_stalled")
    cursor=result.nextCursor??undefined
  } while(cursor)
  return latest
}
async function checkTask(owner:ProactiveOwner,task:ProactiveTask,now:number):Promise<void> {
  const definition=parseUserTaskDefinition(task.intent)
  if(!definition?.delivery)return
  const boundary=nextScheduleBoundary(definition.schedule,now)
  if(boundary!==null)nextAt=Math.min(nextAt,boundary)
  const deliveryMs=definition.delivery.windowMinutes*60_000
  const periods=definition.schedule.trigger.kind==="observed_event"?[currentSchedulePeriod(definition.schedule,now,event)]:activeSchedulePeriods(definition.schedule,now,deliveryMs)
  for(const period of periods) {
    const sample=await periodFor(owner,task,definition,period)
    if(!sample)continue
    for(let index=0;index<sample.times.length&&stopJob;index++) {
      const from=sample.times[index]!,occurrenceId=`${task.id}:v${task.version}:${sample.periodKey}:${index}`
      const window=period.windows.find(value=>from>=value.from&&from<value.until)
      const fixed=definition.schedule.trigger.kind==="at"||(definition.schedule.trigger.kind==="confirmed_anchor"||definition.schedule.trigger.kind==="observed_event")&&definition.schedule.trigger.windowMinutes===0
      const until=Math.min(definition.schedule.validity.until??Infinity,fixed?from+deliveryMs:window?.until??sample.until)
      if(from>now){nextAt=Math.min(nextAt,from);continue}
      let run=await readRun(owner,task,occurrenceId)
      if(run?.status==="executing"&&run.leaseUntil!==null&&run.leaseUntil<=Date.now())run=await updateRun(run,"unresolved",{error:"执行租约已过期，不能证明完成，不自动重放"})
      if(run&&run.status!=="ready_to_deliver")continue
      if(Date.now()>=until){if(run)await updateRun(run,"expired",{error:"交付窗口已过期"});continue}
      if(task.nextCheckinAt!==null&&task.nextCheckinAt>now){nextAt=Math.min(nextAt,task.nextCheckinAt);continue}
      if(!run&&definition.schedule.missedPolicy==="skip"&&now-from>TASK_CHECK_MS)continue
      if(!run&&definition.kind==="agent_job") {launchExecution(owner,task,definition,occurrenceId,until);continue}
      run??=await execute(owner,task,definition,occurrenceId,until)
      if(run)await offerReady(owner,task,definition,run,from,until)
    }
  }
  if(current(owner))await tick(Date.now(),{remindersOnly:true})
}
async function checkTasks(now:number):Promise<void> {
  refreshWorkEndedEvent(now)
  nextAt=now+TASK_CHECK_MS
  let cursor:string|undefined
  const tasks:Promise<void>[]=[]
  do {
    const page=await getHostBridge().request("scheduler_state",{request:{operation:"task_list",limit:20,cursor}})
    if(!("tasks" in page))throw new Error("scheduler_task_list_missing")
    for(const {task,owner} of page.tasks) {
      if(!stopJob)break
      tasks.push(checkTask(owner,task,now).catch(error=>log.warn("定时任务检查失败",{taskId:task.id},summarizeError(error))))
    }
    if(page.nextCursor&&page.nextCursor===cursor)throw new Error("scheduler_task_cursor_stalled")
    cursor=page.nextCursor??undefined
  } while(cursor&&stopJob)
  await Promise.all(tasks)
}

async function deliveryRun(item:Opportunity):Promise<SchedulerRunRecord|undefined> {
  return item.task&&await loadTask(item.owner,item.task.id,item.task.version)?readRun(item.owner,item.task,item.intentKey):undefined
}
export function startUserTaskRuntime():void {
  if(stopJob)return
  registerScheduledDeliveryHooks({canDeliver:async(item,attemptId)=>{
    const latest=item.task&&await loadTask(item.owner,item.task.id,item.task.version)
    const definition=latest&&parseUserTaskDefinition(latest.intent)
    if(!latest||!definition||!current(item.owner)||latest.nextCheckinAt!==null&&latest.nextCheckinAt>Date.now())return false
    const run=await readRun(item.owner,latest,item.intentKey)
    if(!run||run.status!=="ready_to_deliver")return false
    if(Date.now()-(await lastDelivery(item.owner,run.taskId))<definition.schedule.minGapMinutes*60_000)return false
    // Our own live attempt is guarded by proactive_validate; reconciling it here would
    // misclassify its reserved/generating state as an older unresolved delivery.
    return attemptId&&run.attemptId===attemptId?true:(await reconcile(run)).status==="ready_to_deliver"
  },beforeAttempt:async(item,attemptId)=>{
    const latest=item.task&&await loadTask(item.owner,item.task.id,item.task.version)
    const definition=latest&&parseUserTaskDefinition(latest.intent)
    if(!latest||!definition||!current(item.owner)||latest.nextCheckinAt!==null&&latest.nextCheckinAt>Date.now())return false
    const run=await readRun(item.owner,latest,item.intentKey)
    if(!run||run.status!=="ready_to_deliver")return false
    const prior=await lastDelivery(item.owner,run.taskId)
    if(Date.now()-prior<definition.schedule.minGapMinutes*60_000)return false
    const reconciled=await reconcile(run)
    if(reconciled.status!=="ready_to_deliver")return false
    await updateRun(run,"ready_to_deliver",{attemptId});return true
  },committed:async(item,attemptId,assistantEntryId)=>{
    const run=await deliveryRun(item)
    if(run?.status==="ready_to_deliver"&&run.attemptId===attemptId)await updateRun(run,"delivered",{assistantEntryId})
  }})
  stopJob=internalScheduler.register({id:"user_tasks",nextAt:now=>Math.max(now+1,Math.min(nextAt||now+TASK_CHECK_MS,now+TASK_CHECK_MS)),run:checkTasks,cancel:()=>{for(const controller of active.values())controller.abort(new Error("任务调度停止"))}})
  cleanups.push(watch(activeSessionId,wake),watch(()=>getActivePersonalityId(),wake),subscribeUserTaskChanges(change=>{
    if(change.action!=="snooze") {
      if(change.task)for(const [key,controller] of active)if(key.startsWith(`${change.task.id}:`))controller.abort(new Error("任务定义已改变"))
      else for(const controller of active.values())controller.abort(new Error("任务定义已改变"))
    }
    wake()
  }))
  cleanups.push(subscribeWindowObservations(observation=>{
    const now=observation.observedAt
    if(silentAccessConfig.frequency==="off"||observation.observationState!=="observed"||observation.isPetForeground){resetWorkObservation();return}
    const snapshot=getBehaviorSnapshot(now),category=snapshot.focus.currentCategory
    if(snapshot.quality.status!=="reliable"){resetWorkObservation();return}
    if(category==="work"||category==="development"){hadWorking=true;restSince=0}
    else if(hadWorking&&["leisure","idle"].includes(category??"")&&lastCategory!==category){restSince=now}
    else if(!["leisure","idle"].includes(category??""))restSince=0
    if(hadWorking&&restSince&&now-restSince>=WORK_ENDED_REST_MS){event={event:"work_ended",signal:"working_to_idle",occurredAt:restSince+WORK_ENDED_REST_MS};hadWorking=false;wake()}
    lastCategory=category
  }))
  wake()
}
export async function stopUserTaskRuntime():Promise<void> {
  const remove=stopJob;stopJob=undefined;remove?.()
  resetWorkObservation()
  for(const cleanup of cleanups.splice(0))cleanup()
  for(const controller of active.values())controller.abort(new Error("任务调度停止"))
  await Promise.all([...pendingExecutions.values()])
}
