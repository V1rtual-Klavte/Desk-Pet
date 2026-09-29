// ==========================================
// RUNTIME_DATA 写入链路 —— 从 test/e2e/scenes/variable-pool/变量写入.scene.ts 迁到 L2
// ==========================================
//
// 覆盖 RUNTIME_DATA 的完整写入链路：解析 → 校验 → batchWriteVars → 落盘。
//
// 没有走模型：`generateReply(raw, card?)` 是纯后处理入口，喂一段带 RUNTIME_DATA
// 的回复文本就能确定性跑完整条链路。模型那一半由 vp-04 的
// `variable-affection-praise`（真实 LLM，仍在 L4）负责。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { generateReply } from "@/services/reply"
import type { CardVariableDef } from "@/services/personality/types"
import { destroyPool, getPoolSnapshot, initVariablePool } from "@/services/personality/variable-pool"

const CARD_ID = "e2e-runtime-data"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "枚举变量", updateBy: "llm", enum: ["平静", "开心"], reset: "never" },
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

describe("RUNTIME_DATA 写入链路", () => {
  it("RUNTIME_DATA 解析到变量池更新与落盘 [variable-runtime-data-write]", async () => {
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
    expect(result.text).not.toContain("RUNTIME_DATA")
    expect(result.text).toContain("谢谢你陪我聊天")

    // 合法变量写进池子
    const pool = getPoolSnapshot()
    expect(pool.card["亲密"]?.value).toBe(7)
    expect(pool.card["心情"]?.value).toBe("开心")
    expect(pool.card["亲密"]?.updatedBy).toBe("llm")

    // 无视 RUNTIME_DATA 里的一切越权请求：未注册的名字都必须被丢在门外
    expect("不存在的变量" in pool.card).toBe(false)
    expect("亲密越界" in pool.card).toBe(false)
    expect(pool.card["亲密"]?.value).toBe(7)
  })
})
