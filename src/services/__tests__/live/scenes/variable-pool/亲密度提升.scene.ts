// ==========================================
// Live Test Scene: RUNTIME_DATA 变量写入 → 变量池
// ==========================================
import type { AssertContext, SceneDef } from "../../types"
import { getActiveCard, listPersonalities, switchPersonality } from "@/services/personality/registry"

/** 本场景断言的变量名 */
const AFFECTION = "亲密度"
const MOOD = "心情"

/**
 * 本次 trial 里模型实际请求过写入的次数，在 `setup` 里清零（setup 每个 trial 跑一次）。
 *
 * 这条场景验证的是「模型发出 RUNTIME_DATA → 引擎解析并写对」这条链路。
 * 实测模型并不会自发地每轮都写：同一个进程里三轮下来可能一次都不写。
 * 所以断言拆成两层 ——
 *   逐轮：**如果**它写了，值必须与请求一致、updatedBy 必须是 llm；
 *   收尾：整场至少写过一次，否则这条场景什么也没验证到（不能变成永远通过的空壳）。
 * 为了让「至少一次」可靠，提示词显式要求走 RUNTIME_DATA —— 被测的是链路通不通，
 * 不是模型自不自觉。
 */
let requestedWrites = 0

/**
 * RUNTIME_DATA 里的字符串值保留引号（`心情: "开心"`），而 `batchWriteVars`
 * 的 `coerceValue` 会把成对引号剥掉再落池。比较时必须先对齐这一步，
 * 否则两边打印出来一模一样却判不相等。
 */
function normalize(requested: string): string {
  const trimmed = requested.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return quoted ? quoted[2] : trimmed
}

/** 模型请求了就校验写回一致性；没请求就放过，只登记计数 */
function verifyRequestedWrite(ctx: AssertContext, name: string, type: "number" | "string"): void {
  const state = ctx.pool.card[name]
  if (!state) throw new Error(`${name} 变量不存在`)
  if (typeof state.value !== type) throw new Error(`${name} 类型应为 ${type}，实际 ${typeof state.value}`)

  const requested = ctx.output.runtimeData?.variables[name]
  if (requested === undefined) return

  requestedWrites++
  if (type === "number") {
    const expected = Number(normalize(requested))
    if (Number.isNaN(expected)) throw new Error(`RUNTIME_DATA 的 ${name} 不是数字: ${requested}`)
    if (state.value !== expected) throw new Error(`${name}=${state.value} 与 RUNTIME_DATA 请求值 ${requested} 不一致`)
  } else {
    const expected = normalize(requested)
    if (state.value !== expected) throw new Error(`${name}="${state.value}" 与 RUNTIME_DATA 请求值 ${requested} 不一致`)
  }
  if (state.updatedBy !== "llm") throw new Error(`${name} updatedBy=${state.updatedBy}，应为 llm`)
}

const expectReply = {
  type: "expectReply",
  run: async (ctx: AssertContext) => {
    if (!ctx.output.reply?.length) throw new Error("reply 为空")
  },
}

export const 亲密度提升: SceneDef = {
  meta: {
    caseId: "variable-affection-praise",
    module: "variable-pool", contractId: "vp-04",
    description: "模型按提示发出 RUNTIME_DATA → 引擎按 def 写入变量池",
    depth: "deep", suite: "capability", repetitions: 3, tags: ["variable-pool", "card", "runtime-data"],
  },
  setup: async () => {
    requestedWrites = 0

    // 变量名来自 Card 定义，而激活的 Card 取决于当前用的是哪份配置
    // （CONFIG-DEV.yaml → yuki 只有「信任度」，CONFIG.yaml → angelkawaii 才有「亲密度」）。
    // 场景断言的是这条写入链路，换个环境就红没有意义 —— 按需切到定义了该变量的 Card。
    if (getActiveCard()?.sections.variableDefs.some(d => d.name === AFFECTION)) return

    const target = listPersonalities().find(c => c.sections.variableDefs.some(d => d.name === AFFECTION))
    if (!target) throw new Error(`没有任何 Card 定义 ${AFFECTION}，场景无法执行`)
    const result = await switchPersonality(target.id)
    if (!result.ok) throw new Error(`切换到 ${target.id} 失败: ${result.error}`)
  },
  turns: [
    {
      index: 1, description: "写一次数字变量",
      userText: "请在回复末尾用 RUNTIME_DATA 区块把亲密度设为 3。",
      checks: [
        expectReply,
        { type: "expectVar_亲密度_after_praise", run: async (ctx: AssertContext) => verifyRequestedWrite(ctx, AFFECTION, "number") },
      ],
    },
    {
      index: 2, description: "改写同一个变量",
      userText: "再用 RUNTIME_DATA 把亲密度改成 5。",
      checks: [
        expectReply,
        { type: "expectVar_亲密度_continue", run: async (ctx: AssertContext) => verifyRequestedWrite(ctx, AFFECTION, "number") },
      ],
    },
    {
      index: 3, description: "写一次字符串变量",
      userText: "再用 RUNTIME_DATA 把心情设为 开心。",
      checks: [
        expectReply,
        { type: "expectVar_心情_change", run: async (ctx: AssertContext) => verifyRequestedWrite(ctx, MOOD, "string") },
        { type: "expectAnyWriteHappened", run: async () => {
          if (requestedWrites === 0) throw new Error("整场没有任何 RUNTIME_DATA 变量写入请求，链路未被验证")
        } },
      ],
    },
  ],
}
export default 亲密度提升
