import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest"
import { localToInstant, checkinWindows, isQuietTime, isQuietHour, isNightlyWindow, nextSpeakingTime, calendarAnniversary, localDayKey } from "@/services/proactive/time"
import { setOverride } from "@/services/config"
import { recurrenceSlot } from "@/services/proactive/opportunities"
import { setTestDataRoot } from "../../host/node-ipc"
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
  it("静默边界23点至09点及闰日周年，不推迟已合法时间 [proactive-quiet-boundary]",()=>{
    const at=(text:string)=>Date.parse(`2026-10-03T${text}+08:00`)
    expect([isQuietTime(at("08:59:00"),"Asia/Shanghai"),isQuietTime(at("09:00:00"),"Asia/Shanghai"),isQuietTime(at("22:59:00"),"Asia/Shanghai"),isQuietTime(at("23:00:00"),"Asia/Shanghai")]).toEqual([true,false,false,true])
    expect(nextSpeakingTime(at("22:00:00"),"Asia/Shanghai")).toBe(at("22:00:00"))
    expect(nextSpeakingTime(at("23:00:00"),"Asia/Shanghai")).toBe(Date.parse("2026-10-04T01:00:00Z"))
    expect(nextSpeakingTime(at("09:00:00"),"Asia/Shanghai")).toBe(at("09:00:00"))
    expect(calendarAnniversary(2027,2,29)).toBe("2027-02-28")
  })
  it("未回复两次只从阈值后的下个当地日降档，可信用户输入清零阈值 [proactive-unanswered-daily-freeze]",()=>{
    const threshold=Date.parse("2026-10-03T14:00:00Z") // 22:00 Asia/Shanghai
    const thresholdDate=localDayKey(threshold,"Asia/Shanghai")
    expect(thresholdDate).toBe("2026-10-03")
    expect(localDayKey(Date.parse("2026-10-03T15:59:00Z"),"Asia/Shanghai")).toBe(thresholdDate)
    expect(localDayKey(Date.parse("2026-10-03T16:00:00Z"),"Asia/Shanghai")).toBe("2026-10-04")
    expect(localDayKey(Date.parse("2026-10-04T01:00:00Z"),"Asia/Shanghai")).toBe("2026-10-04")
  })
  it("月周期按当地日历最后合法日，不积压旧 occurrence [proactive-recurring-slot]",()=>{
    const task={id:"month",version:3,nextCheckinAt:null,validUntil:null,recurrence:{frequency:"monthly",localTime:"09:00",timezone:"Asia/Shanghai",dayOfMonth:31}} as ProactiveTask
    const slot=recurrenceSlot(task,Date.parse("2027-02-28T02:00:00Z"))
    expect(slot).toEqual({id:"month:v3:2027-02-28:09:00",from:Date.parse("2027-02-28T01:00:00Z"),until:Date.parse("2027-02-28T16:00:00Z")})
    expect(recurrenceSlot(task,Date.parse("2027-03-01T02:00:00Z"))).toBeNull()
  })
})

// ── 静默时段是 CONFIG 派生（ai.proactive.quietStartHour/quietEndHour）后的三形态与派生窗口 ──
// 本文件的断言全部按「跨夜 23–9」口径写：出厂默认（2026-10-06 起 0/0 不静默）是会变的产品决策，
// 基线因此在 beforeEach 显式声明、不继承出厂值；要别的形态的用例在自己的 it 里覆盖。
// setOverride 会触发配置回写；给测试宿主一个临时数据根，回写落到可弃目录而不是报错刷屏。
let quietRoot=""
beforeAll(()=>{ quietRoot=mkdtempSync(join(tmpdir(),"deskpet-proactive-time-")); setTestDataRoot(quietRoot) })
beforeEach(()=>{ setOverride("ai.proactive.quietStartHour",23); setOverride("ai.proactive.quietEndHour",9) })
afterAll(()=>{ rmSync(quietRoot,{recursive:true,force:true}) })

