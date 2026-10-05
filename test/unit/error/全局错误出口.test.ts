// ==========================================
// 全局错误出口（src/services/error/global.ts）与错误摘要脱敏（format.ts）
// ==========================================
//
// reportError 是 Node 领域唯一错误出口：写日志 + 通知宿主落盘 + 按需展示。
// 这里断言两件容易在重构中被静默改掉的事：
//   · 落盘给宿主的载荷必须是「来源/分类 + 原文 + 详情」三件套（缺一故障就无法定位）；
//   · overlay:false（预期内失败）只走 warn 留痕，不能升级成错误日志；
//   · 出口自身永不抛（否则报错引发二次报错）。
// 另覆盖 summarizeError 会随会话持久化的脱敏契约：密钥形态必须先打码再截断。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { errorDetail, reportError, summarizeError } from "@/services/error"
import { installNodeHostBridge } from "../../host/install-node-bridge"

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

// logger 被替换成记录器：其余导出保持与真实模块同形状（config 等传递依赖要取 LEVEL_ORDER/setLogLevel）。
vi.mock("@/services/logger", () => ({
  LEVELS: ["debug", "info", "warn", "error"],
  LEVEL_ORDER: { debug: 0, info: 1, warn: 2, error: 3 },
  setLogLevel: vi.fn(),
  getLogLevel: () => "debug",
  flushLogs: async () => true,
  createLogger: () => loggerMocks,
}))

interface RecordedCall {
  method: string
  args: unknown
}

function installRecordingBridge(): RecordedCall[] {
  const calls: RecordedCall[] = []
  const bridge = {
    async request(method: string, args: unknown) {
      calls.push({ method, args })
    },
    subscribe: () => () => {},
    async readBlob() {
      return new Uint8Array()
    },
    async releaseBlob() {},
  } as unknown as HostBridge
  setHostBridge(bridge)
  return calls
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  installNodeHostBridge()
})

describe("reportError 单一出口", () => {
  it("把来源/分类、脱敏前的原文与完整详情交给宿主落盘，并写 error 日志", () => {
    const calls = installRecordingBridge()
    reportError("窗口", new Error("boom"))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("report_frontend_error")
    expect(calls[0]!.args).toEqual({
      source: "窗口/error",
      message: "boom",
      stack: expect.stringContaining("boom"),
    })
    // 详情里必须是 stack（有行号可查），不是只有 message
    expect(errorDetail(new Error("boom"))).toContain("Error: boom")
    expect(loggerMocks.error).toHaveBeenCalledTimes(1)
    expect(loggerMocks.warn).not.toHaveBeenCalled()
  })

  it("fatal 标记进错误日志，分类取 options.kind", () => {
    installRecordingBridge()
    reportError("发送", new Error("链路断了"), { kind: "network", fatal: true })
    const [message] = loggerMocks.error.mock.calls[0]!
    expect(String(message)).toContain("[发送]")
    expect(String(message)).toContain("network")
    expect(String(message)).toContain("(fatal)")
    expect(loggerMocks.error.mock.calls[0]![1]).toContain("链路断了")
  })

  it("overlay:false 的预期内失败只留 warn，不升级成错误日志", () => {
    const calls = installRecordingBridge()
    reportError("Profile", { code: "IO", message: "素材缺失" }, { kind: "asset", overlay: false })

    expect(calls[0]!.args).toEqual({ source: "Profile/asset", message: "素材缺失", stack: "IO: 素材缺失" })
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1)
    expect(loggerMocks.error).not.toHaveBeenCalled()
  })

  it("宿主通道未注入时也永不抛出，日志留痕照走", () => {
    setHostBridge(null)
    expect(() => reportError("Config", new Error("save failed"))).not.toThrow()
    expect(loggerMocks.error).toHaveBeenCalledTimes(1)
  })

  it("宿主上报失败（异步 reject）不阻断出口，也不产生未处理拒绝", async () => {
    const bridge = {
      request: vi.fn(async () => {
        throw Object.assign(new Error("report rejected"), { code: "OTHER" })
      }),
      subscribe: () => () => {},
      readBlob: async () => new Uint8Array(),
      releaseBlob: async () => {},
    } as unknown as HostBridge
    setHostBridge(bridge)

    expect(() => reportError("Memory", new Error("提取失败"))).not.toThrow()
    // 让被吞掉的 rejection 走完一个宏任务；若 .catch 被删，vitest 会以未处理拒绝判失败。
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(bridge.request).toHaveBeenCalledWith("report_frontend_error", expect.objectContaining({ message: "提取失败" }))
    expect(loggerMocks.error).toHaveBeenCalledTimes(1)
  })
})

describe("summarizeError 脱敏与截断", () => {
  it("API key / Bearer / password 等密钥形态先打码", () => {
    // 回归钉：sk- 规则曾无捕获组却用 "$1***" 替换，输出会带字面 "$1"。断言打码后的
    // 完整文本（同时钉住密钥移除、前缀保留与 $1 不泄漏），不只是「不含原文 + 有 ***」。
    expect(summarizeError(new Error("请求失败 sk-abcdefgh12345678 被拒"))).toBe("请求失败 sk-*** 被拒")
    expect(summarizeError("Authorization: Bearer abcdefgh12345678")).toBe("Authorization: Bearer ***")
    // sk- 规则先于通用键值规则命中，JSON 形态保留 sk- 前缀（打码结果仍不含密钥本体）。
    expect(summarizeError('{"apiKey":"sk-verysecret123456"}')).toBe('{"apiKey":"sk-***"}')
    expect(summarizeError("password=hunter2xyz")).toBe("password=***")
  })

  it("空白折叠、超长截断加省略号，普通文本原样保留", () => {
    expect(summarizeError("a\n\n b\t c")).toBe("a b c")
    expect(summarizeError(new Error("普通失败"))).toBe("普通失败")
    const long = summarizeError("x".repeat(300))
    expect(long).toHaveLength(121)
    expect(long.endsWith("…")).toBe(true)
    expect(summarizeError("x".repeat(300), 10)).toBe("xxxxxxxxxx…")
  })

  it("AppErrorPayload 取 message 再脱敏", () => {
    const summary = summarizeError({ code: "IO", message: "磁盘已满 sk-abcdefgh12345678" })
    expect(summary, "打码结果要干净：sk- 前缀保留、不留 $1 字面量").toBe("磁盘已满 sk-***")
  })
})
