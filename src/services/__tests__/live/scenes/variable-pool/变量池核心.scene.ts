import type { SceneDef } from "../../types"
import type { CardVariableDef } from "@/services/personality/types"
import {
  batchWriteVars,
  computeSystemVariables,
  destroyPool,
  formatPoolForPrompt,
  getPoolSnapshot,
  getVariableRegistry,
  initVariablePool,
  refreshVariablePool,
  restoreVariablePoolState,
  snapshotVariablePoolState,
} from "@/services/personality/variable-pool"

/**
 * 固定一套 defs，不依赖当前激活的 Card。
 *
 * `initVariablePool` 接受任意 `variableDefs`，自带定义才能让断言与
 * 「本机 data_root 里恰好是哪张卡」解耦 —— 否则换一台机器就红。
 */
const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "系统写", type: "number", initial: 5, description: "只由系统写", updateBy: "system", min: 0, max: 100, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "枚举变量", updateBy: "llm", enum: ["平静", "开心"], reset: "never" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", min: 0, max: 999, reset: "never" },
]

/**
 * 断言直接调纯函数 / 同步改内存态，不依赖回合输出，因此统一 `entry: "unit"`。
 *
 * ⚠️ `ctx.pool` 是断言运行**之前**抓的快照。check 内部改动变量池后，
 * 必须重新 `getPoolSnapshot()` 读结果，看 `ctx.pool` 只会看到旧值。
 */
const unit = (
  caseId: string,
  contractId: string,
  description: string,
  run: () => void,
  // 按 SKILL.md 的判据：有状态变化的算 deep。这里大多数场景都在重建/改写变量池，
  // 只有纯计算与纯格式化是 shallow。
  depth: "shallow" | "deep" = "deep",
): SceneDef => ({
  meta: {
    caseId,
    module: "variable-pool",
    contractId,
    description,
    depth,
    suite: "regression",
    entry: "unit",
    tags: ["variable-pool", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description,
    userText: "检查变量池。",
    checks: [{ type: "expectVariablePool", run: async () => run() }],
  }],
})

const seed = (): void => {
  destroyPool()
  initVariablePool({ cardId: "test-card", variableDefs: DEFS })
}

export const 系统变量计算 = unit("variable-system-vars", "vp-01", "computeSystemVariables 计算 6 个系统变量", () => {
  // 2026-01-03 是周六；23:05 落在夜间区间
  const vars = computeSystemVariables(new Date(2026, 0, 3, 23, 5), "yuki")

  if (vars.hour !== 23) throw new Error(`hour 应为 23，实际 ${vars.hour}`)
  if (vars.minute !== 5) throw new Error(`minute 应为 5，实际 ${vars.minute}`)
  if (vars.dayOfWeek !== 6) throw new Error(`dayOfWeek 应为 6（周六），实际 ${vars.dayOfWeek}`)
  if (vars.isNightTime !== true) throw new Error("23 点应判定为夜间")
  if (vars.isWeekend !== true) throw new Error("周六应判定为周末")
  if (vars.activeCardId !== "yuki") throw new Error(`activeCardId 未透传，实际 ${vars.activeCardId}`)

  // 边界：边界值必须落在同一侧，否则「夜里」的定义会随实现漂移
  if (computeSystemVariables(new Date(2026, 0, 5, 22, 0), "x").isNightTime !== true) throw new Error("22 点应算夜间")
  if (computeSystemVariables(new Date(2026, 0, 5, 5, 0), "x").isNightTime !== true) throw new Error("5 点应算夜间")
  if (computeSystemVariables(new Date(2026, 0, 5, 6, 0), "x").isNightTime !== false) throw new Error("6 点不该算夜间")
  if (computeSystemVariables(new Date(2026, 0, 5, 12, 0), "x").isWeekend !== false) throw new Error("周一不该算周末")
}, "shallow")

export const 变量池初始化 = unit("variable-pool-init", "vp-02", "initVariablePool 按 defs 建池", () => {
  seed()
  const pool = getPoolSnapshot()

  // card 与 interaction 变量必须都建成 VariableState，不能退化成原始值
  if (pool.card["亲密"]?.value !== 0 || pool.card["亲密"]?.type !== "number") {
    throw new Error(`card 变量未按 def 初始化: ${JSON.stringify(pool.card["亲密"])}`)
  }
  if (pool.interaction["unansweredCount"]?.value !== 0) throw new Error("interaction 变量未初始化")
  if (getVariableRegistry().length !== DEFS.length) throw new Error("registry 与 defs 不一致")
})

export const 变量池刷新 = unit("variable-pool-refresh", "vp-03", "refreshVariablePool 只重算系统变量", () => {
  seed()
  const before = getPoolSnapshot()
  const next = refreshVariablePool({ activeCardId: "other-card" })

  if (next.system.activeCardId !== "other-card") throw new Error("refresh 未采用传入的 activeCardId")
  // 只动 system：card / interaction 的对象身份不变，值也不变
  if (next.card["亲密"]?.value !== before.card["亲密"]?.value) throw new Error("refresh 不该改 card 变量")
  if (next.interaction["unansweredCount"]?.value !== 0) throw new Error("refresh 不该改 interaction 变量")
  // 不给参数时沿用**模块内的** currentCardId：refresh 只覆盖本次返回值，
  // 不会把入参写回全局状态，所以这里应回到 "test-card" 而不是 "other-card"
  if (refreshVariablePool().system.activeCardId !== "test-card") {
    throw new Error(`refresh 不该改写入参: ${refreshVariablePool().system.activeCardId}`)
  }
})

