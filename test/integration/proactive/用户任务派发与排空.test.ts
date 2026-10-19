// L3：只替换宿主事务、子运行与表达端口；验证真实用户任务 dispatcher 的生命周期接线。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ScheduledJob, SchedulerRunRecord } from "@/services/scheduler"
import type { PiSubAgentOutput } from "@/services/engine/harness"
import type { ProactiveOwner, ProactiveTask } from "@/services/proactive/types"
import type { UserTaskDefinition } from "@/services/user-tasks/types"

const state=vi.hoisted(()=>({
  job:undefined as ScheduledJob|undefined,request:vi.fn(),run:vi.fn(),
  tasks:[] as Array<{task:ProactiveTask;owner:ProactiveOwner}>,runs:new Map<string,SchedulerRunRecord>(),
  release:undefined as ((output:PiSubAgentOutput)=>void)|undefined,
}))
vi.mock("@/services/logger",()=>({createLogger:()=>({debug(){},info(){},warn(){},error(){}})}))
vi.mock("@/services/host",()=>({getHostBridge:()=>({request:state.request})}))
vi.mock("@/services/scheduler",()=>({internalScheduler:{register:(job:ScheduledJob)=>{state.job=job;return()=>{}},wake(){}}}))
vi.mock("@/services/session",async()=>({activeSessionId:(await import("vue")).ref("session-a")}))
vi.mock("@/services/personality",()=>({getActiveCard:()=>({id:"card-a",hash:"hash-a"}),getActivePersonalityId:()=>"card-a"}))
vi.mock("@/services/agent",()=>({SUB_AGENT_RUN_TIMEOUT_MS:90_000}))
vi.mock("@/services/engine/harness",()=>({runPiSubAgent:state.run}))
vi.mock("@/services/tool",()=>({listAll:()=>[],releaseMcpOwner:async()=>{}}))
vi.mock("@/services/config",()=>({loopConfig:{subAgentRounds:3},silentAccessConfig:{frequency:"off"}}))
vi.mock("@/services/window",()=>({getLatestWindowObservation:()=>null,subscribeWindowObservations:()=>()=>{}}))
vi.mock("@/services/behavior",()=>({getBehaviorSnapshot:()=>{throw new Error("没有观察时不应读取画像")}}))
vi.mock("@/services/init",()=>({prepareRunCapabilities:async(_owner:string,current?:()=>void)=>{current?.()}}))
vi.mock("@/services/safety",()=>({permissionPromptAvailable:()=>true}))
vi.mock("@/services/user-tasks/validation",()=>({parseUserTaskDefinition:(value:unknown)=>value}))
vi.mock("@/services/proactive",()=>({
  registerScheduledDeliveryHooks(){},offer(){},tick:async()=>{},query:async()=>({attempts:[]}),reconcileSession:async()=>{},
  opportunity:(owner:ProactiveOwner,ruleId:string,intentKey:string,sourceRefs:unknown[],from:number,validUntil:number)=>({owner,ruleId,intentKey,sourceRefs,from,validUntil}),
}))

import { startUserTaskRuntime, stopUserTaskRuntime } from "@/services/user-tasks/runtime"
import { taskContentFingerprint } from "@/services/user-tasks/proposals"

