import type { SceneDef } from "../../types"
import type { CardVariableDef } from "@/services/personality/types"
import { generateReply } from "@/services/reply"
import {
  destroyPool,
  getPoolSnapshot,
  initVariablePool,
} from "@/services/personality/variable-pool"

const CARD_ID = "live-test-runtime-data"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "枚举变量", updateBy: "llm", enum: ["平静", "开心"], reset: "never" },
]

/**
 * 覆盖 RUNTIME_DATA 的完整写入链路：解析 → 校验 → batchWriteVars → 落盘。
 *
 * 没有走模型：`generateReply(raw, card?)` 是纯后处理入口，喂一段带 RUNTIME_DATA
 * 的回复文本就能确定性跑完整条链路。模型那一半由 vp-04 的
 * `variable-affection-praise`（真实 LLM）负责。
 */
const scene: SceneDef = {
  meta: {
    caseId: "variable-runtime-data-write",
    module: "variable-pool",
    contractId: "vp-08",
    description: "RUNTIME_DATA 解析到变量池更新与落盘",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["variable-pool", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "带 RUNTIME_DATA 的回复走完解析与写入",
    userText: "检查 RUNTIME_DATA 写入。",
    checks: [{ type: "expectVariablePool", run: async () => {
      destroyPool()
      initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })

      const raw = [
        "谢谢你陪我聊天。",
        "<RUNTIME_DATA>",
        "亲密: 7",
        "心情: 开心",
        "不存在的变量: 123",
        "亲密越界: 999",
        "</RUNTIME_DATA>",
      ].join("\n")

      const result = await generateReply(raw, null)

      // RUNTIME_DATA 是内部元数据，绝不能出现在给用户看的文本里
      if (result.text.includes("RUNTIME_DATA")) throw new Error("元数据块没有被剥离")
      if (!result.text.includes("谢谢你陪我聊天")) throw new Error("正文被误删")

      // 合法变量写进池子
      const pool = getPoolSnapshot()
      if (pool.card["亲密"]?.value !== 7) throw new Error(`合法变量未写入: ${pool.card["亲密"]?.value}`)
      if (pool.card["心情"]?.value !== "开心") throw new Error(`string 变量未写入: ${pool.card["心情"]?.value}`)
      if (pool.card["亲密"]?.updatedBy !== "llm") throw new Error("写入来源不是 llm")

      // 无视 RUNTIME_DATA 里的一切越权请求：未注册、越界都必须被丢在门外
      if ("不存在的变量" in pool.card) throw new Error("未注册变量被写入")
      if (pool.card["亲密"]?.value !== 7) throw new Error("越界值覆盖了合法值")
    } }],
  }],
}

export default scene
