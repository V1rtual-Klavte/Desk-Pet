import { describe, it, expect } from "vitest"
import { localToInstant, checkinWindows, isQuietTime, nextSpeakingTime, calendarAnniversary } from "@/services/proactive/time"
import { recurrenceSlot } from "@/services/proactive/opportunities"
import type { ProactiveTask } from "@/services/proactive/protocol"

describe("主动事项时间",()=>{
  it("日期精度临期只在前一日合法窗口，跟进在日期结束之后 [proactive-day-anchor]",()=>{
    const windows=checkinWindows({precision:"day",localDate:"2026-10-03",timezone:"Asia/Shanghai"})
    expect(windows.map(({phase,from,until})=>({phase,from,until}))).toEqual([
      {phase:"before",from:Date.parse("2026-10-02T01:00:00Z"),until:Date.parse("2026-10-02T14:00:00Z")},
      {phase:"after",from:Date.parse("2026-10-03T16:00:00Z"),until:Date.parse("2026-10-05T16:00:00Z")},
    ])
  })
  it("分钟精度保留精确24h/48h，不把day截止伪造为钟点 [proactive-minute-anchor]",()=>{
    const instant=Date.parse("2026-10-03T07:30:00Z")
    expect(checkinWindows({precision:"minute",instant,timezone:"Asia/Shanghai"}).map(row=>[row.phase,row.from,row.until])).toEqual([
      ["before",Date.parse("2026-10-02T07:30:00Z"),instant],["after",instant,Date.parse("2026-10-05T07:30:00Z")],
    ])
  })
  it("DST缺失时间顺延首个合法分钟，重复时间取第一次 [proactive-dst-resolution]",()=>{
    expect(localToInstant("2026-03-08","02:30","America/New_York")).toBe(Date.parse("2026-03-08T07:00:00Z"))
    expect(localToInstant("2026-11-01","01:30","America/New_York")).toBe(Date.parse("2026-11-01T05:30:00Z"))
    expect(()=>localToInstant("2026-02-30","09:00","Asia/Shanghai")).toThrow("invalid local date")
  })
  it("静默边界22点至09点及闰日周年，不推迟已合法时间 [proactive-quiet-boundary]",()=>{
    const at=(text:string)=>Date.parse(`2026-10-03T${text}+08:00`)
    expect([isQuietTime(at("08:59:00"),"Asia/Shanghai"),isQuietTime(at("09:00:00"),"Asia/Shanghai"),isQuietTime(at("21:59:00"),"Asia/Shanghai"),isQuietTime(at("22:00:00"),"Asia/Shanghai")]).toEqual([true,false,false,true])
    expect(nextSpeakingTime(at("22:00:00"),"Asia/Shanghai")).toBe(Date.parse("2026-10-04T01:00:00Z"))
    expect(nextSpeakingTime(at("09:00:00"),"Asia/Shanghai")).toBe(at("09:00:00"))
    expect(calendarAnniversary(2027,2,29)).toBe("2027-02-28")
  })
  it("月周期按当地日历最后合法日，不积压旧 occurrence [proactive-recurring-slot]",()=>{
    const task={id:"month",version:3,nextCheckinAt:null,validUntil:null,recurrence:{frequency:"monthly",localTime:"09:00",timezone:"Asia/Shanghai",dayOfMonth:31}} as ProactiveTask
    const slot=recurrenceSlot(task,Date.parse("2027-02-28T02:00:00Z"))
    expect(slot).toEqual({id:"month:v3:2027-02-28:09:00",from:Date.parse("2027-02-28T01:00:00Z"),until:Date.parse("2027-02-28T16:00:00Z")})
    expect(recurrenceSlot(task,Date.parse("2027-03-01T02:00:00Z"))).toBeNull()
  })
})