const now=Date.parse("2026-10-18T12:00:00Z")
const owner:ProactiveOwner={sessionId:"session-a",cardId:"card-a",cardHash:"hash-a",runGeneration:0}
function task(id:string,kind:UserTaskDefinition["kind"]):ProactiveTask {
  const definition:UserTaskDefinition={text:id,kind,execution:{thinkingEffort:"low"},schedule:{calendar:{frequency:"daily",timezone:"UTC"},trigger:{kind:"at",time:"12:00"},count:{kind:"fixed",value:1,per:"day"},minGapMinutes:0,validity:{from:now-1000,until:null},missedPolicy:"within_window"},
    delivery:{sessionId:"session-a",cardId:"card-a",cardHash:"hash-a",windowMinutes:15,expression:"自然表达"},
    ...(kind==="agent_job"?{work:{goal:"整理资料",inputs:[],capabilities:[],output:"摘要",completion:"完成摘要"}}:{})}
  definition.authorization={trustedUserEventId:"user-event",contentFingerprint:taskContentFingerprint(definition),sourceVersions:[{kind:"user_entry",id:"source",version:1,revision:1,fingerprint:"source-hash"}],capabilityGrants:[]}
  return {id,version:1,scope:"session",scopeId:"session-a",sourceRefs:[],intent:definition as unknown as ProactiveTask["intent"],eventAt:null,dueAt:null,nextCheckinAt:now,validUntil:null,timezone:"UTC",recurrence:null,state:"active",createdAt:now-1000,updatedAt:now}
}
function incomplete():PiSubAgentOutput {
  return {status:"completed",success:false,reply:'{"text":"缺少资料","completed":false}',artifact:{text:"缺少资料",completed:false},error:"completion_not_met",toolCallsMade:0,
    evidence:{tools:[],incomplete:[],unconfirmedEffects:false},audit:{runId:"work",requestId:"work",ownerKind:"scheduled"}}
}
beforeEach(()=>{
  vi.spyOn(Date,"now").mockReturnValue(now)
  state.runs.clear();state.release=undefined;state.tasks=[{task:task("work","agent_job"),owner},{task:task("reminder","reminder"),owner}]
  state.run.mockReset().mockImplementation(()=>new Promise<PiSubAgentOutput>(resolve=>{state.release=resolve}))
  state.request.mockReset().mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
    const request=args.request,id=String(request.taskId??"")
    if(command==="schedule_query")return{revision:1,tasks:state.tasks.filter(row=>row.task.id===id).map(row=>row.task),nextCursor:null}
    if(command!=="scheduler_state")throw new Error(`unexpected_command:${command}`)
    if(request.operation==="task_list")return{operation:request.operation,tasks:state.tasks,nextCursor:null}
    if(request.operation==="period_get")return{operation:request.operation,period:{taskId:id,taskVersion:1,periodKey:request.periodKey,timezone:"UTC",from:now-12*3600_000,until:now+1,targetCount:1,times:[now],createdAt:now}}
    if(request.operation==="run_get")return{operation:request.operation,run:state.runs.get(id)??null,claimed:false}
    if(request.operation==="run_list")return{operation:request.operation,runs:[],nextCursor:null}
    if(request.operation==="run_claim"){
      const run:SchedulerRunRecord={runId:String(request.runId),taskId:id,taskVersion:1,occurrenceId:String(request.occurrenceId),owner,status:"executing",revision:1,leaseUntil:now+150_000,artifact:null,error:null,attemptId:null,assistantEntryId:null,createdAt:now,updatedAt:now}
      state.runs.set(id,run);return{operation:request.operation,run,claimed:true}
    }
    if(request.operation==="run_update"){
      const previous=state.runs.get(id)!
      if(request.expectedRevision!==previous.revision)throw new Error("fixture_revision_conflict")
      const run={...previous,...request,revision:previous.revision+1,updatedAt:now} as SchedulerRunRecord
      state.runs.set(id,run);return{operation:request.operation,run,claimed:false}
    }
    throw new Error(`unexpected_operation:${request.operation}`)
  })
  startUserTaskRuntime()
})
afterEach(async()=>{state.release?.(incomplete());await stopUserTaskRuntime();vi.restoreAllMocks()})

describe("用户任务派发与排空",()=>{
  it("长工作不阻塞同轮提醒，未满足完成条件保留缺口供用户查询 [scheduled-dispatch-independent-work]",async()=>{
    let drained=false
    const dispatch=state.job!.run(now).then(()=>{drained=true})
    await vi.waitFor(()=>expect(drained).toBe(true),{timeout:1000})
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run.mock.calls[0]?.[0]).toMatchObject({ permissionMode: "interactive" })
    expect(state.runs.get("work")?.status).toBe("executing")
    expect(state.runs.get("reminder")?.status).toBe("ready_to_deliver")
    state.release!(incomplete())
    await dispatch
    await vi.waitFor(()=>expect(state.runs.get("work")?.status).toBe("needs_input"),{timeout:1000})
    expect(state.runs.get("work")?.artifact?.structured).toEqual({text:"缺少资料",completed:false})
  })
  it("注销dispatcher后仍等待已派发工作收尾 [scheduled-dispatch-stop-drain]",async()=>{
    await state.job!.run(now)
    await vi.waitFor(()=>expect(state.run).toHaveBeenCalledTimes(1),{timeout:1000})
    let drained=false
    const stop=stopUserTaskRuntime().then(()=>{drained=true})
    await Promise.resolve()
    expect(drained).toBe(false)
    state.release!(incomplete())
    await stop
    expect(drained).toBe(true)
  })
})
