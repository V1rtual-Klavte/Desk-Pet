// 2026-10-06 验收批次：声明更新，sourceHash 批量刷新（主会话统一复算）。
// 2026-10-05 本批复查与刷新（RUNTIME_DATA 协议缺失检测与提醒）：sourceFiles 变化 ——
// runtime.ts（结算按冻结 Card 判定 runtimeDataMissing：缺区块且声明了 updateBy=llm 的 card
// 变量才 mark 会话提醒并 log.warn；取消/中断/主动表达在更早分支返回不参与；下一回合按挂起
// 状态把 RUNTIME_DATA_REMINDER_TEXT 传给 buildPrompt）、context/builder.ts（新增可选入参
// runtimeDataReminder → ephemeral:runtime-data 块；指令注入与缺失检测共用 hasLlmWritableCardVars）、
// reply/reminder.ts（新文件：文案常量与会话级 mark/clear/has，本轮加入 sourceFiles）。
// ar-01..ar-24 逐点核对：ar-16/ar-19/ar-24 紧邻改动面（计划回合 RUNTIME_DATA 写入、流式展示
// 过滤器、humanizer 剥离与提交），逐条对照当前实现语义未变（检测只读结算结果，剥离与写入
// 链路未动）；其余点不在改动面内，实现点仍在。新增 ar-25 登记提醒三条 L2 caseId（检测四条
// 归 variable-pool 的 vp-23）；sourceHash 按当前源码刷新。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径：
// 「最近一次请求」一组（lastPromptTokens / lastContextUsage / lastToolNames）只由对话回合
// 刷新，主动表达回合（transientUserInput）不再刷新；累计用量 recordModelUsage("main") 路径
// 未动）、src/services/debug.ts（updateRequestStats 改为真实 prompt 总量 = input + cacheRead
// + cacheWrite，Provider 未回报才退回估算）；调试条投影经 getSessionThinkingEffortOverride /
// getSessionSafetyModeOverride 读取「默认/覆盖」的既有路径未动。
// ar-01..ar-25 逐点核对：ar-07 的 purpose 分列（recordModelUsage）语义与断言面未变；展示统计
// 新口径不在任何覆盖点的断言面内 —— 对应 L2 用例（test/unit/agent-runtime/
// debug-request-stats.test.ts）未携带 caseId，本批不凭空登记 coverage（有实现无契约覆盖，
// 属已知缺口）；其余点不在改动面内、实现点仍在。本批刷新同时包含另一会话的改动；本轮只做
// coverage 描述与当前实现一致性核对（非逐行行为审计）。未修订覆盖点，sourceHash 按当前源码刷新。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 新增 noteDecline：empty_material / retained_tool / gate_fits / kernel_failure 四个拒绝结局
// 写结构化 decline 记录并各留一条统一日志）、harness-slot.ts（compaction_end 在 failure 或
// manual/overflow 的 decline 时落 deskpet.compaction_declined 条目，threshold 只留日志）、
// runtime/types.ts（新增 CompactionDeclineRecord / CompactionTrigger / CompactionDeclineKind /
// CompactionOverflowDetail，CompactionAuditSink 增可选 decline）。ar-01..ar-25 逐点核对：
// ar-07 的 purpose 分列（压缩走同一通道）记账路径未动；ar-15 的手动压缩准入/续跑收口在压缩
// 之前判定，拒绝面不受 decline 留痕影响；ar-22 的挂起结算与其余点不在改动面内、实现点仍在，
// 覆盖描述与当前实现一致。未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— src/services/session/manager.ts
// （deleteSession 成功后新增删会话清理：从该会话条目去重收集图片路径交宿主命令
// chat_delete_session_images 清理托管聊天图片；空集不调用、失败只留痕、不改变删除返回语义，
// 且只读删会话前已加载的条目，不改回合驱动/槽代际/投递/取消链路）。该行为的覆盖登记在
// chat-images 的 ci-07（L3）。ar-01..ar-25 逐点核对实现点仍在、覆盖描述与当前实现一致，
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（analyze→generate）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（真机根因修复：createTurnSpec 的参数类型补
// providerAdmission / disableAutomaticCompaction / invisible 三个字段并分别转发进请求视图
// hook 与 spec —— 类型缺字段 + 调用点 spread 会静默丢弃；createTurnSinks 增 visible 形参，
// 子运行不外推过程消息/工具结果/流式草稿与 stream-end；runPiSubAgent 传 invisible: true）。
// 新增 ar-26（integration）登记两条 L3 caseId（subagent-provider-admission /
// subagent-chat-invisible，均已做退回修复看红的区分力验证）。ar-01..ar-25 逐点核对：
// ar-16/ar-17/ar-19/ar-23 等子运行相关点语义未变（步骤子代理不写变量、停止级联、主回合流式
// 过滤器重置、辅助模型路由各自口径未动），其余点不在改动面内、实现点仍在；rules 不动
// （ar-26 是 L3，不入 L4 计数）。sourceHash 按当前源码复算。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts 与 model-gateway.ts（估算偏差对账的 actual 与快照
// actualInputTokens / tokenDrift.actual 改用 totalInputTokens = input + cacheRead + cacheWrite；
// 预算判定不变）。ar-07 的 usage 按 purpose 分列口径未变，其余点不在改动面内、实现点仍在，
// 覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 回合治理与图片生命周期批次 · Part 1–3 的 Node 半边（analyze→generate，验收环节）：
// sourceFiles 变化 —— engine/harness/tool-loop-guard.ts（新文件：ToolLoopGuard 病理检测纯逻辑，
// 同参重复/连续失败各 3 软 5 硬、每回合新建实例、软提示与 block 原因文案）与
// context/tool-output.ts（软提示经 annotateToolResultText / projectToolResultText 的可选尾参
// 附着，与地址标注同一出口）加入 sourceFiles；runtime.ts（createTurnSpec 的 maxToolCalls 改
// 可选、只给无人值守子运行；beforeTool 接同参连击的 block+terminate、afterTool 经 terminate
// 在结果侧硬终止失败连击、toolLoopNotices 经投影出口附软提示、settleMainTurn 按
// stoppedByToolGovernance 早退到 toolLoopMaxRounds 兜底）、harness-slot.ts（admit/endAdmission
// 受理计数与 isTurnActive / isAIGenerating 推导，无定时器；stoppedAtToolLimit 改名
// stoppedByToolGovernance；afterTool 返回类型增 terminate）、agent/runner.ts（三个回合入口在
// begin() 成功后受理、三处 finally 交回；src/services/cooldown.ts 整模块删除）；
// 子代理轮数映射在 agent/sub-agent.ts（ai.loop.subAgentRounds），不在本契约 sourceFiles。
// 新增 ar-27（unit：病理检测阈值与重置）、ar-28（integration：计数上限口径 = 主回合无、子运行
// 保留）、ar-29（integration：软提示与两条硬终止路径的接线）、ar-30（integration：AI 生成锁由
// 回合状态推导），共登记 14 条新 caseId（unit 4 / integration 10）。ar-01..ar-26 为描述与来源
// 一致性核对（非逐行行为审计）：本批改动面不落在既有描述的行为面内，实现点仍在，未修订覆盖点；
// L4 侧本批只改三个 memory 场景的载荷与注释（meta 未动），既有 L4 引用不失效；rules 不动
// （新增四点均不入 L4 计数）。sourceHash 按当前源码复算。
// 2026-10-06 证据缺口补漏（本批登记）：ar-29 增补 scenario `tool-loop-subagent-guard`
// （test/integration/agent-runtime/工具循环治理.test.ts：runPiSubAgent 在 maxRounds=10 下同参
// 连续第 5 次于调用门硬终止 —— 前 4 次执行、第 5 次不执行且不再发请求；子运行的请求投影关闭，
// 软提示不附进请求视图，硬终止两条路径照常生效）。ar-30 增补 `ai-lock-resume-pairing` /
// `ai-lock-resume-error-pairing` / `ai-lock-active-pairing`（test/integration/agent-runtime/
// 回合入口准入配对.test.ts：resumePausedInputs 与 sendActiveMessage 两入口在受理→交回之间
// 锁恒为真、交回后归假，含受理之前的提前返回（不触碰锁）、受理之后的提前返回（owner 过期）
// 与错误结算；dispatchMessage 一侧已由 ai-lock-admission-survives-slot-reset 钉住）。
// sourceFiles 未增删，sourceHash 按当前源码复算（与上一条一致）。
// 2026-10-06 详情面板上下文占用重启恢复批次（analyze→generate，验收环节）：sourceFiles 变化 —
// debug.ts（lastContextUsage 由 number 改 number | null（null = 未知，面板显示「—」，不显示 0%）；
// 删两段死字段与消费者 registeredToolCount / registeredMcpCount；新增 restoreLastRequestStats ——
// 从活跃会话的 provider_usage 快照恢复「最近一次对话请求」的真实输入量，已有本进程读数时不覆盖，
// 占比与实时共用 contextUsagePercent 单一计算点，由 initDebug 接线）、
// context/builder.ts（计划提议指引按工具面注入 —— 覆盖登记在 tool-execution 的 te-35）、
// plan-confirmation.ts（PLAN_CONFIRM_TIMEOUT_MS 定义点移居零依赖叶子 plan/limits.ts 并原样转出；
// NON_CONFIRM_NOTICE 导出、新增 planConfirmDeclineText 供工具结果与系统消息共用同一份「确认未成立」
// 文案 —— 工具侧断言归 tool-execution 的 te-32 / planner 的 pl-13）。新增 sourceFile
// engine/harness/request-stats.ts（恢复读取器，语义归属即在列）。新增 ar-31（integration）登记
// 详情面板批次的三条 L3 caseId（context-usage-restore / context-usage-restore-picks-last-formal /
// context-usage-unknown-stays-null，此前无覆盖点引用，即快层校验的 integration ORPHAN）。
// 此前批次注释里「上次请求」一组（lastPromptTokens / lastContextUsage / lastToolNames）的
// 描述据此补：lastContextUsage 现已可重启恢复、可为 null（未知）。ar-01..ar-30 逐点核对实现
// 点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；rules 不动（ar-31 是 L3，
// 不入 L4 计数）。sourceHash 按当前源码复算。
// 2026-10-06 提问选择与去超时批次（analyze→刷 hash）：sourceFiles 变化 —— 新增
// `src/services/engine/choice-confirmation.ts`（提问选择的会话键控回执通道，ar-32）与
// `src/services/engine/user-wait.ts`（等待期预算豁免的唯一登记点，ar-33）；`plan-confirmation.ts`
//（等待不再有本地超时：timer、`timeout` 归宿与「计划确认等待超时」文案随 2026-10-06 用户裁决
// 删除；`PLAN_CONFIRM_TIMEOUT_MS` 及其零依赖叶子 plan/limits.ts 无剩余消费者、整文件删除）、
// `harness-slot.ts`（回合墙钟改为可暂停的一次性计时器：用户等待期间挂起、结算后按剩余预算续算）、
// `runtime.ts`（NON_CONFIRM_CONTEXT 去掉 timeout 一支）、`context/builder.ts`（工具协议段重写，
// 覆盖登记在 tool-execution 的 te-37）与 `session/manager.ts`（切会话/关标签在指针移动前同时
// 取消该会话的待答提问）随同一批改动。新增 ar-32（提问回执通道的身份校验与逃生口）与 ar-33
//（决策类弹窗不留等待超时 + 等待期回合预算豁免：假时钟 10 分钟仍待答 ×3 通道 + 「回合墙钟 1.5s、
// 用户停留 2.2s 仍完成」的行为证据）。ar-01..ar-31 逐点核对实现点仍在、覆盖描述与当前实现一致
//（描述/来源核对，非逐行行为审计）；rules 不动（ar-32/ar-33 是 L3，不入 L4 计数）；
// sourceHash 按当前源码复算。
// 2026-10-06 超时后台化批次（本批刷新）：harness-slot.ts（tool_execution_end trace 增
//durationMs / detailPrefix，观测附加、不改回合与取消语义）与 runtime/trace.ts（SAFE_FIELDS
//白名单增两字段）。ar-* 逐点核对实现点仍在、覆盖描述与当前实现一致；sourceHash 按当前
//源码复算（同批含另会话在飞改动）。
// 2026-10-06 第三轮收口（analyze→刷 hash）：本批 sourceFiles 变化 —— `harness-slot.ts`
//（回合墙钟改可暂停的一次性计时器 + 受理态字段）、`runtime.ts`（NON_CONFIRM_CONTEXT 去掉
// timeout 一支）、`plan-confirmation.ts`（等待去超时）、`choice-confirmation.ts`（提问回执
// 通道）、`engine/user-wait.ts`（等待期预算豁免的唯一登记点）、`engine/runtime/trace.ts`、
// `context/builder.ts`（工具协议段重写，覆盖归 tool-execution 的 te-35/te-37）与
// `session/manager.ts`（切会话/关标签在指针移动前取消待答提问）—— 均已由第三轮各任务登记
// ar-31..ar-33 与注释留痕，本轮逐点复核描述与当前实现一致，未修订。ar-01..ar-33 逐点核对
// 实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；rules 不动
//（ar-32/ar-33 是 L3，不入 L4 计数）；sourceHash 按当前源码复算。
// 2026-10-06 契约账本批次（手工 analyze；本轮只登记、不改源码）：新增 ar-34（工具过程文案的
// 顶栏推送，L3，新用例 test/integration/agent-runtime/工具过程顶栏推送.test.ts 携带两条
// caseId）与 ar-35（详情面板逐请求统计的写入侧口径，L2，debug-request-stats.test.ts 补上三条
// caseId）。两者此前既无锚点也无覆盖声明（旧注释登记的已知缺口），本批关闭。sourceFiles 无增删
// （runtime.ts / debug.ts 均在列）；**sourceHash 刻意不在本批重算** —— 本批未改任何 src 源码，
// 按「实施期只登记、验收统一刷新」的口径留待验收环节统一复算。
import type { ModuleContract } from "../host/types"

