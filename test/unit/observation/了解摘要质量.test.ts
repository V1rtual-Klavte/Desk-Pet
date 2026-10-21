// ==========================================
// 了解摘要质量 —— 纯否定结论不算了解
//
// 断言点：截图窄条、目录里没有项目文件这类摘要不进入了解层、不贡献覆盖率；
// 真正关于用户的摘要照常通过。纯函数测试，不读写数据库。
// ==========================================

import { describe, expect, it } from "vitest"

import { isInformativeSummary } from "@/services/observation/quality"

describe("了解摘要质量", () => {
  it("纯否定结论不算了解 [observation-summary-noise]", () => {
    // 2026-10-21 实机：这两条把了解层顶到 ready，还沉淀成了长期记忆。
    expect(isInformativeSummary("截图为 1280×27 的窄条，无有效内容可观察")).toBe(false)
    expect(isInformativeSummary("/Users/Shared 仅含缓存残留目录，无项目文件")).toBe(false)
    expect(isInformativeSummary("无法读取")).toBe(false)
    // 空摘要不算了解。
    expect(isInformativeSummary("   ")).toBe(false)
  })

  it("关于用户的摘要照常通过 [observation-summary-informative]", () => {
    expect(isInformativeSummary("常用工具：IntelliJ IDEA、VS Code、Navicat")).toBe(true)
    expect(isInformativeSummary("主目录含 WEB 与 logs，以 Java 后端开发为主")).toBe(true)
    // 短摘要只要有内容就照常通过（判定只挡「什么都没看到」，不按字数卡）。
    expect(isInformativeSummary("目录摘要")).toBe(true)
  })
})
