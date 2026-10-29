import { describe, expect, it } from "vitest"
import { parseRuntimeData } from "@/services/reply/generator"

describe("RUNTIME_DATA evidence projection", () => {
  it("can remove protocol data without normalizing generated whitespace [reply-runtime-data-evidence-whitespace]", () => {
    const raw = "  reply\r\n<RUNTIME_DATA>\r\nstate: set\r\n</RUNTIME_DATA>\r\n  "
    expect(parseRuntimeData(raw).text).toBe("reply")
    expect(parseRuntimeData(raw, { preserveWhitespace: true }).text).toBe("  reply\r\n\r\n  ")
  })
})
