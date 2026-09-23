import type { SceneDef } from "../../types"
import type { CardVariableDef } from "@/services/personality/types"
import {
  applyResetPolicies,
  batchWriteVars,
  destroyPool,
  initVariablePool,
  loadCardVars,
  savePoolToDiskStrict,
} from "@/services/personality/variable-pool"
import { readStagesFile, updateStagesFile, STAGES_FILE_SCHEMA_VERSION } from "@/services/personality/stages-file"
import { FALLBACK_STAGES } from "@/services/personality/stages-cache"

/**
 * VAR-01 的防回归断言：`stages/{cardId}.json` 里的两段各有唯一生产者 ——
 * stages 段由 stages-cache 写、variables 段由 variable-pool 写，两条路径都经
 * stages-file 的「读 → 段级合并 → 写」。
 *
 * 改动前三个写入者各自整文件覆写，变量区会被阶段文案写入整体抹掉，而现场只有
 * 用户下次激活 Card 时才可见（变量回退到 initial）。写入次序刻意排成
 * 「变量 → 阶段文案 → 变量」：任何一步覆写掉另一段都会红。
 */
const CARD_ID = "live-test-stages-coexist"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "每日", type: "number", initial: 1, description: "每日重置", updateBy: "llm", min: 0, max: 100, reset: "daily" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", min: 0, max: 99, reset: "never" },
]

/** 会话键 = SessionMeta.createdAt（毫秒）；本场景只关心它是否随变量区一起被保留 */
const SESSION_KEY = 1758000123000

/** 阶段文案段的探针值：它必须与变量区共存于同一文件 */
const STAGE_SOURCE_HASH = "live-test-stage-hash"

const scene: SceneDef = {
  meta: {
    caseId: "variable-pool-stages-coexist",
    module: "variable-pool",
    contractId: "vp-19",
    description: "阶段文案写入与变量区共存于同一文件、互不抹除",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["variable-pool", "boundary", "stages-file"],
  },
  turns: [{
    index: 1,
    description: "变量 → 阶段文案 → 变量 三次写入都不丢另一段",
    userText: "检查阶段文案与变量区共存。",
    checks: [{ type: "expectStagesVariablesCoexist", run: async () => {
      destroyPool()
      initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
      const wrote = batchWriteVars({ 亲密: "6" })
      if (wrote.written.length !== 1) throw new Error(`前置写入失败: ${wrote.errors.join("; ")}`)
      // 重置游标也是 variables 段的一部分：一起写进去才能证明整段被保留
      applyResetPolicies(new Date(2099, 0, 2), SESSION_KEY)
      await savePoolToDiskStrict()

      // ① 变量区的落点就是 stages 段所在的那份文件
      const first = await readStagesFile(CARD_ID)
      const vars = first?.variables
      if (!vars) throw new Error("变量区没有写进 stages 文件")
      if (vars.schemaVersion !== STAGES_FILE_SCHEMA_VERSION) {
        throw new Error(`变量区 schemaVersion 不对: ${vars.schemaVersion}`)
      }
      if (vars.card["亲密"]?.value !== 6) throw new Error(`变量值未落盘: ${JSON.stringify(vars.card["亲密"])}`)
      if (vars.lastDailyResetKey !== "2099-01-02" || vars.sessionKey !== SESSION_KEY) {
        throw new Error(`重置游标未落盘: ${JSON.stringify({ daily: vars.lastDailyResetKey, session: vars.sessionKey })}`)
      }

      // ② 阶段文案写入（stages-cache 的路径）不得动到变量区
      await updateStagesFile(CARD_ID, {
        stages: {
          cardId: CARD_ID,
          cardVersion: 1,
          sourceHash: STAGE_SOURCE_HASH,
          generatedAt: Date.now(),
          isFallback: false,
          stages: FALLBACK_STAGES,
        },
      })
      const second = await readStagesFile(CARD_ID)
      if (second?.stages?.sourceHash !== STAGE_SOURCE_HASH) throw new Error("stages 段未写入")
      const afterStages = second.variables
      if (afterStages?.card["亲密"]?.value !== 6) {
        throw new Error(`阶段文案写入抹掉了变量值: ${JSON.stringify(afterStages?.card["亲密"])}`)
      }
      if (afterStages?.interaction["unansweredCount"]?.value !== 0) {
        throw new Error("阶段文案写入抹掉了 interaction 变量")
      }
      if (afterStages?.lastDailyResetKey !== "2099-01-02" || afterStages?.sessionKey !== SESSION_KEY) {
        throw new Error("阶段文案写入抹掉了重置游标")
      }

      // ③ 反向：变量池再写一次，stages 段必须原样保留
      const again = batchWriteVars({ 亲密: "7" })
      if (again.written.length !== 1) throw new Error(`第二次写入失败: ${again.errors.join("; ")}`)
      await savePoolToDiskStrict()
      const finalFile = await readStagesFile(CARD_ID)
      if (finalFile?.stages?.sourceHash !== STAGE_SOURCE_HASH) {
        throw new Error("变量池写入抹掉了 stages 段")
      }
      if (finalFile.variables?.card["亲密"]?.value !== 7) {
        throw new Error(`第二次变量写入未落盘: ${JSON.stringify(finalFile.variables?.card["亲密"])}`)
      }

      // 读侧与文件同源：loadCardVars 必须看到保留下来的变量与游标
      const loaded = await loadCardVars(CARD_ID)
      if (loaded?.card["亲密"]?.value !== 7 || loaded.lastDailyResetKey !== "2099-01-02") {
        throw new Error(`loadCardVars 未按变量区恢复: ${JSON.stringify(loaded)}`)
      }
    } }],
  }],
}

export default scene
