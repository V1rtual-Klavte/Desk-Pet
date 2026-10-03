import { describe, it, expect } from "vitest"
import { acceptRecurrenceProposal, resolveRescheduledValidUntil, validateRecurrence } from "@/services/tool/local-extra/proactive"
import { accountedUsage } from "@/services/proactive/usage"

describe("周期证据与实际用量",()=>{
  it("普通提议不建周期，用户明确约定才准入有限日历规则 [proactive-recurrence-consent]",()=>{
    const weekly={frequency:"weekly",localTime:"09:30",timezone:"Asia/Shanghai",weekdays:[1,5]}
    expect(()=>validateRecurrence(weekly,"好像可以试试看哦")).toThrow("用户明确同意")
    expect(validateRecurrence(weekly,"每周一和周五九点半提醒我练琴")).toEqual(weekly)
    expect(()=>validateRecurrence({...weekly,weekdays:[7]},"每周提醒我")).toThrow("合法星期")
    expect(()=>validateRecurrence({...weekly,cron:"* * * * *"},"每周提醒我")).toThrow("未知周期字段")
  })
  it("简短同意可跨用户回合接受持久提议，但仍精确绑定Card与提议内容 [proactive-recurrence-proposal-acceptance]",()=>{
    const owner={sessionId:"session-a",cardId:"card-a",cardHash:"hash-a",runGeneration:4}
    const recurrence={frequency:"weekly" as const,localTime:"09:30",timezone:"Asia/Shanghai",weekdays:[1,5]}
    const proposal={proposalId:"tool-call-a",assistantEntryId:"assistant-entry-a",intent:"练琴",recurrence,nextCheckinAt:2_000,validUntil:null,owner}
    expect(acceptRecurrenceProposal([proposal],proposal.proposalId,owner,"练琴",recurrence,2_000,null,"好，就这样",1_000)).toEqual(recurrence)
    expect(acceptRecurrenceProposal([proposal],proposal.proposalId,{...owner,runGeneration:5},"练琴",recurrence,2_000,null,"好，就这样",1_000),
      "持久提议在下一轮接受时 runGeneration 已递增，不应因此失效").toEqual(recurrence)
    expect(()=>acceptRecurrenceProposal([proposal],"other-proposal",owner,"练琴",recurrence,2_000,null,"好，就这样",1_000)).toThrow("没有匹配")
    expect(()=>acceptRecurrenceProposal([proposal],proposal.proposalId,owner,"练琴",recurrence,2_000,null,"好像可以试试",1_000)).toThrow("没有匹配")
    expect(()=>acceptRecurrenceProposal([proposal],proposal.proposalId,{...owner,cardId:"card-b"},"练琴",recurrence,2_000,null,"好",1_000)).toThrow("没有匹配")
    expect(()=>acceptRecurrenceProposal([proposal],proposal.proposalId,owner,"练琴",{...recurrence,weekdays:[2]},2_000,null,"好",1_000)).toThrow("不一致")
  })
  it("周期延后沿用原有效期，包括永久周期和有限周期 [proactive-recurrence-snooze-validity]",()=>{
    expect(resolveRescheduledValidUntil({recurrence:{frequency:"daily",localTime:"09:00",timezone:"UTC"},validUntil:null},5_000)).toBeNull()
    expect(resolveRescheduledValidUntil({recurrence:{frequency:"daily",localTime:"09:00",timezone:"UTC"},validUntil:20_000},5_000)).toBe(20_000)
    expect(()=>resolveRescheduledValidUntil({recurrence:{frequency:"daily",localTime:"09:00",timezone:"UTC"},validUntil:20_000},20_000)).toThrow("有效窗口无效")
    expect(resolveRescheduledValidUntil({recurrence:null,validUntil:20_000},5_000,undefined,"snooze")).toBe(20_000)
    expect(resolveRescheduledValidUntil({recurrence:null,validUntil:null},5_000)).toBe(5_000+2*86_400_000)
  })
  it("实际Token含缓存分列，未知/非法用量保持未知不冒充零 [proactive-actual-usage]",()=>{
    expect(accountedUsage({inputTokens:100,outputTokens:25,cacheRead:300,cacheWrite:50})).toEqual({inputTokens:100,outputTokens:25,cacheRead:300,cacheWrite:50,totalTokens:475})
    expect(accountedUsage({inputTokens:100})).toBeNull()
    expect(accountedUsage({inputTokens:100,outputTokens:-1})).toBeNull()
    expect(accountedUsage(null)).toBeNull()
  })
})
