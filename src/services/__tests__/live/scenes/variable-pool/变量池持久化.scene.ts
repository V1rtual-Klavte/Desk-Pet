import type { SceneDef } from "../../types"
import type { CardVariableDef } from "@/services/personality/types"
import {
  batchWriteVars,
  destroyPool,
  getPoolSnapshot,
  initVariablePool,
  loadCardVars,
  savePoolToDiskStrict,
} from "@/services/personality/variable-pool"

/**
 * 用测试专属 cardId，避免踩到真实 Card 的 `stages/{id}.json`。
 * Live Test 的 data_root 本身就是一次性临时目录（`$HOME/.deskpet-live-test-*`），
 * 场景之间也不会互相看见这个文件。
 */
const CARD_ID = "live-test-vars"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", persistent: true, min: 0, max: 10, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "枚举变量", updateBy: "llm", persistent: true, enum: ["平静", "开心"], reset: "never" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", persistent: true, min: 0, max: 99, reset: "never" },
]

const unit = (caseId: string, contractId: string, description: string, run: () => Promise<void>): SceneDef => ({
  meta: {
    caseId,
    module: "variable-pool",
    contractId,
    description,
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["variable-pool", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description,
    userText: "检查变量池持久化。",
    checks: [{ type: "expectVariablePool", run: async () => run() }],
  }],
})

export const 变量池落盘 = unit("variable-pool-save", "vp-13", "savePoolToDisk 写入 stages/{cardId}.json", async () => {
  destroyPool()
  initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
  const written = batchWriteVars({ 亲密: "6", 心情: "开心" })
  if (written.written.length !== 2) throw new Error(`前置写入失败: ${written.errors.join("; ")}`)

  await savePoolToDiskStrict()

  // 直接读回磁盘：这是唯一能证明「真的落盘了」的方式，看内存池等于自证
  const loaded = await loadCardVars(CARD_ID)
  if (!loaded) throw new Error("落盘后读不到 stages 文件")
  if (loaded.card["亲密"]?.value !== 6) throw new Error(`亲密度未持久化: ${JSON.stringify(loaded.card["亲密"])}`)
  if (loaded.card["心情"]?.value !== "开心") throw new Error(`string 变量未持久化: ${JSON.stringify(loaded.card["心情"])}`)
  // interaction 变量与 card 变量分开存放，不能漏掉一边
  if (loaded.interaction["unansweredCount"]?.value !== 0) throw new Error("interaction 变量未持久化")
})

export const 变量池恢复 = unit("variable-pool-load", "vp-14", "loadCardVars 恢复持久化变量", async () => {
  destroyPool()
  initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
  batchWriteVars({ 亲密: "4" })
  await savePoolToDiskStrict()

  // 模拟重启：完全销毁运行时状态，再从磁盘重建。
  // destroy 之后立刻确认内存态真的空了 —— 放到 initVariablePool 之后再查就查不出来了。
  destroyPool()
  if (Object.keys(getPoolSnapshot().card).length !== 0) throw new Error("destroyPool 未清空内存池")

  const loaded = await loadCardVars(CARD_ID)
  if (!loaded) throw new Error("读不到已持久化的 stages 文件")
  const restored = initVariablePool({
    cardId: CARD_ID,
    variableDefs: DEFS,
    prevCardStates: loaded.card,
    prevInteractionStates: loaded.interaction,
  })
  if (restored.card["亲密"]?.value !== 4) throw new Error(`恢复后值不对: ${restored.card["亲密"]?.value}`)

  // 不存在的 cardId 必须返回 null，而不是抛错 —— 首次启动就是这条路径
  if (await loadCardVars("live-test-never-written") !== null) {
    throw new Error("不存在的 cardId 应返回 null")
  }
})
