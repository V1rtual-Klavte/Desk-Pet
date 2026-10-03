import { describe, it, expect } from "vitest"
import { validateRecurrence } from "@/services/tool/local-extra/proactive"
import { accountedUsage } from "@/services/proactive/usage"

describe("周期证据与实际用量",()=>{
  it("普通提议不建周期，用户明确约定才准入有限日历规则 [proactive-recurrence-consent]",()=>{
    const weekly={frequency:"weekly",localTime:"09:30",timezone:"Asia/Shanghai",weekdays:[1,5]}
    expect(()=>validateRecurrence(weekly,"好像可以试试看哦")).toThrow("用户明确同意")
    expect(validateRecurrence(weekly,"每周一和周五九点半提醒我练琴")).toEqual(weekly)
    expect(()=>validateRecurrence({...weekly,weekdays:[7]},"每周提醒我")).toThrow("合法星期")
    expect(()=>validateRecurrence({...weekly,cron:"* * * * *"},"每周提醒我")).toThrow("未知周期字段")
  })
  it("实际Token含缓存分列，未知/非法用量保持未知不冒充零 [proactive-actual-usage]",()=>{
    expect(accountedUsage({inputTokens:100,outputTokens:25,cacheRead:300,cacheWrite:50})).toEqual({inputTokens:100,outputTokens:25,cacheRead:300,cacheWrite:50,totalTokens:475})
    expect(accountedUsage({inputTokens:100})).toBeNull()
    expect(accountedUsage({inputTokens:100,outputTokens:-1})).toBeNull()
    expect(accountedUsage(null)).toBeNull()
  })
})