export const 未注册变量拒绝 = unit("variable-pool-unregistered", "vp-05", "batchWriteVars 拒绝未注册变量", () => {
  seed()
  const result = batchWriteVars({ 不存在的变量: "1" })

  if (result.written.length !== 0) throw new Error("未注册变量被写入")
  if (!result.errors.some(e => e.includes("未注册"))) throw new Error(`错误原因不对: ${result.errors.join("; ")}`)
  if ("不存在的变量" in getPoolSnapshot().card) throw new Error("未注册变量出现在池里")
})

export const 系统变量只读 = unit("variable-pool-system-readonly", "vp-07", "updateBy=system 的变量不可被 LLM 写", () => {
  seed()
  const result = batchWriteVars({ 系统写: "99" })

  if (result.written.length !== 0) throw new Error("updateBy=system 的变量被写入")
  if (!result.errors.some(e => e.includes("不可写"))) throw new Error(`错误原因不对: ${result.errors.join("; ")}`)
  if (getPoolSnapshot().card["系统写"]?.value !== 5) throw new Error("只读变量的值被改动")
})

export const 变量池提示词 = unit("variable-pool-prompt", "vp-15", "formatPoolForPrompt 序列化三类变量", () => {
  seed()
  const text = formatPoolForPrompt(getPoolSnapshot())

  // 系统变量与 Card 变量段落恒定存在
  for (const section of ["[系统变量", "[Card变量"]) {
    if (!text.includes(section)) throw new Error(`缺少段落 ${section}`)
  }
  // interaction 非空时才出现；本池里有 unansweredCount，所以这一段必须在
  if (!text.includes("[互动状态")) throw new Error("interaction 非空却没有对应段落")

  // Card 变量要把约束写进 prompt，否则模型不知道边界在哪
  if (!text.includes("亲密")) throw new Error("Card 变量未出现在 prompt")
  if (!text.includes("平静")) throw new Error("string 变量的可选值未注入")

  // 段落占位符只在真的空段落出现；这里 interaction 非空，所以不该有 (空)
  if (text.includes("(空)")) throw new Error("非空段落出现了空占位符")
}, "shallow")

export const 变量池快照恢复 = unit("variable-pool-snapshot", "vp-16", "snapshot 与 restore 往返", () => {
  seed()
  batchWriteVars({ 亲密: "7" })
  const snapshot = snapshotVariablePoolState()
  if (getPoolSnapshot().card["亲密"]?.value !== 7) throw new Error("前置写入未生效")

  // 破坏当前状态，再用快照恢复
  batchWriteVars({ 亲密: "1" })
  restoreVariablePoolState(snapshot)
  if (getPoolSnapshot().card["亲密"]?.value !== 7) throw new Error("restore 未还原变量值")
  if (getPoolSnapshot().card["亲密"]?.updatedBy !== "llm") throw new Error("restore 未还原写入来源")

  // 人格切换失败的回滚必须连变量注册表一起还原（VAR-02）：
  // 只还原池会让后续写入按目标卡的 schema 校验、Prompt 里变量元数据整块消失
  initVariablePool({ cardId: "other-card", variableDefs: [] })
  restoreVariablePoolState(snapshot)
  if (getVariableRegistry().map(d => d.name).join(",") !== DEFS.map(d => d.name).join(",")) {
    throw new Error(`restore 未还原变量注册表: ${getVariableRegistry().map(d => d.name).join(",")}`)
  }
  if (getPoolSnapshot().system.activeCardId !== "test-card") throw new Error("restore 未还原卡归属")
  if (getPoolSnapshot().card["亲密"]?.value !== 7) throw new Error("restore 注册表后变量值被改坏")
})

export const 变量池销毁 = unit("variable-pool-destroy", "vp-17", "destroyPool 清空全部状态", () => {
  seed()
  batchWriteVars({ 亲密: "3" })
  destroyPool()

  if (getVariableRegistry().length !== 0) throw new Error("registry 未被清空")
  if (Object.keys(getPoolSnapshot().card).length !== 0) throw new Error("card 变量未被清空")
  // 销毁后再写必须一律拒绝：registry 没了，所有名字都是「未注册」
  const after = batchWriteVars({ 亲密: "3" })
  if (after.written.length !== 0) throw new Error("销毁后仍能写入变量")
})

export const 持久化非法值回退 = unit("variable-pool-invalid-restore", "vp-18", "持久化值不合法时回退 initial", () => {
  destroyPool()
  const stale = {
    亲密: { value: 999, type: "number" as const, updatedAt: 1, updatedBy: "llm" as const },
    心情: { value: "不在枚举里", type: "string" as const, updatedAt: 1, updatedBy: "llm" as const },
  }
  // 越界 number 与不在 enum 的 string 都必须被判为无效
  const pool = initVariablePool({ cardId: "test-card", variableDefs: DEFS, prevCardStates: stale })

  if (pool.card["亲密"]?.value !== 0) throw new Error(`越界值未回退到 initial，实际 ${pool.card["亲密"]?.value}`)
  if (pool.card["心情"]?.value !== "平静") throw new Error(`非法枚举未回退，实际 ${pool.card["心情"]?.value}`)

  // 合法值仍要保留，否则「回退」会退化成「永远不恢复」
  const ok = initVariablePool({
    cardId: "test-card",
    variableDefs: DEFS,
    prevCardStates: { 亲密: { value: 7, type: "number", updatedAt: 1, updatedBy: "llm" } },
  })
  if (ok.card["亲密"]?.value !== 7) throw new Error("合法持久化值被误判为无效")
})
