import { describe, it, expect } from "vitest"
import { opportunity, selectOpportunities, collectOpportunities, advanceFinishedWorkTracker, isLeisureOrIdle, qualifiesFinishedWork, source, usesRandomFallbackInterval } from "@/services/proactive/opportunities"
import { parsePlanningDecision } from "@/services/proactive/planner"
import { getCalendarEvents } from "@/services/proactive/content/calendar"
import { emptyDaily, buildSnapshot } from "@/services/behavior"
import { isQuietTime } from "@/services/proactive/time"
import type { ProactiveOwner } from "@/services/proactive/protocol"

const owner:ProactiveOwner={sessionId:"session-a",cardId:"card-a",cardHash:"hash-a",runGeneration:7}
const now=Date.parse("2026-10-03T03:00:00Z")
const unrelated=opportunity(owner,"topic_share","topic-1",[],now-1,now+100,30,"问个小问题")
const agreed=opportunity(owner,"scheduled_task","task-1",[],now-1,now+100,100,"明确约定",true,[{id:"work-1",version:1}])
describe("主动机会和受限规划",()=>{
  it("未回复不会封死非约定机会；忙碌时仍只放自足内容 [proactive-unanswered-guards]",()=>{
    const selfSufficient={...unrelated,selfSufficient:true}
    expect(selectOpportunities([selfSufficient],new Set(),now,true).map(item=>item.ruleId)).toEqual(["topic_share"])
    expect(selectOpportunities([unrelated],new Set(),now,true)).toEqual([])
    expect(selectOpportunities([agreed],new Set(),now,true).map(item=>item.ruleId)).toEqual(["scheduled_task"])
  })
  it("1–3小时随机槽只限制普通话题，明确锚与画像机会继续走自身节奏 [proactive-random-interval-scope]",()=>{
    expect(usesRandomFallbackInterval("topic_share")).toBe(true)
    expect(usesRandomFallbackInterval("curiosity")).toBe(true)
    expect(usesRandomFallbackInterval("scheduled_task")).toBe(false)
    expect(usesRandomFallbackInterval("memory_checkin")).toBe(false)
    expect(usesRandomFallbackInterval("rhythm")).toBe(false)
    expect(usesRandomFallbackInterval("late_goodnight")).toBe(false)
  })
  it("同一事项重叠锚合并，负评估和过期机会不占选择 [proactive-dedupe-window]",()=>{
    const followup={...agreed,id:"followup",fingerprint:"followup",ruleId:"memory_checkin",priority:90}
    expect(selectOpportunities([unrelated,followup,agreed],new Set(),now,false).map(item=>item.id)).toEqual([agreed.id,"followup"])
    expect(selectOpportunities([agreed],new Set([agreed.fingerprint]),now,false)).toEqual([])
    expect(selectOpportunities([agreed],new Set(),now+100,false)).toEqual([])
  })
  it("超过候选批量的已评估事项不遮挡其后的有效高优先级机会 [proactive-evaluated-prefix-does-not-mask]",()=>{
    const stale=Array.from({length:140},(_,index)=>opportunity(owner,"scheduled_task",`old-${index}`,[],now-1,now+100,100,"已评估",true))
    const fresh=opportunity(owner,"memory_checkin","fresh",[],now-1,now+100,90,"有效事项",true,[{id:"fresh",version:1}])
    const evaluated=new Set(stale.map(item=>item.fingerprint))
    expect(selectOpportunities([...stale,fresh],evaluated,now,false).map(item=>item.id)).toContain(fresh.id)
  })
  it("收工机会要求可靠画像且休闲/空闲连续满十分钟 [proactive-finished-work-rest-lease]",()=>{
    const ended=now-20*60_000,resting=now-9*60_000
    expect(qualifiesFinishedWork({workEndedAt:ended,restingSince:resting,now,wasWorking:false,reliable:true})).toBe(false)
    expect(qualifiesFinishedWork({workEndedAt:ended,restingSince:now-10*60_000,now,wasWorking:false,reliable:true})).toBe(true)
    expect(qualifiesFinishedWork({workEndedAt:ended,restingSince:now-20*60_000,now,wasWorking:true,reliable:true})).toBe(false)
    expect(qualifiesFinishedWork({workEndedAt:ended,restingSince:now-20*60_000,now,wasWorking:false,reliable:false})).toBe(false)
    expect(isLeisureOrIdle("communication",0)).toBe(false)
    expect(isLeisureOrIdle("media",0)).toBe(true)
    const tracker=advanceFinishedWorkTracker({workEndedAt:0,restingSince:now-20*60_000,lastRestObservationAt:now-5*60_000,wasWorking:false},
      {now,working:false,leisureOrIdle:false})
    expect(tracker.restingSince).toBe(0)
    expect(tracker.workEndedAt).toBe(0)
  })
  it("22点只保留不求回应的晚安机会，23点后静默不回落普通分享 [proactive-goodnight-window]",()=>{
    const topic={key:"topic:music",context:"一条自足音乐分享",source:source("behavior","topic:music",1,"topic-hash",owner),targets:[]}
    const base={owner,timezone:"Asia/Shanghai",tasks:[],memoryTargets:[],memoryEnabled:true,behavior:buildSnapshot([],now),topic}
    const goodnightAt=Date.parse("2026-10-03T14:30:00Z")
    const goodnight=collectOpportunities({...base,now:goodnightAt})
    expect(goodnight.map(item=>item.ruleId)).toEqual(["late_goodnight"])
    expect(goodnight[0]?.expectsReply).toBe(false)
    const quietAt=Date.parse("2026-10-03T15:00:00Z")
    expect(isQuietTime(quietAt,"Asia/Shanghai")).toBe(true)
    expect(collectOpportunities({...base,now:quietAt})).toEqual([])
  })
  it("白天不再有硬窗口：非静默时段即可产出整日 rhythm，静默时段仍为空 [proactive-no-daytime-window]",()=>{
    const topic={key:"topic:music",context:"一条自足音乐分享",source:source("behavior","topic:music",1,"topic-hash",owner),targets:[]}
    const base={owner,timezone:"Asia/Shanghai",tasks:[],memoryTargets:[],memoryEnabled:true,behavior:buildSnapshot([],now),topic}
    // 15:00 本地：旧实现（9–12 / 18–22 硬窗口）不会产出 rhythm；新实现两条机会整日有效
    const afternoon=Date.parse("2026-10-03T07:00:00Z")
    const rhythm=collectOpportunities({...base,now:afternoon}).filter(item=>item.ruleId==="rhythm")
    expect(rhythm.map(item=>item.intentKey)).toHaveLength(2)
    for(const item of rhythm){
      expect(item.validFrom).toBe(Date.parse("2026-10-02T16:00:00Z")) // 当日 00:00 本地
      expect(item.validUntil).toBe(Date.parse("2026-10-03T16:00:00Z")) // 次日 00:00 本地
    }
    // 只有静默时段是硬边界：09:00 本地（静默结束）即可产出，08:59 仍是整批为空
    expect(collectOpportunities({...base,now:Date.parse("2026-10-03T01:00:00Z")}).some(item=>item.ruleId==="rhythm")).toBe(true)
    expect(collectOpportunities({...base,now:Date.parse("2026-10-03T00:59:00Z")})).toEqual([])
  })
  it("周日回顾不再等晚间；晚安窗口收口是静默开始时刻，不是白天收口 [proactive-retrospective-goodnight-derived]",()=>{
    const reliable={...buildSnapshot([],now),revision:7,quality:{status:"reliable" as const,sampleDays:5,coverageRatio:0.9,eligibleCollectionMs:10,reasons:[]}}
    const base={owner,timezone:"Asia/Shanghai",tasks:[],memoryTargets:[],memoryEnabled:true,behavior:reliable,topic:null}
    // 周日 10:00 本地：旧实现只在 18–22 产出回顾
    const sunday=Date.parse("2026-10-04T02:00:00Z")
    const retro=collectOpportunities({...base,now:sunday}).filter(item=>item.ruleId==="retrospective")
    expect(retro).toHaveLength(1)
    expect(retro[0]?.validFrom).toBe(Date.parse("2026-10-03T16:00:00Z")) // 周日 00:00 本地
    expect(retro[0]?.validUntil).toBe(Date.parse("2026-10-04T16:00:00Z")) // 次日 00:00 本地
    // 周六 22:30：晚安窗口 22:00 → 静默开始 23:00（旧实现的收口是次日 00:00）
    const goodnight=collectOpportunities({...base,now:Date.parse("2026-10-03T14:30:00Z")}).filter(item=>item.ruleId==="late_goodnight")
    expect(goodnight).toHaveLength(1)
    expect(goodnight[0]?.validFrom).toBe(Date.parse("2026-10-03T14:00:00Z"))
    expect(goodnight[0]?.validUntil).toBe(Date.parse("2026-10-03T15:00:00Z"))
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
