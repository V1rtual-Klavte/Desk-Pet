import { describe, expect, it } from "vitest"

import { errorCode } from "@/services/error"
import { HostCommandError } from "@/services/host"

describe("errorCode", () => {
  it("保留 HostBridge 远端错误码供领域归宿判断 [host-command-error-code]", () => {
    expect(errorCode(new HostCommandError("PATH_NOT_FOUND", "missing"))).toBe("PATH_NOT_FOUND")
    expect(errorCode(new Error("ordinary error"))).toBeNull()
  })
})
