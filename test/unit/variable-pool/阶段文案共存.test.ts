// ==========================================
// 阶段文案与变量区共存 —— 从 test/e2e/scenes/variable-pool/阶段文案共存.scene.ts 迁到 L2
// ==========================================
//
// VAR-01 的防回归断言：`stages/{cardId}.json` 里的两段各有唯一生产者 ——
// stages 段由 stages-cache 写、variables 段由 variable-pool 写，两条路径都经
// stages-file 的「读 → 段级合并 → 写」。
//
// 改动前三个写入者各自整文件覆写，变量区会被阶段文案写入整体抹掉，而现场只有
// 用户下次激活 Card 时才可见（变量回退到 initial）。写入次序刻意排成
// 「变量 → 阶段文案 → 变量」：任何一步覆写掉另一段都会红。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
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

const CARD_ID = "e2e-stages-coexist"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "每日", type: "number", initial: 1, description: "每日重置", updateBy: "llm", min: 0, max: 100, reset: "daily" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", min: 0, max: 99, reset: "never" },
]

/** 会话键 = SessionMeta.createdAt（毫秒）；本用例只关心它是否随变量区一起被保留 */
const SESSION_KEY = 1758000123000

/** 阶段文案段的探针值：它必须与变量区共存于同一文件 */
const STAGE_SOURCE_HASH = "e2e-stage-hash"

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

describe("阶段文案与变量区共存", () => {
  it("阶段文案写入与变量区共存于同一文件、互不抹除 [variable-pool-stages-coexist]", async () => {
    destroyPool()
    initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
    expect(batchWriteVars({ 亲密: "6" }).written).toEqual(["亲密"])
    // 重置游标也是 variables 段的一部分：一起写进去才能证明整段被保留
    applyResetPolicies(new Date(2099, 0, 2), SESSION_KEY)
    await savePoolToDiskStrict()

    // ① 变量区的落点就是 stages 段所在的那份文件
    const first = await readStagesFile(CARD_ID)
    const vars = first?.variables
    expect(vars).toBeDefined()
    expect(vars?.schemaVersion).toBe(STAGES_FILE_SCHEMA_VERSION)
    expect(vars?.card["亲密"]?.value).toBe(6)
    expect(vars?.lastDailyResetKey).toBe("2099-01-02")
    expect(vars?.sessionKey).toBe(SESSION_KEY)

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
    expect(second?.stages?.sourceHash).toBe(STAGE_SOURCE_HASH)
    const afterStages = second?.variables
    expect(afterStages?.card["亲密"]?.value).toBe(6)
    expect(afterStages?.interaction["unansweredCount"]?.value).toBe(0)
    expect(afterStages?.lastDailyResetKey).toBe("2099-01-02")
    expect(afterStages?.sessionKey).toBe(SESSION_KEY)

    // ③ 反向：变量池再写一次，stages 段必须原样保留
    expect(batchWriteVars({ 亲密: "7" }).written).toEqual(["亲密"])
    await savePoolToDiskStrict()
    const finalFile = await readStagesFile(CARD_ID)
    expect(finalFile?.stages?.sourceHash).toBe(STAGE_SOURCE_HASH)
    expect(finalFile?.variables?.card["亲密"]?.value).toBe(7)

    // 读侧与文件同源：loadCardVars 必须看到保留下来的变量与游标
    const loaded = await loadCardVars(CARD_ID)
    expect(loaded?.card["亲密"]?.value).toBe(7)
    expect(loaded?.lastDailyResetKey).toBe("2099-01-02")
  })
})
