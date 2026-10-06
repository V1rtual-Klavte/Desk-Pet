// ==========================================
// 后台命令完成通知 —— 载荷校验与中性文案（L2，零依赖叶子直测）
// ==========================================
//
// 后台化批次（2026-10-06 用户裁决）：前台 bash 超时不再杀进程、转后台继续跑；
// 结束（自行退出或到点回收）时宿主投 `bash-background-finished`，消费端把结果写
// 聊天系统消息。本文件钉叶子里的两件事：
// ① `parseBackgroundFinishedPayload` 结构不符即拒绝（不猜字段、不给兜底值）；
// ② `formatBackgroundFinishedNotice` 如实分类（完成 / 非零退出 / 到点被终止）、
//    静默证据只在达阈值时出现，输出溢出只回显末尾且带全量文件取回地址。
//
// 归属 L2：被测叶子零 import，纯确定性逻辑；订阅与投递（带 HostBridge）在
// `tool/background.ts`，不在本文件的断言面内。
import { describe, expect, it } from "vitest"
import {
  formatBackgroundFinishedNotice,
  parseBackgroundFinishedPayload,
} from "@/services/tool/background-notice"
import type { BashBackgroundFinishedPayload } from "@/services/tool/background-notice"

function payload(overrides: Partial<BashBackgroundFinishedPayload> = {}): BashBackgroundFinishedPayload {
  return {
    executionId: "exec-1",
    sessionId: "session-1",
    commandPreview: "npm run build",
    exitCode: 0,
    durationMs: 12_300,
    reason: "exited",
    silentMs: 400,
    producedBytes: 42,
    outputTail: "build ok",
    spillPath: null,
    ...overrides,
  }
}

describe("后台命令完成通知", () => {
  it("已完成：带退出码、时长、命令与输出尾部 [tool-bg-notice-format]", () => {
    const text = formatBackgroundFinishedNotice(payload())
    expect(text).toContain("已完成")
    expect(text).toContain("退出码 0")
    expect(text).toContain("12.3s")
    expect(text).toContain("npm run build")
    expect(text).toContain("build ok")
    expect(text).not.toContain("被终止")
  })

  it("非零退出如实标注；静默证据只在 ≥60s 时写进通知 [tool-bg-notice-exit-and-silence]", () => {
    const brief = formatBackgroundFinishedNotice(payload({ exitCode: 2, silentMs: 500 }))
    expect(brief).toContain("退出码 2")
    // 0.5s 的「静默」不是异常，不该出现在通知里（否则每条通知都带噪声）。
    expect(brief).not.toContain("无输出")

    const longSilence = formatBackgroundFinishedNotice(payload({ exitCode: 0, silentMs: 292_000 }))
    expect(longSilence).toContain("4m52s 无输出")
  })

  it("到点回收：明确说被终止与原因，不写成完成 [tool-bg-notice-cap]", () => {
    const text = formatBackgroundFinishedNotice(payload({ reason: "capReached", exitCode: null, durationMs: 1_800_000 }))
    expect(text).toContain("超过时限已被终止")
    expect(text).toContain("30 分钟")
    expect(text).not.toContain("已完成")
  })

  it("输出溢出：只回显末尾片段并给出完整输出的取回地址 [tool-bg-notice-tail-and-spill]", () => {
    const longTail = "x".repeat(5000) + "END-MARK"
    const text = formatBackgroundFinishedNotice(payload({ outputTail: longTail, producedBytes: 5_000_000, spillPath: "/tmp/spill.out" }))
    expect(text, "末尾片段必须保留（中间截断）").toContain("END-MARK")
    expect(text, "总产出口径必须如实").toContain("4.8MB")
    expect(text, "完整输出的取回地址必须给出").toContain("/tmp/spill.out")
    expect(text.length, "不是整段倾倒输出").toBeLessThan(2500)
  })

  it("结构校验：缺字段/类型不符/未知原因一律拒绝，不给兜底值 [tool-bg-notice-parse]", () => {
    expect(parseBackgroundFinishedPayload(payload()), "合法载荷被拒").not.toBeNull()
    expect(parseBackgroundFinishedPayload({ ...payload(), sessionId: undefined }), "缺字段被静默补默认").toBeNull()
    expect(parseBackgroundFinishedPayload({ ...payload(), reason: "whatever" }), "未知结束原因被放行").toBeNull()
    expect(parseBackgroundFinishedPayload({ ...payload(), exitCode: "0" }), "退出码类型不符被放行").toBeNull()
    expect(parseBackgroundFinishedPayload({ ...payload(), outputTail: undefined }), "缺输出尾部被放行").toBeNull()
    expect(parseBackgroundFinishedPayload(null), "非对象载荷被放行").toBeNull()
    // 「缺省 = 该状态」的可选字段允许 null（会话归属 / 退出码 / spill 路径）。
    expect(parseBackgroundFinishedPayload({
      ...payload(), sessionId: null, exitCode: null, spillPath: "/x",
    }), "该状态的 null 被误拒").not.toBeNull()
  })
})