// 2026-10-06 实测反馈收口（本批刷新）：sourceFiles 变化仅限 context/builder.ts 的计划提议指引
// 补一句「单个动作需要确认时直接执行（危险动作由确认面板向用户确认），不要用文字先征求同意」——
// 注入条件（工具面含提议工具）与注入通道未变，属同一行为的文案增补；各覆盖点逐条复核与当前实现
// 一致，未修订覆盖点，按当前源码刷新 sourceHash。
// 2026-10-06 验收批次（analyze→generate 的声明部分；sourceHash 留待主会话统一批量刷新）：
// 新增 ar-36（回合失败兜底文案的持久写入失败与恢复，L3，2 条 caseId）与 ar-37（RUNTIME_DATA
// 提醒的结算接线，L3，2 条 caseId）；ar-22 并入压缩续跑的两条异常收口 caseId（已结算 → failed
// 不报完成 + `deskpet.compaction_continuation` 审计条目；suspended → 显式 abort 结算、不落审计、
// 不判忙），描述里「同款挂起分支未由场景单独驱动」的旧话改为已由这两条直接驱动；ar-32 并入
// 提问面板直发消息三条 caseId（当面板停在待答时直发消息 → user_replied 取消 + 如实回执、
// 无面板不触发、不误伤权限确认），描述补第四种归宿 user_replied；ar-11 并入新 L4 场景
// runtime-resume-mcp-unavailable（test/e2e/scenes/agent-runtime/恢复MCP借用失败.scene.ts，
// 受控假 MCP server 构造「借不到」的运行），描述里「在 Live 宿主不可验证／构造不出借不到 MCP」
// 的旧注改为已构造；ar-25 描述关闭「接线的行为面尚无场景覆盖」的旧话（L2 三件套不动）。
// sourceFiles 增补 src/services/reply/protocol.ts（RUNTIME_DATA 标记唯一定义点）。minScenarios
// 按 L4 场景集实际值校准 25→26、minDeepScenarios 24→25（口径：只数 e2e 层覆盖点落地的场景 ——
// 目录 26 个场景全被本契约 e2e 点引用且 module/contractId 匹配，其中「阶段状态行」为 shallow）。
// ar-01..ar-35 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）。
export const agentRuntimeContract: ModuleContract = {
  module: "agent-runtime",
  sourceFiles: [
    "src/services/engine/plan/checkpoint-store.ts",
    "src/services/agent/runner.ts",
    "src/services/debug.ts",
    "src/services/error/failure-kind.ts",
    "src/services/engine/harness/delivery.ts",
    "src/services/engine/harness/harness-slot.ts",
    "src/services/engine/harness/model-gateway.ts",
    "src/services/engine/harness/runtime.ts",
    "src/services/engine/harness/stream-text.ts",
    "src/services/engine/harness/tool-loop-guard.ts",
    // 2026-10-06 面板上下文占用重启恢复批次补入：「最近一次对话请求」输入量的恢复读取器
    // （provider_usage 快照的选取纪律与排除规则的唯一定义点）；ar-31 的来源。
    "src/services/engine/harness/request-stats.ts",
    "src/services/engine/plan-confirmation.ts",
    // 2026-10-06 提问选择批次补入：提问的回执通道（ar-32）与等待期预算豁免的唯一登记点（ar-33）。
    "src/services/engine/choice-confirmation.ts",
    "src/services/engine/user-wait.ts",
    "src/services/engine/preprocessor.ts",
    "src/services/engine/runtime/input-identity.ts",
    "src/services/engine/runtime/trace.ts",
    "src/services/engine/runtime/types.ts",
    "src/services/humanizer/protocol.ts",
    "src/services/humanizer/scheduler.ts",
    "src/services/humanizer/index.ts",
    "src/services/context/builder.ts",
    "src/services/context/kernel.ts",
    "src/services/context/tool-output.ts",
    "src/services/reply/reminder.ts",
    // 2026-10-06 验收批次补入：RUNTIME_DATA 标记的唯一定义点（零依赖叶子）—— ar-19 的
    // 流式过滤起始标签、ar-24 的协议剥离与 ar-25/ar-37 点名的区块名都从这里取值，
    // 改值 = 改协议（库内消费点见文件头清单）。
    "src/services/reply/protocol.ts",
    "src/services/images/request.ts",
    "src/services/images/paths.ts",
    "src/services/session/manager.ts",
    "src/services/session/messages.ts",
    "src/services/session/persistence.ts",
    "src/services/session/read-model.ts",
    "src/services/session/repo.ts",
    "src/services/session/store.ts",
  ],
  sourceHash: "de2da2fe1e7a4819b66f2b20816abda550d13a25ec51c73bb3c6f6dea4302f5a",
  coverage: [
    {
      id: "ar-01",
      feature: "生产消息入口",
      description: "sendMessage 经预处理、Harness lane 与会话条目持久化走完一个回合；用户正文与助手回复都能按会话 id 从 JSONL 读回恰好一次；可选观测旁路的提交身份由 evaluation 契约独立验证，不取代正文或取消所有权",
      why: "直接调用运行内核不能证明桌宠实际聊天入口仍然可用",
      layer: "e2e",
      depth: "deep",
      scenarios: ["production-chat-entry"],
    },
    {
      id: "ar-02",
      feature: "工具期间的输入先进入 lane 持久 inbox",
      description: "工具执行期间的新输入以 steer 进入 lane 持久 inbox（队列快照可见），消费后正文恰好一次且排在工具结果之后",
      why: "先落盘再影响模型是 H-4 的投递不变量；宿主自建队列删除后只剩这一条路径",
      layer: "e2e",
      depth: "deep",
      scenarios: ["memory-steer-during-tool"],
    },
    {
      id: "ar-03",
      feature: "followUp 通道语义",
      description: "以 followUp 入队的收尾输入由本次运行继续处理，正文恰好一次且排在首个回复之后；工具执行期（streaming）的投递模式必须是 steer，不得冒充 followUp",
      why: "followUp 语义不能被 steer 混淆，也不能在自然结束边界丢输入。注：settling 窗口由 Harness 的 turn_end 事件驱动、无法在场景里稳定命中（旧内核的 markDeliveryPhase 入口已随迁移删除），因此本覆盖点验证的是 followUp 通道自身的语义与 streaming 侧的投递模式判定，不声称验证了 settling 自动路由",
      layer: "e2e",
      depth: "deep",
      scenarios: ["memory-followup-after-turn"],
    },
    {
      id: "ar-04",
      feature: "会话运行槽代际所有权",
      description: "主回合按 sessionId 持有运行槽；代际单调，旧代际不能结束新 run，槽被释放重建后代际也不回退（ABA）；空闲槽的释放请求不因槽在飞而丢弃 —— 忙时登记到槽上，等槽不再被占用时（运行收尾通知或宿主声明的回合终点 end）由注册表收口释放，releaseWhenIdle 返回 false 只表示「本次没释放」；空闲槽上的停止请求如实失败，不返回「已停止、无归还项」的空成功",
      why: "没有代际守卫时迟到的 cleanup 会结束或清空重建后的新运行；释放请求被丢弃则会让「切走会话/清空会话」的收尾永远不生效",
      layer: "e2e",
      depth: "deep",
      scenarios: ["session-harness-slot-generation"],
    },
    {
      id: "ar-05",
      feature: "停止归还",
      description: "显式停止归还未消费输入：以 nextRun 持久保留、不自动继续执行，恢复运行时恰好消费一次",
      why: "停止不能丢用户输入，也不能替用户自动继续剩余话题",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-stop-requeue"],
    },
    {
      id: "ar-06",
      feature: "nextRun 持久 inbox",
      description: "忙碌期间的下一轮输入（如未识别 slash 文本）以 nextRun 入队，不被当前运行消费，下一次运行接受后按序进入上下文",
      why: "排队输入必须有持久归宿且不重复追加用户正文",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-nextrun-inbox"],
    },
    {
      id: "ar-07",
      feature: "用量按 purpose 分列",
      description: "主回合逐请求 usage 记入 main 分项；规划等一次性调用（压缩走同一通道）按自己的 purpose 单独计数，不覆盖主回合的 last/上下文统计，也不计入 main；总量由各分项相加，未回报 usage 的失败调用只计次数",
      why: "一次性调用既不能冒充主回复统计，也不能从总消耗里消失；分别只累加数字会让总量与分项对不上",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-usage-purpose-split"],
    },
    {
      id: "ar-08",
      feature: "显式投递意图与排队视图",
      description: "忙碌时显式选择插话/稍后继续的投递回执与 lane inbox 的 kind 一致（steered/followup），排队视图（listQueuedInputs）按序给出 kind 与正文，并用 loaded 标明镜像是否可信（条目可见时镜像已就绪；不可信时列表为空不代表没有排队项）；单项撤回仍在 inbox 的项返回 cancelled 且不再进入对话，已消费项返回 already_consumed，运行结束后队列为空；结构操作期间的新输入按准入拒绝：不写兜底失败回复、不静默排队",
      why: "投递意图必须由用户显式选择而不是由运行阶段决定；排队状态与撤回结果不能虚构，否则用户会把「已排队」当成「已处理」",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-delivery-intent"],
    },
    {
      id: "ar-09",
      feature: "停止入口与暂停输入",
      description: "生产入口停止运行：归还清单如实、未消费输入停为已暂停、会话里不写兜底失败回复；显式继续把暂停输入按原顺序投递且正文恰好一次，全部丢弃后正文不进入对话；结构操作期间的新输入按准入拒绝：不写兜底失败回复、不静默排队",
      why: "用户能主动停下来是产品承诺；把「我点了停止」记成失败、或让归还输入凭空消失或重复追加，都是对用户说谎",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-stop-entry-resume", "runtime-stop-entry-discard"],
    },
    {
      id: "ar-10",
      feature: "输入投递证据链",
      description: "忙碌投递的输入身份（deskpetEventId）进入落盘的请求快照，阶段查询按既有产物给出 queued → context_committed → request_prepared；responded 只在确有 provider_usage 快照时给出，不凭空升级",
      why: "「已排队」不能当「已处理」：用户与审计都需要能核对这条输入到底有没有进入请求，而不是靠界面文案自我声明",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-delivery-evidence"],
    },
    {
      id: "ar-11",
      feature: "中断运行的继续与丢弃",
      description: "未完成操作在重新附着后默认暂停并暴露中断态：用户选择继续时由未完成操作续跑并产出回复、中断态清除，且续跑前与主回合走同一能力准备入口（重新借用 MCP、按目录指纹核对 Skill 清单），能力不足不以上游「Tool … is unavailable」通用文案上报；选择丢弃时按 aborted 收尾、不重放未知副作用，之后会话照常可用。注：「待重放的工具引用了本次借不到的 MCP 服务器 → 以显式原因失败」这条用户可见路径已由场景 runtime-resume-mcp-unavailable 直接构造并驱动（受控 stdio 假 server：首回合经真链路借用并调用、tools/call 永不回答使工具保持 running；中断期间断开连接表并把服务器命令换成不存在的可执行文件，本次借用确定性地在宿主 spawn 处失败；继续中断运行给出点名原因 —— 服务器名 + 不可用 + 无法重放 —— 真实助手条目落盘、reply 返回、不落上游「Tool … is unavailable」通用文案；恢复失败后中断态仍留给用户选择，按丢弃清理后会话照常可用）；场景另断言恢复后披露块仍含探针技能，并以「冷写落盘 + 前置断言」证明「只有恢复路径自己的准备才能重新加载它」：恢复前绕开 `upsertSkill` 的指纹核对把探针 Skill 的新描述直接写到磁盘，断言此刻披露块仍是冷写前的旧描述（该窗口没有第二个同步调用点会刷新进程快照）；恢复后披露块必须出现仅存在于磁盘的新描述，只有恢复路径自己的能力准备会按指纹重新加载它",
      why: "进程被杀后无人决定的运行既不能自动重放（未知副作用），也不能把用户卡在一个没有出口的中断态里；恢复前能力面必须重新准备，否则续跑会拿中断前的旧能力面去重放",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-interrupt-resume", "runtime-interrupt-discard", "runtime-resume-capability-prep", "runtime-resume-mcp-unavailable"],
    },
    {
      id: "ar-12",
      feature: "空闲输入的持久身份与来源标记",
      description: "空闲路径的用户输入同样带 `deskpetEventId` 身份并进入投递证据链；输入在计划与预检之前提交为会话条目（用户条目 `seq` 早于其 `deskpet.plan_checkpoint`），预检失败时输入条目保留、已接受操作按取消结算。规划回合经生产入口的 `--plan` 强制触发进入 —— 该路径同时验证前缀剥离不得先于复杂度判定（2026-09-24 W5 修正 `runPiAgentTurn` 的剥离时机）；计划段由 `planConfig.enabled` 单独把守（模式已删除、该开关出厂为 true），Live 基线把它钉在 false，要走计划段的场景在 setup 里显式打开",
      why: "P6 的 memory_source 追溯要求用户输入条目自带身份与 eligibleForMemory/taint 标记；裸字符串输入让证据链对空闲发送永远返回 undefined",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-idle-input-identity", "runtime-input-durable-before-plan"],
    },
    {
      id: "ar-13",
      feature: "队列镜像播种与暂停项可见",
      description: "会话槽重开后 lane 持久 inbox 的未消费项立即出现在只读排队视图里（`HarnessSlotSnapshot.queueMirrorReady` 与 `QueuedInputsView.loaded` 都为真、条目 entryId 与关闭前一致），镜像未就绪或仍有排队消息时 `/compact` 按未压缩拒绝，不驱动无宿主 spec 的续跑",
      why: "重启后暂停项必须可见，压缩守卫不能把空镜像当成没有排队",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-queue-mirror-seed"],
    },
    {
      id: "ar-14",
      feature: "回合读模型显示语义",
      description: "中止/出错的助手条目不进聊天视图（实时与重读共用 `isAssistantEntryVisible`），用户主动停止不会在重启后冒出半截气泡；系统提示以 `deskpet.system_message` 自定义条目落盘并可回读，该条目不进模型上下文",
      why: "停止后看到从未展示过的半截气泡、或系统提示只活在内存里，都是对用户与审计说谎",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-aborted-assistant-hidden"],
    },
    {
      id: "ar-16",
      feature: "计划回合的 RUNTIME_DATA 变量写入",
      description: "计划回合的 RUNTIME_DATA 按结算正文配对写入：主回合（即使带 toolCall）写入变量并可按 stages 文件回读，展示正文不含协议块；步骤子代理不写变量，被剥离的原始正文随 deskpet.plan_step_result 留证",
      why: "只在「无 toolCall 的回合」配对会让带工具调用的主回合静默丢失变量写入，而这一步只能靠端到端场景验证",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-plan-step-variable-write"],
    },
    {
      id: "ar-17",
      feature: "取消域级联",
      description: "工具执行中停止：停止同时终止在跑的计划与它的子运行（子槽随父槽级联取消），归还清单如实，停止后不再产生新的工具结果条目，独占额度回到空闲，下一回合照常可用。注：本覆盖点的场景不驱动计划，级联本身（计划与子运行同时停）未由场景断言 —— 断言的是同一条父槽停止通道上的不变量（无新工具结果条目、额度回空闲、归还清单如实、没有计划在跑时 planAborted 如实为 false）",
      why: "「停止」必须真的停下正在跑的计划与子代理：否则用户点了停止，界面说没有正在进行的回复，步骤却还在继续执行",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-stop-no-new-tool-end"],
    },
    {
      id: "ar-18",
      feature: "生成级重试策略按运行同步",
      description: "改 ai.loop.maxRetry 后，同一次运行槽在下一次 run 前把新 RetryPolicy 下发给 Harness：无需重开槽，重试次数按新值生效",
      why: "策略只在 create 时下发会让设置页的改动看起来生效、实际要重开会话才起作用",
      layer: "integration",
      depth: "deep",
      scenarios: ["memory-retry-policy-sync"],
    },
    {
      id: "ar-15",
      feature: "结构操作（手动压缩）的准入与续跑收口",
      description: "手动压缩按 lane 真相判准入：lane 持久 inbox 里有排队项时回执按 kind 列出排队明细并拒绝，宿主队列镜像为空不作为放行理由；镜像未就绪（开槽播种失败）时按未压缩失败拒绝，不把空镜像当「没有排队项」（该分支未由场景单独驱动）；被拒时压缩与其后的续跑都不发生（无 compaction 条目、无新增 assistant 条目），排队正文不进会话正文并仍留在 lane 里，由下一个显式回合恰好消费一次",
      why: "压缩期的 lane 操作必须算「忙」，续跑也不能在没有宿主 spec 的情况下执行 —— 压缩后的续跑没有回合身份（人格前缀、请求投影、RUNTIME_DATA 剥离与结算都不在），把它的消费报成「压缩完成」会让用户以为排队输入已被处理",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-manual-compact-pending-guard", "runtime-compact-admission"],
    },
    // ar-15 原把「准入与续跑 + 挂起结算」合成一点（跨层混搭）；按层拆开：挂起结算侧为 ar-22（L3），准入与续跑侧留在 ar-15（L4）。
    {
      id: "ar-22",
      feature: "未预期延迟响应的挂起结算（含压缩续跑收口）",
      description: "运行遇到上游未预期的延迟响应（suspended）时按失败如实结算并取消该 lane 操作，不挂死：waitForIdle 有界返回、下一次运行不被判忙。普通回合由 runtime-compaction-suspended-settles 驱动（错误文案如实、操作被取消结算）。压缩续跑（没有宿主回合的那次续跑消费）的同款异常面已由场景单独驱动，两种异常形态归宿不同：续跑以任一已结算形态返回（completed / failed / aborted / declined）时不报「压缩完成」—— 它若已结算，压缩结果不可能进入任何回合结算与 UI —— 按 failed 收口并落 `deskpet.compaction_continuation` 审计条目（sessionId + operationId + 终态，flush 后按 customType 可回读），runtime-compaction-continuation-settled；续跑返回不支持的 suspended 形态时不落审计条目，而是显式 `lane.abort` 结算该操作（恰好一次）、如实失败（「不支持的延迟响应」），收口后 hasOpenOperation 归假（悬挂操作不再把后续准入挡住），runtime-compaction-continuation-suspended",
      why: "只返回 failed 而不结算 lane 操作会让槽背上一个永不结算的操作：一次上游迟响应不能把会话永久判忙；压缩续跑没有宿主回合，已结算/悬挂两种形态都不能被当成「压缩完成」——前者让压缩结果悄悄消失、后者让会话恒判忙",
      layer: "integration",
      depth: "deep",
      scenarios: ["runtime-compaction-suspended-settles", "runtime-compaction-continuation-settled", "runtime-compaction-continuation-suspended"],
    },
    {
      id: "ar-19",
      feature: "流式展示的消息边界",
      description: "assistant 消息边界无条件重置瞬时展示过滤器：以 RUNTIME_DATA 开头的消息之后，同回合后续消息的正文仍进入 deskpet-assistant-stream",
      why: "过滤器不重置会让同回合后续正文全部静默消失",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-stream-reset-tool-round"],
    },
    {
      id: "ar-20",
      feature: "阶段状态行的语义 key 事件",
      description: "回合开始（含工具轮之间的每一次 turn_start）经 deskpet-stage-hint 事件发出 thinking 语义 key，负载不含任何文案 —— 文案由界面按当前 Card 取（引擎不持有第二份台词）。事件只发给发起回合的会话，非活动会话收不到",
      why: "引擎一旦改成发硬编码文本，Card 的定制语气就静默失效且界面看不出差别；反过来，不发事件会让状态行永远停在上一条工具提示上",
      layer: "e2e",
      depth: "shallow",
      scenarios: ["runtime-stage-hint-thinking"],
    },
    {
      id: "ar-21",
      feature: "技能显式调用的准入回合",
      description: "`/skill <技能名> [额外指示]` 走同一条生产入口启动技能：命令层只交出准入意图（预处理返回 `handled:false` + `skillAdmission`，不当成「已处理的文本」短路），落盘与驱动由运行入口完成 —— lane 的技能资源清单先于 `accept` 下发（清单取自技能目录指纹核对入口的生效快照），那条 `role:\"user\"` 正文由 Pi 在 `accept` 内按技能文件构造并提交，所以这条回合不给 `deskpetEventId` 身份、不再追加第二份宿主正文与用户气泡、也不产生投递证据（条目不是宿主构造的，套一份身份只会造出查不到的假证据）；条目提交成立后才按当前 Card 报一次 skillStarted 系统消息。忙碌（lane 上还有未结算操作）时启动不了技能：按并发拒绝如实回复、不谎称已启动、也不把字面 `/skill …` 当普通文本投进 lane，且不落技能输入条目 —— 运行入口不为技能支构造宿主正文、Pi 那条按技能文件构造的用户条目也不会提交，会话里只新增一条并发拒绝的系统消息（`deskpet.system_message`）；准入在边界上失败（清单在启动瞬间变化 → UnknownSkill）按 admission 失败 + llmUnavailable 兜底结算，留痕带技能名。命令层的参数解析与「未知名 / 被关闭 / 无正文」三种终态句不在本覆盖点（属斜杠命令面，且该面暂无契约覆盖）。注：本点由场景 `技能准入.scene.ts` 覆盖（caseId `runtime-skill-admission`）",
      why: "技能是用户显式启动的一次输入，但它的正文不由宿主提供：把「已启动」当成一条文本命令的回复、或给 Pi 构造的条目套一份查不到的身份，都会让证据链与用户看到的东西对不上；而忙碌期把它当普通文本投进 lane 会让模型看到命令行而不是技能正文",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-skill-admission"],
    },
    {
      id: "ar-23",
      feature: "辅助模型路由",
      description: "子运行的模型取辅助模型：`ai.auxModel` 留空或与聊天模型同名时回落主模型解析（测试注入的生效模型照常生效），非空时经同一网关（同 provider/endpoint/apiKey）按目标模型 id 解析；`resolvePiAuxModel` 是唯一解析入口，`runPiSubAgent`（agent_spawn 的 fork/team、计划步骤、主动扫描规划共用这一个出口）与 dreaming Review 的模型都从它冻结。请求落在哪个模型从 fork 通路的真实请求载荷断言（fake provider 记录的 `payloads[].model`）：留空/同名落聊天模型、非空落辅助模型；dreaming 的接入与子运行共用同一入口，其请求模型不在本场景断言",
      why: "整个运行时一个模型会让便宜模型无法用于子代理与离线整理、推理模型的后台 token 白烧；路由必须收在单一解析入口，否则每个子运行调用点都会漂移出第二份模型选择逻辑",
      layer: "integration",
      depth: "deep",
      scenarios: ["aux-model-routing"],
    },
    {
      id: "ar-24",
      feature: "拟人表达的提交与请求投影",
      description: "启用拟人表达后，after_response 先剥离 RUNTIME_DATA 再把 SPLIT 标记（casual 流无标记时空行分段同效，单个换行与含代码块的消息不分）写成同一原生助手条目的多个 text part，原始配对仍使变量写入落池；合法 casual SILENT 写成 completed 空助手条目并带可核验语义标记，读模型与后续 Provider 请求省略它，跨进程连续沉默护栏从该原生标记重建；用户图片只以 deskpetImagePaths 元数据落盘，请求投影才读文件形成真实 image part，base64 不进入原始 JSONL；task 流由真实工具调用记录分流，task 输出的 SILENT 改为 Card 短回复且不启动 casual 揭示",
      why: "拟人标记、空白沉默与图片字节必须只改变请求/展示视图，不能破坏变量通道或把 transient 表达数据变成第二份持久事实",
      layer: "integration",
      depth: "deep",
      scenarios: ["humanizer-native-commit-projection"],
    },
    {
      id: "ar-25",
      feature: "RUNTIME_DATA 协议提醒的挂起、文案与注入",
      description: "协议提醒按会话收敛：markRuntimeDataMissing / clearRuntimeDataMissing / hasRuntimeDataReminder 以 sessionId 为键、进程内存不落盘，A 会话违约不提醒 B 会话；提醒文案 RUNTIME_DATA_REMINDER_TEXT 点名 RUNTIME_DATA 区块。buildPrompt 只在调用方传入可选入参 runtimeDataReminder 时产出一个 ephemeral:runtime-data 块（text 与传入值逐字相同、进入 systemPrompt 请求视图），不传时该块不存在。结算侧 mark/clear（完成回合缺区块标记、履约或无可写变量清除）与下一回合注入判定在 engine/harness/runtime.ts —— 本点的 L2 用例只验证状态、文案与请求视图三件套；该接线的行为面（违约挂起 → 下一回合请求真的带提醒 → 履约/空区块清除后不再带）已由 ar-37 的 L3 用例直接驱动",
      why: "提醒是「上一回合违约」到「下一回合补一句」的唯一补救通道：状态不按会话隔离会提醒到别的会话，块无条件产出会让每回合都多一段本不该出现的协议要求，文案不点名区块则模型无法照做",
      layer: "unit",
      depth: "deep",
      scenarios: ["variable-runtime-data-reminder-state", "variable-runtime-data-reminder-text", "variable-runtime-data-reminder-block"],
    },
    {
      id: "ar-26",
      feature: "子运行的 provider 准入与聊天不可见",
      description: "runPiSubAgent（规划 / 计划步骤 / 子代理的共同出口）的两条接线契约：① provider 准入必被咨询 —— beforeProvider 经 createTurnSpec 的 providerAdmission 转发进请求视图 hook（与主回合的 activeAdmission 并列、互斥使用），在请求发出前恰好咨询一次；回调拒绝时一个真实 provider 请求都不发（fake provider 的 payloads 为空、运行以失败收口）。根因（2026-10-06 真机）：参数类型缺 providerAdmission / disableAutomaticCompaction 字段而调用点用 spread 传参 —— 对象字面量的 spread 不参与多余属性检查 ⇒ 字段被静默丢弃 ⇒ 规划器的 claim 从不发生（去重表永远为空、每个 tick 白发一次真实请求）、disableAutomaticCompaction 也没生效；两者由同一处转发修复收口（隐式压缩开关本身未由本点断言）。② 子运行对聊天界面不可见 —— createTurnSinks(visible=false) 下带工具调用的过程消息、工具结果与流式草稿 / stream-end 都不进活跃会话的可见列表与瞬时尾巴（子运行槽不落盘，推出去的气泡会在读模型重载时整体消失），断言子运行跑完「工具轮 + 收尾轮」后可见列表仍为空；阶段提示与工具过程文案照常发（过程可见性的显示位是顶栏）。两条 caseId 均已做「退回修复看它红」的区分力验证（改前分别红在 consulted=0 与「多出恰好 2 条消息」）",
      why: "接线断了不会抛错：spread 丢字段是静默的（每个 tick 真花一次 provider token、claim 与两层去重表永不落库，且旧路径连 trace 都没有），子运行共用主回合 sinks 则把不可持久的过程气泡推给用户再整体消失（真机「几条 AI 消息闪一下就没」）—— 两条都是「不报错但行为全错」的形态，只能在真实子运行出口上用「请求数为零」「可见列表为空」这类反向判据钉住",
      layer: "integration",
      depth: "deep",
      scenarios: ["subagent-provider-admission", "subagent-chat-invisible"],
    },
    {
      id: "ar-27",
      feature: "工具循环病理检测的阈值与重置（纯逻辑）",
      description: "ToolLoopGuard 的判据（零依赖叶子，只产出判据与中性文案，不投递、不持有回合状态）：同参重复 = 同工具 + 键排序 JSON 参数签名（对象键序不影响签名，不同工具或不同参数即不同签名）的连续调用，第 3 次软、第 5 次硬，出现不同签名即重置连击；连续失败 = 工具结果 isError 的连续次数，第 3 次软、第 5 次硬，一次成功清零。noteCall（调用门）返回整回合判据：两条连击取更强的一档，同级时取失败连击；noteResult（结果侧）只报失败连击、不合并同参连击（同参账在调用门记，不在结果侧重复入账）。每回合重置 = 新建实例：新实例不继承上一回合的同参与失败连击。阈值 3/5 是具名常量（来源 Cline 默认值），L2 用例按契约手写期望、不 import 实现常量",
      why: "计数上限取消后死循环只剩这道防线：阈值或重置点被改坏（3→2、5→4、漏掉成功清零、签名退化成只比工具名）会让硬终止要么早早误伤正常回合、要么永远不来，而两种偏差都不报错",
      layer: "unit",
      depth: "deep",
      scenarios: ["tool-loop-guard-failures", "tool-loop-guard-repeats", "tool-loop-guard-mixed", "tool-loop-guard-reset"],
    },
    {
      id: "ar-28",
      feature: "工具调用计数上限的口径（主回合无 / 子运行保留）",
      description: "主聊天回合不再有工具调用计数硬上限：回合驱动（`runPiAgentTurn` 的回合 spec）与中断续跑（`continueInterruptedRun`）都不给 createTurnSpec 传 maxToolCalls，超过旧默认值（5）的连续调用全部真实执行、以模型正文自然收尾（不是 toolLoopMaxRounds 兜底文案）、工具历史没有 blocked —— 自然出口 = 模型不再调工具，兜底防线是 ar-27 / ar-29 的病理检测。无人值守子运行保留计数封顶：runPiSubAgent（计划步骤 / 主动规划 / fork·team 的共同出口）仍传 maxToolCalls = input.maxRounds ?? 3，达到上限的那次调用在调用门被拦下（记 blocked）、不再发起下一次请求，运行按 completed 收口（子运行自身收尾走无结果兜底；toolLoopMaxRounds 是主回合的治理文案）。agent 子代理的轮数映射在 `agent/sub-agent.ts`（取 `ai.loop.subAgentRounds`，原 `ai.loop.maxToolCallsPerTurn` 改名、默认值 5 不变），不在本契约 sourceFiles",
      why: "上限口径从「所有回合的计数封顶」改成「只给无人值守子运行封顶」是行为反转：主回合误留封顶会把长任务掐断（旧默认 5 次），子运行误删封顶则让无人值守的调用失去上界",
      layer: "integration",
      depth: "deep",
      scenarios: ["tool-loop-main-no-count-cap", "tool-loop-subagent-cap-kept"],
    },
    {
      id: "ar-29",
      feature: "病理检测的接线（软提示与两条硬终止路径）",
      description: "createTurnSpec 每回合新建 guard 与 toolLoopNotices（回合级内存态、不落盘；子运行也吃这套检测）：软档（同参或失败连击第 3 次起）产出的中性提示（非 Card 台词）经投影出口与地址标注同一通道附到该条工具结果正文，跨请求持续存在（后续每一笔请求里的同一结果都带），多 text 块结果整条只拼在最后一个 text 块一次（不逐块重复），阈值之前的结果不带提示；硬档两条路都置同一枚 stoppedByToolGovernance 停止标志，主回合由 settleMainTurn 早退到 Card 的 toolLoopMaxRounds 兜底收尾（子运行收尾走自身出口）：同参连击在调用门 block + terminate（该次调用不执行、历史记 blocked、不再发下一次请求），失败连击在结果侧经 after_tool 的 terminate 立即终止（失败工具照常走到 after_tool；批内全部调用都带该标记时上游在当前批次后结束运行，混批时标志已记下、模型再调工具由下一次调用门拦下，第 5 次失败后不再发请求、历史不出现调用门的 blocked 记录）。每回合重置由新建实例承载：同一会话两个回合各自从零累计，第二回合不继承第一回合的连击。子运行（runPiSubAgent）的请求投影关闭（projectToolResults=false）：软提示不在请求视图里附着（无处可附），但判据与硬终止照常生效 —— maxRounds 封顶够不着时，同参连续第 5 次在调用门被 block + terminate（先于子运行轮数封顶收口）",
      why: "判据之外，提示与终止都由接线承载：提示挂错出口模型看不到、终止漏挂则该停不停（fail-open）、每回合重置若丢则正常会话会被跨回合累计冤枉硬终止；after_tool 的 terminate 是「模型不再调工具时也能收手」的唯一出口",
      layer: "integration",
      depth: "deep",
      scenarios: ["tool-loop-repeat-hard-termination", "tool-loop-failure-hard-termination", "tool-loop-soft-notice", "tool-loop-notice-multi-block-once", "tool-loop-per-turn-reset", "tool-loop-subagent-guard"],
    },
    {
      id: "ar-30",
      feature: "AI 生成锁由回合状态推导（无定时器）",
      description: "isAIGenerating() = HarnessSlots.isTurnActive() = 已受理未交回的回合（admit 计数 > 0）或任一运行槽在飞；没有第二个可写布尔、没有定时器 —— 旧的 ai.lock.safetyTimeoutMs 安全超时强制解锁随 src/services/cooldown.ts 整模块删除。三个回合入口（sendMessage 的 dispatchMessage、resumePausedInputs、sendActiveMessage）在 begin() 成功后、该回路首个 await 之前受理（admit 凭据），同一回路的 finally 交回（endAdmission）。行为面（L3）：长回合在飞时恒为 true，假时钟跨过旧 30s 时限仍不放行；成功与失败（stopReason:error）回合结束后都归 false（异常路径不泄漏受理）；回合在飞时重置运行槽（reset 清空槽表、isAnyRunning 瞬时为 false）后锁仍为 true —— 受理计数独立支撑「槽已释放/重置、回合尚未交回」的窗口，回合交回后归 false。另外两个入口同样被钉住：resumePausedInputs（停止后继续，真 Provider 请求被闸门扣住时锁为真；成功与失败结算都归假；无暂停项的提前返回发生在受理之前，不触碰锁）与 sendActiveMessage（主动表达，请求在飞时锁为真；提交、受理之后复核为过期的提前返回（skipped/stale）与 Provider 错误结算都经 finally 归假；不新鲜 owner 在受理之前被拒绝）",
      why: "锁是「不打搅用户」的门禁：定时器强解会打断长回合；只把槽状态当唯一判据会在「槽已释放/重置但回合尚未交回」的窗口误判空闲，让后台任务插进正在生成的回合",
      layer: "integration",
      depth: "deep",
      scenarios: ["ai-lock-long-turn-holds", "ai-lock-error-turn-releases", "ai-lock-admission-survives-slot-reset", "ai-lock-resume-pairing", "ai-lock-resume-error-pairing", "ai-lock-active-pairing"],
    },
    {
      id: "ar-31",
      feature: "详情面板上下文占用的重启恢复（从会话快照读回）",
      description: "面板「上下文 X%」的读数跨重启不归零：`restoreLastRequestStats` 从活跃会话读回「最近一次对话请求」的真实输入量并写回 lastPromptTokens / lastContextUsage —— `readLastConversationPromptTokens` 沿会话条目倒序，只认 captureStage=provider_usage、request.purpose=turn、requestId 不以 sub-agent- 开头、agentMessages 无 active origin、actualInputTokens>0 的快照（与实时写入点的选取纪律逐条对齐）；恢复值与实时链路读数一致，且该读数确实以 provider_usage 快照落在会话文件里（测试侧独立解析 JSONL 取证）；取最后一次对话请求（不是第一条），三类同形快照都不参与 —— 主动表达回合（origin 全 active）、计划步骤子运行（requestId 前缀 sub-agent-）、一次性文本调用（purpose one_shot）；读不到真实读数（新会话 / 从未对话 / 全部未回报）时保持 null（面板显示「—」，Dim），不回落成 0。占比与实时共用 contextUsagePercent 单一计算点（分母 contextMaxTokens、读不到好值时回落配置默认）。注：用例直接调用 restoreLastRequestStats ——「引导期由 initDebug 调用」与「已有本进程读数时不覆盖（实时读数更新优先）」两条接线口径、以及宿主侧对 null 的渲染（不显示 0%）不在本点断言（渲染由 Rust 内联单测覆盖，不带契约 caseId）",
      why: "重启后显示「上下文 0%」是把「未知」谎报成「上下文是空的」（2026-10-06 用户报告的形态）；恢复值必须与实时口径同源同值、选取纪律与实时写入点逐条对齐，否则面板会在重启前后显示两个不同的数字；读不到时必须如实未知，不能拿 0 冒充",
      layer: "integration",
      depth: "deep",
      scenarios: ["context-usage-restore", "context-usage-restore-picks-last-formal", "context-usage-unknown-stays-null"],
    },
    {
      id: "ar-32",
      feature: "提问选择的回执通道与归宿（ask_user 的 UI 桥）",
      description: "choice-confirmation.ts 是提问的会话键控通道（与 plan-confirmation 同构、按 requestId 键控且**可并发多条**，刻意不设单槽）：提问经 deskpet-choice-start 原样发出（sessionId/requestId/question/options）；回执 deskpet-choice-resolved 三种取值各有归宿 —— picked 结算出**所选项原文**（索引在域内校验，越界回执按协议违规丢弃、不结算）、other 结算为「用户用自己的话回答」（自由原文不经通道回传、以下一条消息到达主回合）、cancelled 结算为用户取消；未知 requestId 是 no-op，同 requestId 重入把旧的那份按 session_switched 结算掉（不悬挂）。逃生口（面板没送到/用户离开）：发布失败立即按 emit_failed 结算并发收尾事件；signal abort（用户停止回合/回合失效）按 session_switched 结算；cancelSessionChoices 只取消目标会话的待答、逐条发 deskpet-choice-end（别的会话不受影响）。第四种归宿 user_replied 走非回执入口：用户不回面板、直接在输入框发消息，投递被接受后该会话的待答提问按 user_replied 结算 —— 面板收起（deskpet-choice-end）、工具结果如实说明「用户没有在面板中选择，而是直接发来了一条消息」（不出现任何选项原文、不冒充点选），直发消息照常随下一次请求到达模型；没有待答提问时直发消息不产生任何 choice 事件；只取消提问通道的待答 —— 权限确认面板（自己的单槽通道）不被误伤、仍由自己的回执结算",
      why: "提问是模型据以继续的直接输入：回执若不校验身份/下标就会把非法值当成用户选择；「其它」的自由原文若被通道截留或编造，模型与用户会看到两个不同的事实；没有等待超时（ar-33）之后，逃生口是唯一的悬挂保险，必须逐条可证",
      layer: "integration",
      depth: "deep",
      scenarios: ["choice-receipt-start-picked", "choice-receipt-other-cancel", "choice-receipt-invalid-dropped", "choice-emit-failure-settles", "choice-signal-abort-settles", "choice-session-cancel", "choice-same-id-reentry", "ask-tool-direct-reply-cancels-panel", "ask-tool-direct-reply-no-panel", "ask-tool-direct-reply-keeps-permission"],
    },
    {
      id: "ar-33",
      feature: "决策类弹窗不留等待超时，等待期豁免回合预算",
      description: "「等用户做决定」的面板（计划确认 / 步骤裁决 / 权限确认 / 提问）一律**没有等待超时**（2026-10-06 用户裁决：用户想多久想多久）：假时钟推进 10 分钟，四种等待仍是 pending（本点覆盖计划确认与步骤门、提问两条通道，权限确认通道的同形对照归 safety 的 sf-24），本地视图不被计时器清掉；等待期间该会话的**回合墙钟与工具超时一起停表**（engine/user-wait.ts 是唯一登记点：等待方 begin/release 引用计数，HarnessSlot 的墙钟与 ToolRouter 的超时按会话挂起、结算后按剩余预算续算），计划时限按累计等待扣除。行为证据：回合墙钟压到 1.5s、用户停留 2.2s 后作答，回合仍以模型正文正常完成（去掉停表即红）。归宿只来自明确事件 —— 回执、取消信号、会话切换/关闭、下发失败；面板被新决策顶掉按拒绝/取消结算",
      why: "删掉面板超时后仍有两条倒计时会打断用户（回合墙钟与工具超时），它们必须一起豁免，否则「想多久想多久」只是表面成立；反过来豁免不能把「面板没送到」也豁免掉 —— 逃生口由 ar-32 与权限桥的下发失败归宿承接，两条一起才是完整的可用性契约",
      layer: "integration",
      depth: "deep",
      scenarios: ["plan-confirm-no-wait-timeout", "choice-no-wait-timeout", "ask-tool-wait-exempts-turn-budget"],
    },
    // 2026-10-06 契约账本批次（analyze 手工核对）：新增 ar-34 —— 此前「工具过程文案改推顶栏」
    // 只有实现（runtime.ts 的 emitToolStageTitlebar）没有 caseId / coverage 声明（未完成总表
    // 的记账缺口）。归属 agent-runtime 而非 humanizer 的判断：这是 runtime 内核的过程状态
    // 推送（与 ar-20 的阶段提示语义 key 同族，runtime-contract.md 把「阶段提示 + 工具过程
    // 文案」记为同一条顶栏运行过程状态、Node 侧统一接线）；humanizer 契约自己的批次注释
    // 已记明「runtime 的新增推送不改其职责边界」，其 hz-03/hz-04 承担的是调度器揭示与
    // 生产入口链路。行为证据：test/integration/agent-runtime/工具过程顶栏推送.test.ts。
    {
      id: "ar-34",
      feature: "工具过程文案的顶栏推送（与阶段提示共用 owner 与释放点）",
      description: "主回合的工具过程文案只走顶栏：beforeTool 在调用门放行后、工具执行前发 executing，onToolEnd 按结果发 done / blocked（失败），文本取当前 Card 的 getStagePrompt(key, \"\") —— 进程级 _default 一条，不按工具自身类别细分（探针声明 fs.read 类别，顶栏文案仍是 _default）；写入与阶段提示同一个 owner（agent-process:sessionId:generation，priority 20），回合收尾的 finally 释放该 owner，顶栏不再持有过程文案。证据：test/integration/agent-runtime/工具过程顶栏推送.test.ts 用记录型渲染监听收顶栏文本序列（成功回合 executing → done、失败回合 executing → blocked，回合收尾后真值点不再持有过程文案；改坏推送点、把 key 传反、按工具类别取文案或另立不释放的 owner 都会红）。聊天窗底部状态位不再承载过程文案（用户规则 2026-10-05）",
      why: "过程状态只有一个显示位（顶栏）：接线断了用户全程看不到工具过程文案，另立 owner / 不释放则把顶栏永久钉在最后一条过程文案上——两种都不会抛错，聊天记录里也看不出来；按工具类别取文案还会让「进程级」这条口径静默漂移",
      layer: "integration",
      depth: "deep",
      scenarios: ["tool-stage-titlebar-sequence", "tool-stage-titlebar-blocked"],
    },
    // 2026-10-06 契约账本批次（同批）：新增 ar-35 —— 详情面板统计口径的 L2 用例
    // （test/unit/agent-runtime/debug-request-stats.test.ts）此前不携带 caseId（有实现无契约
    // 覆盖，agent-runtime 的 2026-10-05 收尾复查注释里登记为已知缺口），本批补锚点。宿主显示
    // 与重启恢复链在 ar-31；本点只钉写入侧口径。
    {
      id: "ar-35",
      feature: "详情面板逐请求统计的真实输入量口径（写入侧）",
      description: "updateRequestStats 的三条口径：① 真实 prompt 总量 = input + cacheRead + cacheWrite（pi-ai 把 input 归一为**缓存未命中**部分，只取 input 会把带缓存命中的请求低估一个数量级）；② 上下文占比（lastContextUsage）以真实值为分子、contextMaxTokens 为分母；③ Provider 未回报（全 0 行）才退回 system + conversation 估算，且全 0 不覆盖上一次的真实值（0 不冒充「上下文是空的」）；缓存写同样计入真实 prompt。caseId 三条（debug-request-stats-cache-inclusive / -fallback-estimate / -cache-write），期望值由用例手写、与估算值刻意可区分",
      why: "面板读数是用户判断上下文占用的唯一依据：漏计缓存命中会让读数低一个数量级（2026-10-05 用户报告「token 计算有问题」的根因），0 覆盖真实值则把「这一笔没回报」画成「上下文变空了」",
      layer: "unit",
      depth: "deep",
      scenarios: ["debug-request-stats-cache-inclusive", "debug-request-stats-fallback-estimate", "debug-request-stats-cache-write"],
    },
    // 2026-10-06 验收批次新增：ar-36 —— 回合失败兜底文案的持久写入失败（persistFailed 消费链）。
    // 此前「界面看到了、盘上没有」这条静默不一致没有任何覆盖点：settleMainTurn 的失败兜底
    // 回复与 runner.pushTurnOutcome 的透传/提示是本批补测的行为面。
    {
      id: "ar-36",
      feature: "回合失败文案的持久写入失败与恢复（persistFailed 消费链）",
      description: "结算兜底文案的持久写入失败被如实处置，不吞、不重放、可观测：settleMainTurn 的失败兜底回复经会话唯一物理持久边界（appendFile → JSONL 一行事务）写入失败时，回合仍按失败分类正常结算（不抛错吞回合），返回的可见回复仍是兜底文案（界面不会看不到回复），同时置位 SendMessageResult.persistFailed；盘上没有那条文案（原始 JSONL 无该内容、读模型不把它记成助手条目，用户的输入在故障前已落盘）；runner 补一条统一系统消息（「这条回复没能写进会话文件…」）并把事实透传为 persistFailed（宿主据此提示用户）。恢复面：第 0 步是宿主显式放掉已密封的故障槽（`harnessSlots.dispose`；上游 fault 后该会话停止被驱动，产品侧目前只有删会话会释放——「下一条用户消息自动重开」尚未接线，属已知缺口并登记在未完成总表）；其后故障只影响那一条文案 —— 下一代运行照常落盘、失败写入不被重试重放也不顶掉新状态（放掉会话句柄后从盘上重放，两轮用户输入与恢复回合的助手条目各自恰好一次）；系统的故障提示在下一个运行收口 flush 时落盘，重开后仍可回读。故障注入点在 NativeExecutionEnv.appendFile 这一条物理边界上（内容命中兜底文案才失败），不 mock 业务方法 —— 那会伪造助手结果、错位「界面看到了、会话文件里没有」这条要证的事实",
      why: "「界面显示了、盘上没有」的静默不一致必须可观测：不置位 persistFailed 会让宿主把「没写进去」当成功、用户重开应用后发现自己没收到过回复却查无此事；把失败向上抛或允许重试重放会二次污染会话；没有系统消息则故障只留在日志里",
      layer: "integration",
      depth: "deep",
      scenarios: ["runtime-reply-persist-failure", "runtime-reply-persist-failure-recovery"],
    },
    // 2026-10-06 验收批次新增：ar-37 —— ar-25 自述缺口的关闭。L2 已覆盖状态函数、文案与
    // buildPrompt 的请求视图三件套；本点补「结算侧真的 mark/clear、下一回合真的把提醒传进
    // 请求」这段接线（test/integration/agent-runtime/RUNTIME_DATA提醒接线.test.ts）。
    {
      id: "ar-37",
      feature: "RUNTIME_DATA 提醒的结算接线（挂起 → 下一回合注入 → 履约/空区块清除）",
      description: "提醒的整条接线以真实请求的 systemPrompt 为终审面（场景自装 fake Provider 抓取每次请求进入 pi-ai 前的 context.systemPrompt；installFakeProvider 的 payloads 不含 systemPrompt，不能拿它断言）：违约回合（缺区块 + 声明了 llm 可写变量）结算后，下一回合的请求必须携带 RUNTIME_DATA_REMINDER_TEXT；无挂起状态的回合请求不带（提醒不被无条件注入，否则变成每回合常驻）；履约回合（带区块、变量写入落池且有 runtimeData 回传为独立证据）结算后清除，再下一回合不再携带；空区块（有区块、无内容）按既有判定算履约 —— 结算清除已挂起提醒、不产生任何变量写入、也不在下一回合重新注入。空区块的判定语义（hasBlock/履约）由 variable-pool 的 vp-23 L2 用例覆盖，本点只钉接线：mark/clear 与 buildPrompt 传参任一处断开都红",
      why: "状态函数与请求视图三件套各自绿着，接线断开也不会报错：漏 mark 提醒永不出现（模型一直违约无人纠正）、漏 clear 提醒变成每回合常驻的噪声、把空区块当违约会反复骚扰已履约的模型 —— 三种偏差都只能在真实请求的 systemPrompt 上看见",
      layer: "integration",
      depth: "deep",
      scenarios: ["variable-runtime-data-reminder-wiring", "variable-runtime-data-reminder-empty-block-wiring"],
    },
  ],
  // W0–W7 把 ar-18 / ar-22 的 memory-retry-policy-sync、runtime-compaction-suspended-settles
  // 迁出 L4 后按 L4 侧当前值重标定：门槛=当前 rules 声明值，只缩不放（数字由 checker
  // 报错提供）；跨层完整性（迁出点有没有被声明层真的跑着）由 checkLayerCoverage 负责。
  // 2026-10-06 验收批次按 L4 场景集实际值校准：ar-11 并入 runtime-resume-mcp-unavailable 后，
  // 本契约 e2e 点引用的场景共 26 个（test/e2e/scenes/agent-runtime/ 目录 26 个场景全部被引用、
  // module/contractId 匹配），其中 deep 25（「阶段状态行」为 shallow）。
  rules: { minScenarios: 26, minDeepScenarios: 25, requireBoundary: true, requireErrorPath: false },
}

export default agentRuntimeContract
