import type { SceneDef } from "../../types"
import type { CardVariableDef } from "@/services/personality/types"
import { batchWriteVars, destroyPool, getPoolSnapshot, initVariablePool } from "@/services/personality/variable-pool"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密度", type: "number", initial: 0, description: "亲密度", updateBy: "llm", persistent: true, min: 0, max: 10, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "心情", updateBy: "llm", persistent: true, enum: ["平静", "开心"], reset: "never" },
]

/**
 * 变量写入的边界拒绝。
 *
 * 早先这条场景走真实模型、要求模型主动请求一个越界值（`亲密度: 999`）才成立 ——
 * 模型完全可能自己收敛到合法值或拒绝配合，于是场景的成败取决于模型的当天表现，
 * 而它真正要验证的（引擎拒绝越界）压根没被稳定测到。
 *
 * 现在直接调 `batchWriteVars`：拒绝逻辑是纯函数，不需要模型配合。
 * 「模型确实会发来 RUNTIME_DATA」由 vp-04 的 `variable-affection-praise` 覆盖。
 */
const scene: SceneDef = {
  meta: {
    caseId: "variable-boundary-reject",
    module: "variable-pool",
    contractId: "vp-06",
    description: "batchWriteVars 拒绝越界与类型不符的写入",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["variable-pool", "boundary", "error", "batch-write"],
  },
  turns: [{
    index: 1,
    description: "越界与类型不符的写入都被拒绝",
    userText: "尝试越界写入。",
    checks: [{ type: "expectVariablePool", run: async () => {
      destroyPool()
      initVariablePool({ cardId: "test-card", variableDefs: DEFS })
      // 先写一个合法值，确保下面的拒绝是「真的没写进去」而不是「本来就没值」
      if (batchWriteVars({ 亲密度: "5" }).written.length !== 1) throw new Error("前置的合法写入失败")

      // 越上界
      const over = batchWriteVars({ 亲密度: "999" })
      if (over.written.length !== 0) throw new Error("越上界的值被写入")
      if (!over.errors.some(e => e.includes("类型/范围不符"))) throw new Error(`拒绝原因不对: ${over.errors.join("; ")}`)

      // 越下界与负数
      for (const value of ["-1", "-999"]) {
        if (batchWriteVars({ 亲密度: value }).written.length !== 0) throw new Error(`负值 ${value} 被写入`)
      }

      // 非法枚举
      if (batchWriteVars({ 心情: "暴怒" }).written.length !== 0) throw new Error("枚举外的值被写入")
      // 非数字
      if (batchWriteVars({ 亲密度: "很多" }).written.length !== 0) throw new Error("非数字被写入")

      // 一次调用里合法与非法混在一起：合法的照写，非法的照拒
      const mixed = batchWriteVars({ 亲密度: "7", 心情: "暴怒" })
      if (mixed.written.length !== 1 || mixed.written[0] !== "亲密度") {
        throw new Error(`混合写入的取舍不对: ${JSON.stringify(mixed)}`)
      }

      // 被拒绝的那些不能留下痕迹：值仍是最后一次合法写入
      const pool = getPoolSnapshot()
      if (pool.card["亲密度"]?.value !== 7) throw new Error(`亲密度被改坏: ${pool.card["亲密度"]?.value}`)
      if (pool.card["心情"]?.value !== "平静") throw new Error(`心情被改坏: ${pool.card["心情"]?.value}`)
    } }],
  }],
}

export default scene
