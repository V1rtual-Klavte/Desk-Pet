// 2026-10-06 验收批次：声明更新，sourceHash 批量刷新（主会话统一复算）。
// 2026-10-05 本批复查与刷新：契约 sourceFiles 里仅 runtime.ts 变化（另一会话同批写入：
// 工具过程文案新增 emitToolStageTitlebar 改推顶栏）；pl-01..pl-12 逐点核对实现点仍在、
// 语义未变（计划段与逐步门路径不受工具顶栏推送影响）。本批刷新同时包含另一会话对
// runtime.ts 的改动；主会话只做了「coverage 描述与当前实现一致性」的核对（不是逐行行为
// 审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：runtime.ts 再次变化 —— RUNTIME_DATA 协议缺失检测与提醒
// 接线。pl-01..pl-12 的计划判定、生成、执行、确认与逐步门路径逐点核对不受影响（提醒只作用于
// 主请求的请求视图，不改计划相位与通道），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// 计划判定、生成、执行、确认与逐步门路径不受影响）。pl-01..pl-12 逐点核对实现点仍在、覆盖
// 描述与当前实现一致。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与当前实现
// 一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志；计划判定、生成、执行、确认与逐步门路径不受
// 影响）。pl-01..pl-12 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（计划步骤子运行同样走 invisible sinks 与准入转发
// 修复；pl-06 的步骤顺序/记账/onStepNotice 口径未动）。pl-01..pl-12 逐点核对实现点仍在、
// 覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（估算偏差对账口径；计划生成/执行口径未动）。
// pl-01..pl-12 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码
// 刷新 sourceHash。
// 2026-10-06 工具循环治理批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（createTurnSpec 的 maxToolCalls 可选化只影响主回合：
// runPiAgentTurn / 续跑不再传计数上限，runPiSubAgent 仍按 `input.maxRounds ?? 3` 封顶；
// 计划步骤经 planner.ts:461 传 `maxRounds: config.stepMaxRounds`，封顶数值未动；
// 病理检测主回合与子运行同吃（子运行比计数封顶更早收口属收紧），计划的相位、确认、进度与
// 逐步门通道未动）。pl-01..pl-12 逐点核对实现点仍在（evaluateComplexity / generatePlan /
// executePlan / formatStepResults / plan-confirmation 与 stepMaxRounds 消费点均在）、
// 覆盖描述与当前实现一致，未修订覆盖点；本轮为描述与来源核对（非逐行行为审计），
// sourceHash 按当前源码复算。
// 2026-10-06 计划提议工具批次（analyze→generate）：计划链路新增第二条入口 —— 模型在回合中
// 调用 `propose_plan`（tool/local-extra/plan.ts）时由 `engine/plan/proposal.ts` 复用同一确认
// 通道（requestPlanConfirm，同一 just_do_it/let_me_tk 策略点）、同一执行器（executePlan 的
// 超时/时限/失败裁决/逐步门）与同一记录存储（planCheckpointStore），结果按 formatStepResults
// 格式作为工具结果返回（自动入口则进主回合 ephemeral 上下文）。sourceFiles 增补
// `src/services/engine/plan/proposal.ts`（提议相位与并发守卫）与
// `src/services/engine/plan/limits.ts`（PLAN_CONFIRM_TIMEOUT_MS 的定义点移居此零依赖叶子，
// 供工具域折算工具超时预算；plan-confirmation.ts 保留同名再导出）。新增 pl-13 登记两个 L3
// caseId；pl-01..pl-12 逐点核对实现点仍在、覆盖描述与当前实现一致（自动入口的相位与通道
// 未被改写），未修订覆盖点；sourceHash 按当前源码复算（含 plan-confirmation.ts 的导出与
// 注释变化）。
// 2026-10-06 提问选择与去超时批次（analyze→刷 hash）：sourceFiles 变化 —— 移出
// `src/services/engine/plan/limits.ts`（PLAN_CONFIRM_TIMEOUT_MS 与 PROPOSE_PLAN_TOOL_TIMEOUT_MS
// 随「选择类弹窗不留超时」（2026-10-06 用户裁决）失去全部消费者，整文件删除；
// propose_plan 的执行超时改为显式 `null`（等用户做决定的工具没有有限预算，te-36 在列）），
// 补入 `src/services/engine/user-wait.ts`（等待期预算豁免的唯一登记点：计划时限按累计等待
// 扣除、回合墙钟与工具超时停表）；`planner.ts` 的 `deadlineAt` 比较改为用户等待期扣除后的
// 有效时钟（逐步门 / 失败询问上等用户的时长不计入计划时限）；`plan-confirmation.ts` 等待不再
// 有本地超时。**pl-12 描述修订**（去掉「卡到超时」与超时归宿，补「没有等待超时」与逃生口），
// scenarios 补 `plan-confirm-no-wait-timeout`；pl-01..pl-13 逐点核对实现点仍在、覆盖描述与当前
// 实现一致（描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-06 计划步骤报告口径收窄批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts 与 src/services/engine/plan/proposal.ts（两条入口的
// onStepNotice 同口径收窄：工具名不存在（missing_tools，真异常）仍写进度事件与聊天系统消息；
// 未限定工具（unbounded_tools，例行情形）只写进度事件（status=warning）与统一日志，不再
// 逐步骤敲系统消息 —— 2026-10-06 用户裁决）、src/services/engine/planner.ts（executeStep 的
// 未限定工具分支：onStepNotice 照发、注释与 log.warn 口径与新裁决同步）。pl-06 描述按新口径
// 修订（未限定工具不再「写进度与系统消息」，宿主只写进度事件与日志；工具名不存在仍写系统
// 消息）；pl-01..pl-05、pl-07..pl-14 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源
// 核对，非逐行行为审计）。注：既有 L4 场景 plan-production-loop（test/e2e/scenes/planner/
// 计划生产闭环.scene.ts）的 ②b 已随本批同改动修订——原先 waitSystemMessage 等待该已删除的
// 系统消息，现改为等 warning 进度事件（正向）＋整轮收尾后核对系统消息里不再出现该文案
// （负向，避免异步落盘竞态假绿）；全仓不再有该已删消息的等待引用。sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

