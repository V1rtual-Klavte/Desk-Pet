import { describe, it, expect } from "vitest"
import { accountedUsage } from "@/services/proactive/usage"

describe("周期证据与实际用量",()=>{
  it("实际Token含缓存分列，未知/非法用量保持未知不冒充零 [proactive-actual-usage]",()=>{
    expect(accountedUsage({inputTokens:100,outputTokens:25,cacheRead:300,cacheWrite:50})).toEqual({inputTokens:100,outputTokens:25,cacheRead:300,cacheWrite:50,totalTokens:475})
    expect(accountedUsage({inputTokens:100})).toBeNull()
    expect(accountedUsage({inputTokens:100,outputTokens:-1})).toBeNull()
    expect(accountedUsage(null)).toBeNull()
  })
})
