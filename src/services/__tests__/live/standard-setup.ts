// ==========================================
// 标准场景 Setup — 场景间状态隔离
// ==========================================

import { destroyPool, initVariablePool } from "@/services/personality/variable-pool"
import { clearMessages } from "@/services/session/store"
import { activeSessionId, sessions, unansweredCount } from "@/services/session/store"
import { resetSessionPersistenceForTest } from "@/services/session/persistence"
import { MemoryService, resetMemoryProvider } from "@/services/agent/memory"
import { flushMemory } from "@/services/agent/memory/memory-entries"
import { deleteAllPiSessionsForTest } from "@/services/session/repo"
import { getActiveCard, initRegistry } from "@/services/personality/registry"
import { initCards } from "@/services/personality/loader"
import { registerDefaultTools } from "@/services/tool/registry"
import { resetCooldown, setAIGenerating } from "@/services/cooldown"
import { resetPiRuntimeProviderForTest } from "@/services/engine/pi"
import { resetAgentRuntimeForTest } from "@/services/agent/runner"
import { flushConfig, getAllOverrides, setOverrides } from "@/services/config"
import { resetConfirmChannel } from "./confirm-channel"
import { resetPlanConfirmChannel } from "./plan-confirm-channel"
import type { ConfirmPolicy, PlanPolicy } from "./types"

let bootstrapped = false

async function bootstrapOnce(): Promise<void> {
  if (bootstrapped) return
  await initCards()
  await initRegistry()
  await registerDefaultTools()
  bootstrapped = true
}

// ── 配置隔离 ──

type ConfigTree = Record<string, unknown>

function isConfigTree(value: unknown): value is ConfigTree {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 配置树只含 JSON 形态的值；数组按值比较（`setAtPath` 对数组也是整段替换）。 */
function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameConfigValue(item, right[index]))
  }
  if (isConfigTree(left) && isConfigTree(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameConfigValue(left[key], right[key]))
  }
  return false
}

/**
 * 把 `current` 拉回 `baseline` 所需的点路径写入表（与 `setOverrides` 的入参同形）。
 *
 * - 值不同（含整棵子树被换成了别的形态）：写回基线值
 * - 当前多出来的键：写 `undefined` —— `setAtPath` 置空后 js-yaml 序列化会整个省略该键，等价于删除
 */
function configRestorePlan(baseline: ConfigTree, current: ConfigTree, path = "", plan: ConfigTree = {}): ConfigTree {
  for (const [key, baseValue] of Object.entries(baseline)) {
    const keyPath = path ? `${path}.${key}` : key
    const currentValue = current[key]
    if (isConfigTree(baseValue) && isConfigTree(currentValue)) {
      configRestorePlan(baseValue, currentValue, keyPath, plan)
      continue
    }
    if (!sameConfigValue(baseValue, currentValue)) plan[keyPath] = baseValue
  }
  for (const key of Object.keys(current)) {
    // 已经写回 undefined 的键在盘上本来就是省略的：不再重复写
    if (Object.prototype.hasOwnProperty.call(baseline, key) || current[key] === undefined) continue
    plan[path ? `${path}.${key}` : key] = undefined
  }
  return plan
}

let configSnapshot: ConfigTree | undefined

/**
 * 运行开始时的配置快照，场景之间的还原目标。
 *
 * 助手模式在这里按 pet 基线钉死：Live Test 默认恒以 pet 模式运行，这个键就是那句约定的
 * 代码依据 —— 计划入口由 `generalConfig.assistantMode && planConfig.enabled` 双重把守，
 * 钉住助手模式就走不到计划段；场景要跑计划段必须在自己的 setup 里显式打开
 * （`计划生产闭环` 等场景都这么做）。
 * `ai.plan.enabled` 不在钉住之列：pet 模式下它不生效，钉住它只会把开发配置里出厂即 `true`
 * 的值改写成 false，而它在场景之间的漂移由快照还原兜住。
 */
function configBaseline(): ConfigTree {
  if (!configSnapshot) {
    const snapshot = structuredClone(getAllOverrides() as ConfigTree)
    const general = isConfigTree(snapshot.general) ? snapshot.general : {}
    snapshot.general = {
      ...general,
      mode: { ...(isConfigTree(general.mode) ? general.mode : {}), assistant: false },
    }
    configSnapshot = snapshot
  }
  return configSnapshot
}

/**
 * 场景间配置隔离：把配置拉回运行快照 + pet 基线。
 *
 * 这是结构性兜底，不依赖场景自己写清理：断言失败会让运行器 `break` 掉后续断言
 * （scene-runner.ts），清理挂在最后一条断言 `finally` 上的场景就再也执行不到；
 * 超时被放弃的执行也可能事后补一次 `setOverride`。这些漂移一律在这里被无条件收回 ——
 * 调用点由 `withStandardSetup` 保证每个 trial 都跑一次，且跑在场景自己的 setup 之前。
 *
 * 落盘：config.ts 没有「只改内存」的通道（`setOverride` / `setOverrides` 必然
 * `queueConfigSave()` → `write_runtime_config`），所以还原本身会写一次运行时 CONFIG。
 * 因此只在真的发生漂移时才动手：干净跑一次都不碰盘。
 */
async function restoreConfigBaseline(): Promise<void> {
  const plan = configRestorePlan(configBaseline(), getAllOverrides() as ConfigTree)
  if (Object.keys(plan).length === 0) return
  setOverrides(plan)
  // 等这次还原落盘再放行：场景自己的 setup 与后续场景的写入都排在它后面，顺序不靠猜
  await flushConfig()
}

/**
 * 场景隔离入口。
 *
 * `confirmPolicy` 与 `planPolicy` 由场景声明（`meta.confirmPolicy` / `meta.planPolicy`），
 * 在隔离点一起重置：确认通道与计划通道都是典型跨场景状态，一个场景留下的 pending
 * 必须在这里被收尾，不能等下一个场景的请求把它覆盖掉。
 */
export async function standardSetup(
  confirmPolicy: ConfirmPolicy = "deny",
  planPolicy: PlanPolicy = "deny",
): Promise<void> {
  // 配置隔离排在最前：本函数之后的一切（含场景自己的 setup）都该在 pet 基线上运行
  await restoreConfigBaseline()
  await bootstrapOnce()
  resetConfirmChannel(confirmPolicy)
  resetPlanConfirmChannel(planPolicy)

  // 上一场景的异步 session 写入必须先完成，之后才能清空模块状态。
  await MemoryService.init()
  // 会话正文真相源是 sessions/ 下的 JSONL：先关句柄再逐个删除，场景之间不共享会话。
  await deleteAllPiSessionsForTest()

  // 1. 重置会话状态：运行槽与条目由上面的删句柄 + resetAgentRuntimeForTest 收敛，没有进程内状态机
  // 2. 重置变量池
  const card = getActiveCard()
  if (card) {
    destroyPool()
    initVariablePool({
      cardId: card.id,
      variableDefs: card.sections.variableDefs,
    })
  }

  // 3. 清空记忆
  MemoryService.clear()
  await flushMemory()

  // 4. 清空聊天历史
  clearMessages()
  sessions.splice(0, sessions.length)
  activeSessionId.value = ""
  unansweredCount.value = 0
  resetCooldown()
  setAIGenerating(false)
  resetPiRuntimeProviderForTest()
  resetMemoryProvider()
  await resetAgentRuntimeForTest()
  await resetSessionPersistenceForTest()
}