describe("静默时段三形态与派生窗口",()=>{
  const at=(text:string)=>Date.parse(`2026-10-03T${text}+08:00`)

  it("纯公式覆盖跨夜、同日、相等三形态 [proactive-quiet-hour-forms]",()=>{
    // 跨夜（start > end）：睡前段与凌晨段都算静默
    expect([isQuietHour(23,23,9),isQuietHour(2,23,9),isQuietHour(8,23,9),isQuietHour(9,23,9),isQuietHour(22,23,9)]).toEqual([true,true,true,false,false])
    // 同日（start < end）：只覆盖 [start, end)
    expect([isQuietHour(12,12,14),isQuietHour(13,12,14),isQuietHour(14,12,14),isQuietHour(11,12,14)]).toEqual([true,true,false,false])
    // start == end = 不静默
    expect([isQuietHour(10,10,10),isQuietHour(3,10,10)]).toEqual([false,false])
  })

  it("isQuietTime 随 CONFIG 值走：同日静默生效，start==end 全不静默 [proactive-quiet-config-driven]",()=>{
    setOverride("ai.proactive.quietStartHour",12); setOverride("ai.proactive.quietEndHour",14)
    expect(isQuietTime(at("13:00:00"),"Asia/Shanghai")).toBe(true)
    expect(isQuietTime(at("11:59:00"),"Asia/Shanghai")).toBe(false)
    expect(isQuietTime(at("23:00:00"),"Asia/Shanghai")).toBe(false)
    setOverride("ai.proactive.quietStartHour",10); setOverride("ai.proactive.quietEndHour",10)
    expect(isQuietTime(at("10:00:00"),"Asia/Shanghai")).toBe(false)
    expect(isQuietTime(at("03:00:00"),"Asia/Shanghai")).toBe(false)
  })

  it("nextSpeakingTime 三形态：跨夜顺延次日、同日回到当日结束、相等原样返回 [proactive-next-speaking-forms]",()=>{
    setOverride("ai.proactive.quietStartHour",23); setOverride("ai.proactive.quietEndHour",9)
    expect(nextSpeakingTime(at("23:30:00"),"Asia/Shanghai")).toBe(Date.parse("2026-10-04T01:00:00Z"))
    expect(nextSpeakingTime(at("02:00:00"),"Asia/Shanghai")).toBe(at("09:00:00"))
    setOverride("ai.proactive.quietStartHour",12); setOverride("ai.proactive.quietEndHour",14)
    expect(nextSpeakingTime(at("13:30:00"),"Asia/Shanghai")).toBe(at("14:00:00"))
    setOverride("ai.proactive.quietStartHour",10); setOverride("ai.proactive.quietEndHour",10)
    expect(nextSpeakingTime(at("23:30:00"),"Asia/Shanghai")).toBe(at("23:30:00"))
  })

  it("isNightlyWindow 是静默开始前一小时（start=0 时落在前一日 23 点）[proactive-nightly-window-derived]",()=>{
    setOverride("ai.proactive.quietStartHour",23)
    expect(isNightlyWindow(at("22:30:00"),"Asia/Shanghai")).toBe(true)
    expect(isNightlyWindow(at("21:30:00"),"Asia/Shanghai")).toBe(false)
    expect(isNightlyWindow(at("23:30:00"),"Asia/Shanghai")).toBe(false)
    setOverride("ai.proactive.quietStartHour",0)
    expect(isNightlyWindow(at("23:30:00"),"Asia/Shanghai")).toBe(true)
    expect(isNightlyWindow(at("22:30:00"),"Asia/Shanghai")).toBe(false)
  })

  it("checkin before 窗口随静默三形态派生且 from 恒早于 until [proactive-checkin-window-derived]",()=>{
    // 跨夜（start > end）：前一日 [静默结束, 静默开始前一小时) 的白天分享窗——保留现状口径
    setOverride("ai.proactive.quietStartHour",20); setOverride("ai.proactive.quietEndHour",7)
    const overnight=checkinWindows({precision:"day",localDate:"2026-10-03",timezone:"Asia/Shanghai"})
    // 前一日 07:00 起（静默结束）到 19:00 止（静默开始前一小时），不再假设 09/23
    expect(overnight[0]).toMatchObject({from:Date.parse("2026-10-01T23:00:00Z"),until:Date.parse("2026-10-02T11:00:00Z")})

    // 同日（start < end）：前一日 [静默结束 14:00, 24:00)——前一日 24:00 即锚日 0 点
    setOverride("ai.proactive.quietStartHour",12); setOverride("ai.proactive.quietEndHour",14)
    const sameDay=checkinWindows({precision:"day",localDate:"2026-10-03",timezone:"Asia/Shanghai"})
    expect(sameDay[0].from).toBeLessThan(sameDay[0].until)
    expect(sameDay[0]).toMatchObject({from:Date.parse("2026-10-02T06:00:00Z"),until:Date.parse("2026-10-02T16:00:00Z")})

    // start == end（显式不静默）：前一日整日 [00:00, 24:00)
    setOverride("ai.proactive.quietStartHour",10); setOverride("ai.proactive.quietEndHour",10)
    const noQuiet=checkinWindows({precision:"day",localDate:"2026-10-03",timezone:"Asia/Shanghai"})
    expect(noQuiet[0].from).toBeLessThan(noQuiet[0].until)
    expect(noQuiet[0]).toMatchObject({from:Date.parse("2026-10-01T16:00:00Z"),until:Date.parse("2026-10-02T16:00:00Z")})

    // after 窗口与静默形态无关：锚日 0 点起 48 小时（2026-10-04 00:00 +08 至 2026-10-06 00:00 +08）
    expect(sameDay[1]).toMatchObject({from:Date.parse("2026-10-03T16:00:00Z"),until:Date.parse("2026-10-05T16:00:00Z")})
  })
})