// 2026-10-06 提问/选择工具批次（本批刷新）：pl-06 的派生型工具枚举补入 `ask_user`
// （它按交互工具声明 isolation=delegate，到不了子代理；判据走声明字段、执行路径未变）。
// 其余覆盖点逐条复核与当前实现一致，未修订。sourceHash 按当前源码复算。
// 2026-10-06 验收批次（analyze→generate 的声明部分；sourceHash 留待主会话统一批量刷新）：
// sourceFiles 增补 `src/services/engine/plan/settlement.ts` —— 两条计划入口共享的结算原语
// （写盘降级 / 收尾 / 取消归宿 / 活跃会话守卫的唯一实现，此前 runtime.ts 与 proposal.ts 各存
// 一份同形复刻）。新增 pl-14 登记其六条 L3 caseId（test/integration/planner/计划结算原语.test.ts）；
// pl-13 增补 scenario `plan-tool-just-do-it`（just_do_it 跳过确认面板直接执行、结果如实标注
// 「未经面板确认」）并在描述里补该分支。pl-01..pl-12 逐点核对实现点仍在、覆盖描述与当前实现
// 一致（描述/来源核对，非逐行行为审计）；rules 不动（pl-14 是 L3，不入 L4 计数 —— L4 场景集
// 仍为 pl-09/pl-10/pl-11 三个（test/e2e/scenes/planner/计划生产闭环.scene.ts），本批无 L4
// 场景变化，minScenarios/minDeepScenarios 维持 3/3）。**归属判断**：结算原语是计划域的收尾
// 机制，两条入口的对外归宿都经它收口，覆盖点归 planner；agent-runtime 只持计划条目的写入
// 机制（checkpoint-store.ts）与回合级计划相位（ar-16/ar-17），未登记本模块行为，故
// settlement.ts 不进 agent-runtime 的 sourceFiles。
// 2026-10-06 抽屉三下拉统一 CONFIG 写批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/plan/proposal.ts 与 src/services/engine/harness/runtime.ts（两条
// 入口的确认策略点改直读 safetyConfig.mode：会话级覆盖机制（debug.ts 的
// getEffectiveSafetyMode）整体删除，「安全」下拉与设置页同写 CONFIG `ai.safety.mode`；
// 计划相位、确认通道、执行器与确认/执行口径未变）。pl-12 / pl-13 的「just_do_it 跳过
// 确认面板」描述与当前实现一致（策略点换源、值域未变）；pl-01..pl-14 逐点核对实现点
// 仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；rules 不动；
// sourceHash 按当前源码复算。
export const plannerContract: ModuleContract = {
  module: "planner",
  // `plan-confirmation.ts` 是计划域的确认/逐步门通道（会话键控的待确认表、执行期中断登记、
  // 步骤门裁决），确认、进度、逐步门与取消结算的行为都定义在它和 runtime 的计划段里；
  // 本契约不再用 unitOnly 豁免运行时接线（plan-production-loop 覆盖确认/进度/终态，
  // plan-execution-stop-settlement 覆盖执行期取消的结算，plan-step-gate-each-step 覆盖逐步门）。
  // 计划条目本身的写入机制归 agent-runtime 契约（engine/plan/checkpoint-store.ts 在它的 sourceFiles 里），
  // 这里只从计划域的相位与通道出发断言它们落成的结果。
  sourceFiles: ["src/services/engine/planner.ts", "src/services/engine/plan-confirmation.ts",
    // 2026-10-06 提议入口批次补入：模型提议计划的执行相位（相位与自动入口共用确认/执行机制）。
    // 2026-10-06 去超时批次：plan/limits.ts 整文件删除（常量无消费者）；等待期预算豁免的
    // 唯一登记点补入（计划时限按累计等待扣除）。
    "src/services/engine/plan/proposal.ts", "src/services/engine/user-wait.ts",
    // 2026-10-06 验收批次补入：计划结算原语（pl-14）—— 两条入口共享的写盘降级 / 收尾 /
    // 取消归宿的唯一实现（此前 runtime.ts 与 proposal.ts 各存一份同形复刻）。
    "src/services/engine/plan/settlement.ts"],
  sourceHash: "46bd16c05594e7bfabab3ecc52a165d2917cd3b835b0ceb951cae7effb338b54",
  coverage: [
    { id: "pl-01", feature: "evaluateComplexity force触发", description: "--plan 前缀强制触发评分=5；判定是 startsWith，行首之外的 --plan 不命中 force 分支", why: "用户手动触发 Plan", layer: "integration", depth: "shallow", scenarios: ["plan-force-trigger"] },
    { id: "pl-02", feature: "evaluateComplexity 关键词匹配", description: "关键词列表匹配 → 评分 3、原因里带回命中的词；默认 complexityEval=keyword 时未命中关键词直接给低分，不为它单独发一次模型请求（判据用没有任何响应的 Provider：真发了请求就只能是 llm 分支或超时）", why: "自动检测复杂任务，同时不让每条助手消息都付一次判定请求的成本", layer: "integration", depth: "shallow", scenarios: ["plan-keyword-trigger"] },
    { id: "pl-03", feature: "evaluateComplexity 简单消息", description: "complexityEval=llm 时普通问候经 LLM 自判断 → 低评分 < 3", why: "避免简单对话触发 Plan", layer: "integration", depth: "shallow", scenarios: ["plan-simple-text"] },
    { id: "pl-04", feature: "evaluateComplexity LLM 失败回退", description: "complexityEval=llm 且 LLM 评估失败（Provider 以 error 结束流）→ 评分1、原因里带回 Provider 错误，跳过 Plan；评分超出 1–5 被夹回", why: "Plan 容错，且失败原因不能在回退时丢失", layer: "integration", depth: "shallow", scenarios: ["plan-eval-fallback"] },
    { id: "pl-05", feature: "generatePlan 步骤生成", description: "复杂度达标 → LLM 生成分步计划：解析模型返回的围栏 JSON，步骤描述、summary 与 estimatedComplexity 逐项落地（裸 JSON 的兜底正则未由本场景断言）", why: "Plan 核心能力", layer: "integration", depth: "deep", scenarios: ["plan-generate"] },
    { id: "pl-06", feature: "executePlan 步骤执行", description: "按计划逐步执行：步骤顺序与 onStepStart/onStepDone 回调顺序都是计划顺序，逐条记账成功/失败，全成功才判 overallSuccess；步骤未限定 allowedTools 时经 onStepNotice 如实报告工具面放大（2026-10-06 用户裁决收窄：未限定工具是例行情形，宿主只写进度事件与统一日志、不再逐步骤敲聊天系统消息；文案口径按「除派生型工具外的全部已注册工具」，派生型工具在子代理入口还会再被剥掉），指定了不存在的工具、或指定了到不了子代理的派生型工具（isolation=delegate，现为 agent_spawn、propose_plan 与 ask_user）走同一条硬失败：不开工、步骤判失败、产出带工具名的错误、不是取消归宿，该真异常仍写进度事件与聊天系统消息。两种「解析不到」都由本覆盖点的 unit 场景断言 —— 派生型工具那段用 agent_spawn 这个名字（getToolByName 按 AI 调用的函数名解析，不是工具 id）：恰一条带工具名的 missing_tools 通知、零 Provider 请求、overallSuccess=false、产出 error 带工具名、reply 为空且 toolCallsMade=0（快照归属那一半仍未由 unit 场景断言，production 证据见 mm-11）", why: "Plan 执行闭环，且步骤的权限面变化不能只留在日志里", layer: "integration", depth: "deep", scenarios: ["plan-execute-loop"] },
    { id: "pl-07", feature: "formatStepResults 格式化", description: "执行结果格式化为可读文本：步骤描述与产出逐条落进正文，已落盘的步骤结果带上可回读地址（plan_step_result 条目 id），没落盘时如实标注「原文未落盘」而不假称可回读；结果末尾带收尾指令", why: "Plan 结果展示，回读地址是模型从缩短结果回到真相源的唯一通道", layer: "integration", depth: "shallow", scenarios: ["plan-format-steps"] },
    { id: "pl-08", feature: "Plan 解析降级", description: "generatePlan 在模型没返回可解析 JSON 时降级为单步计划（复杂度 1、描述回落到原文、带 degradedReason=json_parse_failed），而不是抛错或产出空计划；降级在生产段的可见提示由 runtime 按 degradedReason 发系统消息，该出口未由本 unit 场景覆盖", why: "模型输出格式不可控，Plan 必须有一条不依赖模型配合的降级路径", layer: "integration", depth: "deep", scenarios: ["plan-generate-fallback"] },
    { id: "pl-09", feature: "生产入口的计划确认与进度", description: "生产入口跑完整计划闭环：确认视图与进度事件的步数都是截断后（maxSteps 生效后）的步数，终态同时落在 checkpoint 条目（terminal 快照 done、全量步骤基线两步都 done）与终态事件（done）上，步骤结果条目恰为计划步数；确认经会话键控的测试通道确定性应答（mode=auto）并带会话身份。计划段由 `planConfig.enabled` 单独把守（模式已删除、该开关出厂为 true；Live 基线把它钉在 false，本场景在 setup 里显式打开）", why: "计划入口此前只有判定与解析的 unit 覆盖，确认视图、进度 total 与终态证据这些真正的运行时接线没有任何生产入口证据", layer: "e2e", depth: "deep", scenarios: ["plan-production-loop"] },
    { id: "pl-10", feature: "计划执行期取消的结算", description: "生产入口（sendMessage）执行期停止：停止命中在跑的计划（planAborted）后，计划终态落 interrupted、剩余步骤在终态快照里保持 pending 且没有第 2 步的结果条目，终态事件 cancelled；用户主动停止不按失败结算 —— 生产结果不带 failure、outcome 是正常收尾、不写助手正文，宿主另写「已停止本次回复」的系统提示", why: "停止必须真的停住剩余步骤，且不能把用户自己的动作记成模型故障 —— 这条账只能在真实运行里核对", layer: "e2e", depth: "deep", scenarios: ["plan-execution-stop-settlement"] },
    { id: "pl-11", feature: "逐步确认的真前置门", description: "用户以 `--plan` 强制触发进入计划段（生产入口的 force 路径，`complexityEval=keyword` 下同样生效）且确认给出的 mode=stepByStep 传进计划段：2 步计划每步开工前各问一次步骤门（恰好 2 次 kind=step_gate 的 continue 裁决），门没有把计划卡住 —— 每步都执行、终态与终态事件都是 done、进度 total 是计划步数；门选择中止的 declined 归宿不在本场景（宿主通道对确认与门共用一套 planPolicy，给不出「确认自动 + 门中止」）", why: "逐步门此前没有任何运行时证据：它是否真的成为每步的前置门、确认的 mode 是否被采纳，只能在运行时接线里看", layer: "e2e", depth: "deep", scenarios: ["plan-step-gate-each-step"] },
    { id: "pl-12", feature: "计划确认回执通道的结算", description: "计划确认与步骤门共用 UI 回执反向通道（L3）：提问经 deskpet-plan-start 发出后，确认回执按 planId 结算待确认计划并清空待确认表，步骤门回执同按 planId 结算裁决；未知 planId 的回执是 no-op —— 不结算、不误伤他人的待确认项、不抛，随后正确 planId 仍可正常结算；发布失败（UI 通道关闭）以 emit_failed 立即结算，不把 UI 不可达伪装成「继续等待」。**没有等待超时**（2026-10-06 用户裁决：选择类弹窗不留超时）：确认与步骤门的等待不设本地期限（假时钟推进 10 分钟仍待答、待确认视图不被计时器清掉），归宿只来自回执 / 取消信号 / 会话生命周期 / 发布失败", why: "回执是 UI→Node 反向通道的唯一结算入口：未知/迟到回执若误结算会替用户作答；超时结算等于把「用户还没想好」当成拒绝（已删）—— 替代它的是逐条显式逃生口（发布失败、取消信号、会话切换/关闭），吞掉任何一条都会让确认方悬挂", layer: "integration", depth: "deep", scenarios: ["plan-confirm-receipt-settles", "plan-confirm-receipt-unknown-noop", "plan-confirm-receipt-step-decision", "plan-confirm-emit-failure-settles", "plan-confirm-no-wait-timeout"] },
    // 2026-10-06 提议入口批次新增：模型给出的步骤经既有确认/执行/记录链跑完整相位。
    { id: "pl-13", feature: "模型提议计划的执行相位（propose_plan）", description: "模型在回合中调用 propose_plan（`engine/plan/proposal.ts` 复用既有机制，不另建确认通道或执行器）：确认走 requestPlanConfirm（确认记录里的步骤数就是模型给出的步骤数）；用户确认后步骤由 executePlan 的子运行真实执行 —— 子运行请求里拿到的正是模型给的步骤文本，工具面按该步 allowedTools 收窄（只 read 时没有 bash），进度事件按步骤 running/done 顺序发布、终态事件 done、计划记录落 done；逐步确认模式（stepByStep）下每步开工前各问一次既有步骤裁决面板（恰两条 continue 裁决），结果按 formatStepResults 既有格式（含 plan_step_result 回读地址）作为工具结果返回模型。just_do_it 策略下跳过确认面板直接执行：零确认请求到达面板通道、步骤照常真实执行（请求账主回合 + 步骤子运行 + 收尾）、记录落 done、收尾事件照发，工具结果仍是既有计划结果格式并如实标注「未经面板确认直接执行」。并发守卫（同一会话同一时刻只允许一个计划）与用户取消/面板不可用/发射失败的如实归宿归 tool-execution 契约的 te-32", why: "模型侧此前没有任何「提议计划」的工具，需要确认时只能自己用 bash 弹 GUI 对话框 —— 用户实测被工具超时打断并留下孤儿窗口；这条入口必须证明它挂的是既有链路（同确认通道、同执行器、同记录、同步进门），而不是一条绕过确认的旁路", layer: "integration", depth: "deep", scenarios: ["plan-tool-confirm-accept", "plan-tool-step-gate", "plan-tool-just-do-it"] },
    // 2026-10-06 验收批次新增：pl-14 —— `engine/plan/settlement.ts`（计划结算原语）自 2026-10-06
    // 起是自动入口（runtime.ts 的 runPlanPhase）与提议入口（plan/proposal.ts）共享的同一份实现
    // （此前两处各存一份同形复刻）。归属判断：结算原语是计划域的收尾机制（终态落盘、取消步骤
    // 归宿、面板收起与收尾文案），两条入口的对外归宿都经它收口；自动入口侧的落地结果已由
    // pl-09/pl-10/pl-11 从生产入口核对，因此覆盖点落在 planner。agent-runtime 只持有计划条目的
    // 写入机制（checkpoint-store.ts）与回合级计划相位（ar-16/ar-17），未登记本模块行为，
    // settlement.ts 不进它的 sourceFiles。
    { id: "pl-14", feature: "计划结算原语（两条入口共享的写盘降级 / 终态 / 取消归宿）", description: "createPlanSettlement 工厂产出的结算原语钉住六类参数化分支（机制共享、语义分工：log / traceContext / reason 由调用方注入，不合并任一侧口径）：① 写盘降级 —— 写终态失败不抛不静默：统一日志 + `deskpet.plan_write_failed` 证据条目（绑 planId 与失败原因）+ 用户可见提示「计划执行记录写入失败（计划本身已执行/已取消）」，收尾照走（面板收起事件照发，跑完的计划不会一直挂着）；② 三类终态（done / failed / interrupted）各自落盘，面板收起原因逐类对应（done / failed / cancelled）；③ 通知口径只认 deadline / declined 两支 —— completed / failed / user 归宿发消息数为零（用户自己的终止与正常完成由面板与主回复承担）；④ 取消归宿 —— 仍在 running 的步骤落 interrupted、剩余保持 pending，deadline 落「计划超时…」、declined 落「已按你的选择…」，user / ui_unavailable 静默（文案由各自结算处承担，不各发一条）；⑤ 活跃会话守卫 —— 计划所属会话不是活跃会话时面板收起事件照发、系统消息不落（不写进别的会话；对照消息证明「写盘 → 回读」在等待窗口内可观测）；⑥ traceContext 只在传入时发 plan_settled 轨迹（自动入口口径；提议入口没有回合轨迹），不传时零轨迹。另覆盖 failPlanOnUserDecline：步骤全部 skipped、计划落 failed、面板收起 cancelled", why: "两条入口此前各存一份同形复刻，提取共享模块的动机是消除分叉；提取时若顺手合并语义（通知口径合并、守卫丢失、取消步骤归宿漂移、轨迹变成无条件发布），两条入口的对外归宿会静默分叉，而这类偏差既不报错、也不会在单一入口的场景里同时暴露", layer: "integration", depth: "deep", scenarios: ["plan-settlement-write-degrade", "plan-settlement-states", "plan-settlement-cancel", "plan-settlement-inactive-session", "plan-settlement-user-decline", "plan-settlement-trace"] },
  ],
  rules: {
    // W0–W7 把本契约迁出 L4 的场景按 L4 侧当前值重标定：门槛=当前 rules 声明值
    // （pl-09/10/11 留在 L4），只缩不放（数字由 checker 报错提供）；
    // 跨层完整性由 checkLayerCoverage 负责。
    // 2026-10-06 验收批次核对：L4 场景集仍为 pl-09/pl-10/pl-11 三个场景
    // （test/e2e/scenes/planner/计划生产闭环.scene.ts，均 deep），本批无 L4 变化，维持 3/3。
    minScenarios: 3,
    minDeepScenarios: 3,
    requireBoundary: true,
    requireErrorPath: true,
  },
}
