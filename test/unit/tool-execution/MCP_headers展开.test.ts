// ==========================================
// MCP headers 展开（expandHeaders）—— 变量来源边界（L2）
// ==========================================
//
// 归属 L2 的依据：`tool/mcp/http-headers.ts` 是零依赖叶子（不 import host/logger/config），
// 被测的是纯粹的「模板 + env → 实际请求头」边界：
//   · 值里的 `${VAR}` 只从该服务器自己的 env 展开 —— process.env 里即使有同名变量，
//     也必须拒绝（凭据来源留在配置本身，排障时才知道值从哪来）；
//   · 缺失与空值都抛错并点名变量；无模板返回 undefined；不含变量的值原样保留。

import { afterEach, describe, expect, it, vi } from "vitest"

import { expandHeaders } from "@/services/tool/mcp/http-headers"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("expandHeaders", () => {
  it("无模板返回 undefined（不生成空对象）；无变量的值原样保留", () => {
    expect(expandHeaders(undefined, { TOKEN: "abc" })).toBeUndefined()
    expect(expandHeaders({}, { TOKEN: "abc" })).toEqual({})
    expect(expandHeaders({ "X-Static": "plain" }, undefined)).toEqual({ "X-Static": "plain" })
  })

  it("从该服务器 env 展开 ${VAR}：支持前后缀与一个值里多个变量", () => {
    const headers = expandHeaders(
      { Authorization: "Bearer ${TOKEN}", "X-Both": "${A}-${B}" },
      { TOKEN: "abc", A: "1", B: "2" },
    )
    expect(headers).toEqual({ Authorization: "Bearer abc", "X-Both": "1-2" })
  })

  it("缺失或空值即抛错并点名变量（值不参与文案）", () => {
    expect(() => expandHeaders({ Authorization: "Bearer ${TOKEN}" }, {})).toThrow(/TOKEN/)
    expect(() => expandHeaders({ Authorization: "Bearer ${TOKEN}" }, undefined)).toThrow(/TOKEN/)
    expect(() => expandHeaders({ Authorization: "Bearer ${TOKEN}" }, { TOKEN: "" })).toThrow(/TOKEN/)
    // 一个值里多个变量：只报出真正缺失的那个。
    expect(() => expandHeaders({ "X-Both": "${A}-${B}" }, { A: "1" })).toThrow(/变量 B/)
  })

  it("不做 process.env 回落：进程环境有同名变量也不放行", () => {
    vi.stubEnv("DESKPET_MCP_HEADER_PROBE", "from-process")
    expect(
      () => expandHeaders({ "X-Probe": "${DESKPET_MCP_HEADER_PROBE}" }, {}),
    ).toThrow(/DESKPET_MCP_HEADER_PROBE/)
  })
})
