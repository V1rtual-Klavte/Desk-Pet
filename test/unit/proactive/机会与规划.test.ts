import { describe, it, expect } from "vitest"
import { opportunity, selectOpportunities, collectOpportunities } from "@/services/proactive/opportunities"
import { parsePlanningDecision } from "@/services/proactive/planner"
import { getCalendarEvents } from "@/services/proactive/content/calendar"
import { emptyDaily, buildSnapshot } from "@/services/behavior"
import type { ProactiveOwner } from "@/services/proactive/protocol"

const owner:ProactiveOwner={sessionId:"session-a",cardId:"card-a",cardHash:"hash-a",runGeneration:7}
const now=Date.parse("2026-10-03T03:00:00Z")
const unrelated=opportunity(owner,"topic_share","topic-1",[],now-1,now+100,30,"问个小问题")
const agreed=opportunity(owner,"scheduled_task","task-1",[],now-1,now+100,100,"明确约定",true,[{id:"work-1",version:1}])
describe("主动机会和受限规划",()=>{
  it("未回复两次抑制非约定，四次抑制所有；工作上下文保留明确约定 [proactive-unanswered-guards]",()=>{
    expect(selectOpportunities([unrelated,agreed],new Set(),now,2,true).map(item=>item.ruleId)).toEqual(["scheduled_task"])
    expect(selectOpportunities([unrelated,agreed],new Set(),now,4,false)).toEqual([])
    expect(selectOpportunities([unrelated],new Set(),now,0,true)).toEqual([])
  })
  it("同一事项重叠锚合并，负评估和过期机会不占选择 [proactive-dedupe-window]",()=>{
    const followup={...agreed,id:"followup",fingerprint:"followup",ruleId:"memory_checkin",priority:90}
    expect(selectOpportunities([unrelated,followup,agreed],new Set(),now,0,false).map(item=>item.id)).toEqual([agreed.id,"followup"])
    expect(selectOpportunities([agreed],new Set([agreed.fingerprint]),now,0,false)).toEqual([])
    expect(selectOpportunities([agreed],new Set(),now+100,0,false)).toEqual([])
  })
  it("扫描事项无来源、已完成及未进入窗口不生成提醒 [proactive-working-evidence]",()=>{
    const base={owner,now,timezone:"Asia/Shanghai",tasks:[],memoryEnabled:true,behavior:buildSnapshot([],now),topic:null}
    const target={id:"work",version:2,scope:"user" as const,scopeId:null,kind:"working" as const,workingState:"open" as const,aliases:[],sourceIds:["user-source"],updatedAt:now,eventAt:null,dueAt:{precision:"minute" as const,instant:now+1000,timezone:"Asia/Shanghai"}}
    expect(collectOpportunities({...base,memoryTargets:[target]}).filter(item=>item.ruleId==="memory_checkin").map(item=>item.targets)).toEqual([[{id:"work",version:2}]])
    expect(collectOpportunities({...base,memoryTargets:[{...target,sourceIds:[]}]}).filter(item=>item.ruleId==="memory_checkin")).toEqual([])
    expect(collectOpportunities({...base,memoryTargets:[{...target,workingState:"completed"}]}).filter(item=>item.ruleId==="memory_checkin")).toEqual([])
    expect(collectOpportunities({...base,memoryEnabled:false,memoryTargets:[target]}).filter(item=>item.ruleId==="memory_checkin")).toEqual([])
  })
  it("只接受有限JSON决策，一次跟进限定未来1到7天，禁止脚本和周期 [proactive-planner-validation]",()=>{
    expect(parsePlanningDecision(JSON.stringify({kind:"speak_now",reason:"有明确依据",intent:"问问结果"}),now)).toEqual({kind:"speak_now",reason:"有明确依据",intent:"问问结果"})
    expect(()=>parsePlanningDecision(JSON.stringify({kind:"schedule",reason:"",intent:"",nextCheckinAt:now+3600_000}),now)).toThrow("planner_invalid_schedule")
    expect(()=>parsePlanningDecision(JSON.stringify({kind:"schedule",reason:"",intent:"",nextCheckinAt:now+8*86400_000}),now)).toThrow("planner_invalid_schedule")
    expect(()=>parsePlanningDecision('{"kind":"speak_now","reason":"","intent":"","tools":["bash"]}',now)).toThrow("planner_unknown_field")
    expect(()=>parsePlanningDecision('{"kind":"schedule","reason":"","intent":"","recurrence":"daily"}',now)).toThrow("planner_unknown_field")
  })
  it("官方离线日期覆盖范围外明确不可用，已知农历节日有确切日期 [proactive-calendar-coverage]",()=>{
    expect(getCalendarEvents("2026-02-17").events.map(row=>row.name)).toContain("春节")
    expect(getCalendarEvents("2026-09-25").events.map(row=>row.name)).toContain("中秋节")
    expect(getCalendarEvents("2036-02-01")).toEqual({status:"calendar_uncovered",events:[]})
  })
})
