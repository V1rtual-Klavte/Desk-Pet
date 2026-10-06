// ==========================================
// 领域引导模块（Node 侧）
// ==========================================
//
// 执行契约 §4.3 第 2 条；原生宿主迁移过程记录 §9.4 第 35/36 条：
// - `initDomainBootstrap()`：Node 侧领域序列，唯一 Node bootstrap（`src/harness/main.ts`）
//   的调用点。域内有进程内单次闩：重复调用返回同一次运行的结果，绝不二次初始化
//   （防止将来接线失误把状态初始化两次）。
// - Node 不再有 UI 投影入口。
//
// 各步归属（Node / UI）的判定依据见 W4 交付报告；要点：
// - Profile 只在这里做元数据与选择（Node 侧）；主题样式消费归 UI 装配注册消费者，
//   Node 侧不碰 DOM。
// - Debug 状态刷新（工具计数/上下文上限）是运行时读模型，留在 Node 侧；
//   `window.__*` 调试句柄是旧的开发者入口（`debug.ts` 的 `typeof window` 守卫内），
//   不随 Node 出现；宿主侧调试端点属 W5/W8（本包只标注，不实现）。

import { MemoryService, startIdleDreamingScheduler } from "@/services/agent/memory"
import { loadV1rtualInstructions } from "@/services/context/instructions"
import { initRegistry } from "@/services/personality"
import { registerDefaultTools } from "@/services/tool"
import { initDebug } from "@/services/debug"
import { initSlashCommands } from "@/services/engine/slash"
import { initSessions, chatHistory, initWelcome, getActiveSessionId } from "@/services/session"
import { applyLogLevel, computeMcpEnabled, enabledMcpServerNames, initConfig } from "@/services/config"
import { initPaths } from "@/services/paths"
import { createLogger } from "@/services/logger"

const log = createLogger("Init")

let domainBootstrapRun: Promise<void> | null = null

/**
 * 领域引导（Node 侧序列）—— 进程内单次。
 *
 * 顺序:
 *   1. 路径与运行时 CONFIG（get_runtime_paths → read_runtime_config；getter 的取值源）
 *   2. Memory 文件系统 (memory/ 目录就绪) + V1RTUAL 指令 + idle dreaming 调度器
 *   3. Profile 元数据与选择（主题样式注入归 UI 消费者）
 *   4. 人格模块注册（Card 加载 → registry）
 *   5. proactive / runner / session 接线（回执读取器先于会话投影/恢复）
 *   6. Presence 所需的基础工具 + slash 命令表
 *   7. 会话扫描恢复 (sessions → 列表 + 加载活跃会话消息) + Plan checkpoint 恢复
 *   8. 欢迎语 (仅当 chatHistory 确实为空)
 *   9. Debug 状态刷新（工具计数/上下文上限；window.__* 句柄不在此列）
 *  10. 原生 UI 桥（宿主请求处理器 + 首帧状态推送；推送失败如实不阻断）
 *  11. 窗口观察接线（订阅 window-observed + 按 silentAccess 应用观察总闸/行为采集）
 *  12. 主动陪伴与静默了解调度启动（scanner.start() / startSilentUnderstanding()
 *      的唯一调用点）
 *
 * 失败语义：任何一步抛出都向上抛给 bootstrap（harness 记录并退出）——
 * 不做「吞掉继续」的降级。
 */
export function initDomainBootstrap(): Promise<void> {
  if (!domainBootstrapRun) domainBootstrapRun = runDomainBootstrap()
  return domainBootstrapRun
}

