// ==========================================
// Card 变量读取入口 —— getCardVarValue 与池代际失效信号
// ==========================================
//
// 池对象本身非响应式；界面侧（聊天气泡说话人标签读 Card「名字」变量，见 registry.activeCardName）
// 需要「写入后能重算」的读取点，由池代际（poolRevision）承担失效信号。
// 读入口的语义：未注册 / 未初始化 / destroy 后返回 undefined，回退策略归调用方。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computed } from "vue"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { batchWriteVars, destroyPool, getCardVarValue, initVariablePool } from "@/services/personality/variable-pool"
import type { CardVariableDef } from "@/services/personality/types"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "名字", type: "string", initial: "", description: "用户给角色起的名字", updateBy: "llm", reset: "never" },
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

describe("Card 变量读取入口", () => {
  it("读取当前值，并在写入 / 销毁后响应式失效 [variable-card-value-read]", () => {
    // 未初始化：没有任何变量可读
    expect(getCardVarValue("名字")).toBeUndefined()

    initVariablePool({ cardId: "read-probe", variableDefs: DEFS })
    expect(getCardVarValue("名字")).toBe("")
    // 未注册的名字不会被凭空读出来（是否回退由调用方决定）
    expect(getCardVarValue("未注册")).toBeUndefined()

    // 响应式失效：computed 挂在读取入口上（与 registry.activeCardName 同构）。
    // 没有池代际依赖的实现会一直缓存旧值，这里必须重算成新值。
    const observed = computed(() => getCardVarValue("名字"))
    expect(observed.value).toBe("")
    expect(batchWriteVars({ 名字: "小雪" }).written).toEqual(["名字"])
    expect(observed.value).toBe("小雪")
    expect(getCardVarValue("名字")).toBe("小雪")

    // destroy 后同样失效：读回 undefined
    destroyPool()
    expect(observed.value).toBeUndefined()
  })
})
