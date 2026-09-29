// ==========================================
// 变量写入边界拒绝 —— 从 test/e2e/scenes/variable-pool/越界拒绝.scene.ts 迁到 L2
// ==========================================
//
// 早先这条场景走真实模型、要求模型主动请求一个越界值（`亲密度: 999`）才成立 ——
// 模型完全可能自己收敛到合法值或拒绝配合，于是场景的成败取决于模型的当天表现，
// 而它真正要验证的（引擎拒绝越界）压根没被稳定测到。
//
// 现在直接调 `batchWriteVars`：拒绝逻辑是纯函数，不需要模型配合。
// 「模型发来的 RUNTIME_DATA 经完整 loop 会被原样写对」由 vp-04 的
// `variable-affection-praise` 覆盖，见 `test/integration/variable-pool/亲密度提升.test.ts`。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import type { CardVariableDef } from "@/services/personality/types"
import { batchWriteVars, destroyPool, getPoolSnapshot, initVariablePool } from "@/services/personality/variable-pool"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密度", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "心情", updateBy: "llm", enum: ["平静", "开心"], reset: "never" },
]

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-variable-pool-"))
  setTestDataRoot(root)
  destroyPool()
})

afterEach(() => {
  destroyPool()
  rmSync(root, { recursive: true, force: true })
})

describe("变量写入边界拒绝", () => {
  it("batchWriteVars 拒绝越界与类型不符的写入 [variable-boundary-reject]", () => {
    destroyPool()
    initVariablePool({ cardId: "test-card", variableDefs: DEFS })
    // 先写一个合法值，确保下面的拒绝是「真的没写进去」而不是「本来就没值」
    expect(batchWriteVars({ 亲密度: "5" }).written).toEqual(["亲密度"])

    // 越上界
    const over = batchWriteVars({ 亲密度: "999" })
    expect(over.written).toEqual([])
    expect(over.errors.join("; ")).toContain("类型/范围不符")

    // 越下界与负数
    for (const value of ["-1", "-999"]) {
      expect(batchWriteVars({ 亲密度: value }).written, `负值 ${value} 被写入`).toEqual([])
    }

    // 非法枚举
    expect(batchWriteVars({ 心情: "暴怒" }).written).toEqual([])
    // 非数字
    expect(batchWriteVars({ 亲密度: "很多" }).written).toEqual([])

    // 一次调用里合法与非法混在一起：合法的照写，非法的照拒
    expect(batchWriteVars({ 亲密度: "7", 心情: "暴怒" }).written).toEqual(["亲密度"])

    // 被拒绝的那些不能留下痕迹：值仍是最后一次合法写入
    const pool = getPoolSnapshot()
    expect(pool.card["亲密度"]?.value).toBe(7)
    expect(pool.card["心情"]?.value).toBe("平静")
  })
})