async function runDomainBootstrap(): Promise<void> {
  log.info("──── 初始化开始 ────")

  // ── 1. 路径与运行时 CONFIG ──
  // 顺序是刻意的（initPaths() → initConfig()）：CONFIG 读的是
  // 数据根的运行时配置（不是内置模板），必须早于一切经类型化 getter 的消费者 ——
  // 否则设置窗会读到模板值，一次保存就会把用户配置覆盖成模板（两者都幂等）。
  await initPaths()
  await initConfig()
  // 引导期即应用真实日志级别（契约 Part 1.3）：computeLogLevel() 要真实 runtimeMode 与
  // 已加载配置，initConfig() 之后才具备；不应用则 logger 停在保守默认 info，主动链路的
  // debug 证据整段丢失。刻意不放进 initConfig() —— 它被多个 L2 用例直接调用，放进去会
  // 给每次调用加一次 set_log_config 下行请求与噪声。
  applyLogLevel()
  log.info("1/11 路径与运行时 CONFIG 就绪")

  // ── 2. Memory 文件系统 ──
  await MemoryService.init()
  await loadV1rtualInstructions()
  startIdleDreamingScheduler()
  log.info("2/11 Memory 就绪")

  // ── 3. Profile 系统（元数据 + 选择；注入交 UI）──
  const { initProfiles, getActiveProfile } = await import("@/services/profile")
  await initProfiles()
  const p = getActiveProfile()
  log.info(`3/11 Profile 就绪: "${p?.meta.name}"`)

  // ── 4. 人格模块（激活卡按需加载 → registry）──
  await initRegistry()
  log.info("4/11 人格模块就绪")

  // Proactive owns SQLite receipts; install readers before session projection/recovery.
  const proactive = await import("@/services/proactive")
  const runner = await import("@/services/agent/runner")
  const session = await import("@/services/session")
  proactive.configureProactive({expression:proactive.createActiveExpressionAdapter(),runPlanner:(await import("@/services/engine/harness/runtime")).runPiSubAgent,
    cancelExpression:runner.cancelProactiveRun,reconcileSession:proactive.reconcileSession})
  runner.registerProactiveTurnContextReader(proactive.getTurnContext)
  runner.registerUserIngressObserver(()=>proactive.cancelCurrent("user_input"))
  session.registerActiveReceiptReader(proactive.readReceipt)
  session.registerActiveReceiptReconciler(proactive.reconcileSession)

  // ── 5. 工具注册 + slash 命令表 ──
  await registerDefaultTools()
  log.info("5a/11 基础工具就绪")

  // slash 命令表：preProcess 按注册表查命令，宿主不挂 UI 时也必须自己注册。
  // 没有其它调用点 —— 不注册则命令表恒为空（未识别输入被当普通文本投给模型）。幂等，可重复调用。
  initSlashCommands()

  const { toolCount } = await import("@/services/tool/registry")
  log.info(`5/11 Presence 工具就绪 (${toolCount()} 个) | MCP:${computeMcpEnabled()}`)

  // ── 6. 会话初始化 ──
  // 崩溃恢复不再扫描旧队列事件：Harness 在打开会话时报告未完成操作（§8.7.3），
  // 由用户选择继续或丢弃；这里只恢复 Plan checkpoint。
  const sessions = await initSessions()
  log.info(`6/11 会话就绪: ${sessions.length} 个, 活跃: ${sessions[0]?.id ?? "无"}, 消息: ${chatHistory.length} 条`)
  const { recoverPlanCheckpoints } = await import("@/services/agent/runner")
  await recoverPlanCheckpoints()

  // ── 7. 欢迎语（一律走激活 Card 的问候语）──
  if (chatHistory.length === 0) {
    const { pickActiveGreeting } = await import("@/services/personality")
    const greeting = pickActiveGreeting()
    if (greeting) await initWelcome(greeting, getActiveSessionId())
    log.info("7/11 欢迎语已写入")
  } else {
    log.info("7/11 跳过欢迎语（已有历史消息）")
  }

  // ── 8. Debug 状态 ──
  await initDebug()
  log.info("8/11 Debug 就绪")

  // ── 9. 原生 UI 桥（宿主请求处理器 + 首帧状态推送）──
  // 位置理由：设置读写/编辑器 I/O 与舞台推送都消费 CONFIG/Profile/Card（前面各步
  // 已就绪）；「启动握手后各推一次」= 领域初始化收口处的这一推。首推在没有原生端口
  // 的宿主会失败并留一条 warn，不阻断引导；请求处理器注册失败向上抛（接线错误），
  // 只有「宿主没有事件通道」（无原生 UI）在 initNativeUiBridge 内被识别并跳过留痕。
  const { initNativeUiBridge } = await import("@/services/native-ui")
  await initNativeUiBridge()
  log.info("9/11 原生 UI 桥处理完成")

  // ── 10. 窗口观察接线（Node 侧订阅 + 观察总闸）──
  // 宿主把 monitor 线程的 `window-observed` 双投到原生 UI 与当前代际 Node
  // （原生宿主迁移过程记录 §9.4 第 2 条）。这里接线：订阅（可退订、重复引导不叠加监听器）+ 按
  // 静默了解档位（ai.silentAccess.frequency，off = 关闸）应用观察总闸
  // （setMonitorEnabled 是既有开关入口，内含行为采集启停，不另建第二入口）。
  const { initWindowObservation } = await import("@/services/window")
  await initWindowObservation()
  log.info("10/12 窗口观察就绪")

  // ── 11. 后台命令完成通知（前台超时转后台的任务终点）──
  // 宿主在后台任务结束 / 到点回收后投 `bash-background-finished`；这里接线：订阅 +
  // 完成通知写聊天系统消息（`session/messages.ts` 的 pushSystemMessage —— 唯一展示
  // 通道，不新造 UI）。没有事件通道的宿主由接线内部识别并跳过留痕（与窗口观察同判据）。
  const { initBackgroundCommandNotifier } = await import("@/services/tool")
  initBackgroundCommandNotifier()
  log.info("11/12 后台命令完成通知就绪")

  // ── 12. 主动陪伴与静默了解调度启动 ──
  // 顺序是刻意的：setMonitorEnabled(...) → startProactive() → startSilentUnderstanding()
  // （紧邻两次同步 start；窗口观察/观察总闸在其前，快捷键注册等 UI 接线在其后）。
  // 这两次 start 全仓只有本调用点：scanner.start() 是唯一置 started 并订阅窗口观察的
  // 地方、startSilentUnderstanding() 只有测试调用 —— 不启动 = 主动扫描与了解层从不运行。
  // 落位条件：在窗口观察接线（第 10 步，含观察总闸）之后，无其它前置条件；
  // 两者都有内部 started 闩（重复调用安全），引导本身是进程内单次。
  // stop 侧：Node 宿主没有卸载点，进程随宿主断开退出（生命周期钩子在 harness/main.ts）。
  proactive.start()
  const { startSilentUnderstanding } = await import("@/services/observation")
  // 静默了解内部按 ai.silentAccess.frequency 判定（off 档不启动也不报错）。
  startSilentUnderstanding()
  log.info("12/12 主动陪伴与静默了解调度就绪")

  log.info("──── 初始化完成 ────")
}

