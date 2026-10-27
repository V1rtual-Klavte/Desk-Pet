import { afterEach, describe, expect, it, vi } from "vitest"
import { SchedulerKernel } from "@/services/scheduler/kernel"

afterEach(()=>vi.useRealTimers())
describe("统一业务调度",()=>{
  it("多个独立作业只持有一个唤醒计时器并按截止时间执行 [scheduler-single-wake]",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0)
    const kernel=new SchedulerKernel(),seen:string[]=[]
    kernel.register({id:"later",nextAt:()=>2000,run:async()=>{seen.push("later")}})
    kernel.register({id:"first",nextAt:()=>1000,run:async()=>{seen.push("first")}})
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(["first"])
    await kernel.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("提醒唤醒不重算随机扫描截止时间 [scheduler-independent-reminder-wake]",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0)
    const kernel=new SchedulerKernel(),randomNext=vi.fn(()=>10_000),seen:string[]=[]
    kernel.register({id:"random",nextAt:randomNext,run:async()=>{seen.push("random")}})
    kernel.register({id:"reminder",nextAt:()=>50_000,run:async()=>{seen.push("reminder")}})
    kernel.wake("reminder")
    await vi.advanceTimersByTimeAsync(1)
    expect(randomNext).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(["reminder"])
    await vi.advanceTimersByTimeAsync(9999)
    expect(seen).toEqual(["reminder","random"])
    await kernel.stop()
  })
  it("同作业单飞，取消后仍等待在飞任务排空 [scheduler-cancel-drain]",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0)
    const kernel=new SchedulerKernel(),cancel=vi.fn(),run=vi.fn()
    let release!:()=>void
    const pending=new Promise<void>(resolve=>{release=resolve})
    const remove=kernel.register({id:"held",nextAt:()=>0,cancel,run:async()=>{run();await pending}})
    const draining=kernel.drain()
    await Promise.resolve();kernel.wake("held")
    await kernel.drain()
    expect(run).toHaveBeenCalledTimes(1)
    remove()
    let stopped=false
    const stop=kernel.stop().then(()=>{stopped=true})
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stopped).toBe(false)
    release();await draining;await stop
    expect(stopped).toBe(true)
  })
  it("关停后的晚到配置不能复活全局调度器 [scheduler-stopped-no-revive]",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0)
    const kernel=new SchedulerKernel()
    await kernel.stop()
    expect(()=>kernel.register({id:"late-config",nextAt:()=>1,run:async()=>{}})).toThrow("scheduler_stopped")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("关停有界等待在飞作业，超时如实报告未收敛的作业 [scheduler-stop-bounded]",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0)
    const kernel=new SchedulerKernel(),cancel=vi.fn()
    let release!:()=>void
    const held=new Promise<void>(resolve=>{release=resolve})
    kernel.register({id:"held",nextAt:()=>0,cancel,run:async()=>{await held}})
    void kernel.drain()
    await Promise.resolve()
    const stopping=kernel.stop({timeoutMs:1000})
    await vi.advanceTimersByTimeAsync(1000)
    const report=await stopping
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(report).toEqual({canceled:1,drained:false,abandoned:["held"]})
    release()
    await Promise.resolve()
  })
  it("作业抛错只留痕，不终止调度，后续唤醒仍会执行（故障救援） [scheduler-failure-rescue]",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0)
    const kernel=new SchedulerKernel(),run=vi.fn(()=>Promise.reject(new Error("transient")))
    kernel.register({id:"flaky",nextAt:()=>1000,run})
    kernel.wake("flaky")
    await vi.advanceTimersByTimeAsync(1)
    kernel.wake("flaky")
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(await kernel.stop()).toEqual({canceled:0,drained:true,abandoned:[]})
  })
  it("旧注销回调不能删除同名的新一代作业 [scheduler-stale-disposer]",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0)
    const kernel=new SchedulerKernel(),seen:string[]=[],cancel=vi.fn()
    const old=kernel.register({id:"same",nextAt:()=>1000,run:async()=>{seen.push("old")},cancel})
    old()
    kernel.register({id:"same",nextAt:()=>1000,run:async()=>{seen.push("new")}})
    old()
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(["new"])
    expect(cancel).toHaveBeenCalledTimes(1)
    await kernel.stop()
  })

})
