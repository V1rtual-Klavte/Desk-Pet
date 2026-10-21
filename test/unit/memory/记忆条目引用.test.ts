// ==========================================
// 记忆条目引用 —— 记忆块身份 `id@version` 与写操作裸 id 的对齐
//
// 断言点：`id@version` 拆出裸 id 与版本；裸 id 保持无版本；非数字尾巴不误拆。
// 纯函数测试，不启动模型、不读写数据库。
// ==========================================

import { describe, expect, it } from "vitest"

import { parseMemoryItemRef } from "@/services/agent/memory/ref"

describe("记忆条目引用解析", () => {
  it("拆出记忆块里的 id@version [memory-ref-versioned]", () => {
    // 2026-10-21 实机：记忆块给模型看的是 `id@version`，模型原样回传后
    // 工具按裸 id 查不到条目，纠正必定失败。这里钉住拆解规则。
    expect(parseMemoryItemRef("mem-1792544417169-a-a14b040@1"))
      .toEqual({ id: "mem-1792544417169-a-a14b040", version: 1 })
    expect(parseMemoryItemRef("  mem-1-b@12  ")).toEqual({ id: "mem-1-b", version: 12 })
  })

  it("裸 id 不带版本，非数字尾巴原样保留 [memory-ref-plain]", () => {
    expect(parseMemoryItemRef("mem-1-b")).toEqual({ id: "mem-1-b" })
    // 邮箱一类含 @ 的字符串不能被误拆成条目 + 版本。
    expect(parseMemoryItemRef("user@example.com")).toEqual({ id: "user@example.com" })
    // 只有 @版本、没有 id 的形态不猜，按原值返回。
    expect(parseMemoryItemRef("@1")).toEqual({ id: "@1" })
  })
})