// 注意边界：任何依赖浏览器/Tauri 的投影代码都不得回到本文件 —— 动态 import
// 也会进 Node harness 的产物闭包，构建守卫（`build:harness` 后 rg 零命中
// `@tauri-apps` / `import.meta.env` / `navigator.`）会失败。

/** 一次能力准备的结果：启用但本次没能借用成功的 MCP 服务器名。 */
export interface CapabilityPrepResult {
  unavailableMcp: string[]
}

/**
 * 对话前准备本轮能力：借用启用的 MCP 服务器、预热 Skill 目录。调用方必须在
 * run 结束后才调用本函数，不能在运行中清掉 router 仍可能使用的已冻结工具；
 * root 在 run preflight 冻结 snapshot。
 * 借用失败的服务器名交回调用方，由它决定是否把「本次能力不全」变成可见结论。
 */
export async function prepareConversationCapabilities(owner: string): Promise<CapabilityPrepResult> {
  await registerDefaultTools()
  const unavailableMcp: string[] = []
  // 借用面与「MCP 是否生效」同源（config 的 enabledMcpServerNames）：总闸已删，控制面在
  // 每服务器的 enabled，全部关掉即无人可借。owner 必填：调用方一律给本轮的 requestId 或
  // resumeOwner(sessionId)，默认值会让「谁借的」失去唯一来源，也让释放失去配对。
  const { acquireMcpServer, disconnectUnlistedMcpServers } = await import("@/services/tool/mcp")
  const enabledMcp = enabledMcpServerNames()
  // 保活连接不代表仍然启用：先撤掉配置里已关闭、且没有 owner 的服务器，
  // 避免它们的工具在保活窗口内继续进请求。
  await disconnectUnlistedMcpServers(enabledMcp)
  for (const name of enabledMcp) {
    const acquired = await acquireMcpServer(name, owner)
    if (!acquired.success) {
      unavailableMcp.push(name)
      log.warn(`MCP 获取失败: ${name} | ${acquired.error ?? "未知错误"}`)
    }
  }
  // 每回合的 Skill 目录指纹核对挂在这里：主回合（runtime.ts 的 runPiAgentTurn）、续跑与 Plan 恢复
  // 都经本函数进入，稳态恰好 1 次 Rust IPC（指纹没变就复用 store 的清单）。磁盘一变即重载，
  // 所以「实时」由每回合核对保证 —— 没有 TTL、不需要重启；决策 8 删总开关后本入口不再把关。
  const { syncSkillCatalog } = await import("@/services/skill")
  await syncSkillCatalog()
  return { unavailableMcp }
}

/**
 * run 级能力准备：借用 MCP / 预热 Skill 目录，并在借用失败时把不可用的服务器名单交回调用方。
 * `assertCurrent` 在准备前后各调一次 —— 准备期间回合可能已被取消。
 */
export async function prepareRunCapabilities(
  owner: string, assertCurrent?: () => void,
): Promise<CapabilityPrepResult> {
  assertCurrent?.()
  const result = await prepareConversationCapabilities(owner)
  assertCurrent?.()
  return result
}
