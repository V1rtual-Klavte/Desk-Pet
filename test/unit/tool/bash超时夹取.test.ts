// ==========================================
// bash 超时夹取 —— 生效值 = min(模型请求值 ?? 默认, 上限)，默认 = 上限 = 300 秒
// ==========================================
//
// 归属 L2 的理由：被测的 `clampBashTimeoutArguments` 在零依赖叶子
// `tool/local/bash-timeout.ts` 里（自身无 import），纯函数；不 import 工具 barrel，
// 也不加载任何宿主桥。
//
// 为什么这组断言必要：模型不传 `timeout` 时，旧链路把 null 原样下传 Rust，Rust 吃
// 自己的 120s 兜底（`DEFAULT_BASH_TIMEOUT_MS`），5 分钟档名存实亡（2026-10-06 排查，
// 见 .superpowers/sdd/turn-gov/timeout-research.md）。这里钉住四件事 —— 缺省补默认、
// 越界夹上限、合法下调原样保留、非法值不静默替换（交 pi 的校验如实拒绝）。
// 改坏任一条（去掉缺省注入 / 上限失效 / 把非法值吞成默认）都会红。
import { describe, expect, it } from "vitest"
import { BASH_TOOL_TIMEOUT_SECONDS, clampBashTimeoutArguments } from "@/services/tool/local/bash-timeout"

describe("bash 超时夹取", () => {
  it("缺省补默认值、越界夹上限、合法下调原样保留 [tool-bash-timeout-clamp]", () => {
    // 档位值是跨层对齐的锚：TS 侧与 Rust `DEFAULT_BASH_TIMEOUT_MS` 必须同值（Rust 侧由
    // `default_bash_timeout_matches_tool_band` 钉同一字面值）。
    expect(BASH_TOOL_TIMEOUT_SECONDS).toBe(300)

    // 缺省（undefined / null）：补上默认值 —— Rust 收到显式生效值，不依赖自己的兜底。
    expect(clampBashTimeoutArguments({ command: "sleep 1" }).timeout).toBe(300)
    expect(clampBashTimeoutArguments({ command: "sleep 1", timeout: null }).timeout).toBe(300)

    // 合法下调原样保留：整秒、小数、数字字符串（按 pi 的数值归一，字符串不会绕过上限）。
    expect(clampBashTimeoutArguments({ timeout: 60 }).timeout).toBe(60)
    expect(clampBashTimeoutArguments({ timeout: 0.5 }).timeout).toBe(0.5)
    expect(clampBashTimeoutArguments({ timeout: "120" }).timeout).toBe(120)

    // 越界按上限执行（不是拒绝，也不是静默放大）。
    expect(clampBashTimeoutArguments({ timeout: 300 }).timeout).toBe(300)
    expect(clampBashTimeoutArguments({ timeout: 600 }).timeout).toBe(300)
    expect(clampBashTimeoutArguments({ timeout: "9999" }).timeout).toBe(300)

    // 只碰 timeout 一个字段，其余参数原样透传。
    expect(clampBashTimeoutArguments({ command: "ls", cwd: "/tmp" }))
      .toEqual({ command: "ls", cwd: "/tmp", timeout: 300 })
  })

  it("非法值原样留给 pi 的校验拒绝，不静默替换成默认 [tool-bash-timeout-invalid]", () => {
    // 0 / 负数 / 非数字字符串都不是「没传」：替换成默认会吞掉模型的参数错误，
    // 让「模型传了个坏值」变成「按默认静默执行」。
    expect(clampBashTimeoutArguments({ timeout: 0 }).timeout).toBe(0)
    expect(clampBashTimeoutArguments({ timeout: -5 }).timeout).toBe(-5)
    expect(clampBashTimeoutArguments({ timeout: "abc" }).timeout).toBe("abc")

    // 非对象入参不 panic（pi 后面会用 schema 校验拒绝这个调用）。
    expect(clampBashTimeoutArguments(undefined).timeout).toBe(300)
    expect(clampBashTimeoutArguments(null).timeout).toBe(300)
  })
})
