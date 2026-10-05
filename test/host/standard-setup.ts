// ==========================================
// 标准场景 Setup — 场景间状态隔离
// ==========================================

import { destroyPool, initVariablePool } from "@/services/personality/variable-pool"
import { clearMessages } from "@/services/session/store"
import { activeSessionId, sessions, unansweredCount } from "@/services/session/store"
import { resetSessionPersistenceForTest } from "@/services/session/persistence"
import { MemoryService, resetMemoryProvider } from "@/services/agent/memory"
import { deleteAllPiSessionsForTest } from "@/services/session/repo"
import { getActiveCard, initRegistry } from "@/services/personality/registry"
import { initCards } from "@/services/personality/loader"
import { registerDefaultTools } from "@/services/tool/registry"
import { resetCooldown, setAIGenerating } from "@/services/cooldown"
import { resetSessionSafetyMode } from "@/services/debug"
import { resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { initSlashCommands } from "@/services/engine"
import { resetAgentRuntimeForTest } from "@/services/agent/runner"
import { flushConfig, getAllOverrides, setOverrides } from "@/services/config"
import { resetConfirmChannel } from "./confirm-channel"
import { resetPlanConfirmChannel } from "./plan-confirm-channel"
import type { ConfirmPolicy, PlanPolicy } from "./types"

let bootstrapped = false

/**
 * 宿主启动面：应用启动时由 UI 壳完成的服务级初始化，Live 宿主不挂载 UI，必须自己补齐。
 *
 * Slash 命令注册表就在这里：`preProcess`（唯一执行入口）按注册表查命令，注册调用在
 * 领域引导（`@/services/init`）里；场景不跑完整引导，宿主不补的话注册表恒为空，
 * `/compact`、`/clear` 会走「未注册的 slash 输入透传 AI」，被当成普通回合发给模型。
 * 补在这里而不是各场景里：命令注册是宿主启动面，与工具/卡片注册同级。
 */
async function bootstrapOnce(): Promise<void> {
  if (bootstrapped) return
  await initCards()
  await initRegistry()
  await registerDefaultTools()
  initSlashCommands()
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
 * 两个钉位的理由都是「不钉住就会静默改变被测行为」：
 *
 * - **计划门禁**：计划入口只看 `planConfig.enabled`（模式已在收敛中删除），而 `ai.plan.enabled`
 *   出厂即 `true` —— 不钉住它，任何命中复杂度关键词的 production 场景文本都会静默走进真实
 *   计划段。场景要跑计划段必须在自己的 setup 里显式打开（`计划生产闭环` 等场景都这么做）。
 * - **安全模式**：`DANGER` 的裁决完全由 `ai.safety.mode` 决定（`let_me_tk` → ask、
 *   `just_do_it` → allow、其余含出厂默认 `tell_me` → ask）。需要确认通道的场景（`子代理授权范围`、
 *   `确认通道`、`工具结果存档边界`）靠 `tell_me` 才有 ask；开发者本地若是 `just_do_it`，
 *   这些场景会**静默失去确认请求**，本该拦下它们的断言变成真空断言（门禁假通过）。
 *   `let_me_tk` 也产出 ask，这里只钉一个确定的出厂值，让裁决输入不随本机配置漂移。
 *   钉位只覆盖配置这条轴：会话级覆盖优先级更高（`getEffectiveSafetyMode()` = 会话覆盖 ?? 配置），
 *   由 `standardSetup` 开头的 `resetSessionSafetyMode()` 无条件收回。
 *
 * 注意：`setOverride` 没有「只改内存」的通道，还原必然写一次运行时 CONFIG ——
 * 与既有的计划钉位同量级（详见 `restoreConfigBaseline`）。
 */
function configBaseline(): ConfigTree {
  if (!configSnapshot) {
    const snapshot = structuredClone(getAllOverrides() as ConfigTree)
    const ai = isConfigTree(snapshot.ai) ? snapshot.ai : {}
    const plan = isConfigTree(ai.plan) ? ai.plan : {}
    const safety = isConfigTree(ai.safety) ? ai.safety : {}
    snapshot.ai = { ...ai, plan: { ...plan, enabled: false }, safety: { ...safety, mode: "tell_me" } }
    // 外部 MCP 属于场景显式前提；本机已启用的 npx/server 不能阻塞 fake Provider 与记忆基准。
    // 只修改隔离根中的配置，场景可在自己的 setup 中重新启用所需服务器。
    const tools = isConfigTree(snapshot.tools) ? snapshot.tools : {}
    const mcp = isConfigTree(tools.mcp) ? tools.mcp : {}
    snapshot.tools = { ...tools, mcp: { ...mcp,
      servers: Array.isArray(mcp.servers) ? mcp.servers.map(server => isConfigTree(server) ? { ...server, enabled: false } : server) : [],
    } }
    configSnapshot = snapshot
  }
  return configSnapshot
}

/**
 * 场景间配置隔离：把配置拉回运行快照 + 计划门禁与安全模式基线。
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
  // 安全裁决输入的第二条轴：会话级覆盖优先级高于 `ai.safety.mode` 钉位
  // （`getEffectiveSafetyMode()` = 会话覆盖 ?? 配置），却只挂在场景自己的清理上 ——
  // `输入先落盘` 的还原在断言 finally 里（setup 抛错就到不了），`权限策略冻结` 的还原在
  // 最后一条检查上（前序断言失败会被运行器 break 掉）。残留的 `just_do_it` 会让需要
  // `DANGER → ask` 的场景静默失去确认请求，正是钉位要挡的假通过，因此和配置漂移一样
  // 在隔离点无条件收回。放在第一句、不跨 await：后面的配置还原可能抛错，这条兜底不能被跳过。
  resetSessionSafetyMode()
  // 配置隔离紧随其后：本函数之后的一切（含场景自己的 setup）都该在计划门禁关闭的基线上运行
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

  // 3. 清空记忆：走治理清空（与 UI 同一条提交路径 + 递增遗忘代），E2E 宿主跑真 Rust。
  //    提交失败不静默：场景之间共享一份脏记忆比直接报错更难查。
  //    唯一例外是「这个宿主根本没有记忆后端」（L3 的 Node 适配层）：那时没有状态要隔离，
  //    与「有库但清空失败」是两回事，不能混成同一条静默分支。
  try {
    if (!await MemoryService.clear()) throw new Error("记忆库清空未提交")
  } catch (error) {
    if ((error as { name?: string })?.name === "UnsupportedInNodeError") {
      // Node 适配层没有记忆库：这里没有第二份状态，跳过清空是准确的，不是放行。
    } else {
      throw error
    }
  }

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
