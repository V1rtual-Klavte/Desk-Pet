import { describe, expect, it } from "vitest"

import { NO_ADDRESS_WARN_KEYS, shouldWarnNoAddress } from "@/services/context/tool-output"

describe("无回读地址诊断去重上限", () => {
  it("容量满时按 FIFO 淘汰最早键，淘汰键可重新留痕且最近键仍去重", () => {
    const oldest = "fifo-cap-probe-oldest"
    expect(shouldWarnNoAddress(oldest)).toBe(true)

    for (let index = 0; index < NO_ADDRESS_WARN_KEYS; index++) {
      expect(shouldWarnNoAddress(`fifo-cap-probe-${index}`)).toBe(true)
    }

    // 上面写入 64 个新键后，最早键必须已被淘汰；否则集合会超过上限或没有 FIFO 淘汰。
    expect(shouldWarnNoAddress(oldest)).toBe(true)
    expect(shouldWarnNoAddress(oldest)).toBe(false)
    expect(shouldWarnNoAddress(`fifo-cap-probe-${NO_ADDRESS_WARN_KEYS - 1}`)).toBe(false)
  })
})
