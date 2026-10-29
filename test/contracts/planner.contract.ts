// 2026-10-29 共享 runtime 静态复核：撤销主答列项补写并同消息保存生成/交付证据，
// 计划准入、执行、确认与恢复分支未改；通用回复资格由agent-runtime/ar-24承接，测试未运行。
// 2026-10-24 计划抗漂移批次（analyze→generate）：① 证据闭环 —— 步骤子运行启用通用
// outputContract（非空回复且无未确认效果），失败的非只读工具回执（afterTool 与
// onChildToolResult 两路）标记 unconfirmedEffects，非空正文不能把失败洗成完成；验收档
// verified/unverified 由证据计算，formatStepResults 与交付摘要都按档位展示。② 回读与交接 ——
// read_session_event 可读 plan_step_result 条目（读取命名空间归 tool-execution te-13）；
// 步骤交接改为自包含摘要（头尾截断保留结论）并移除子运行读不到的条目地址；恢复回读仍归
// memory mm-15。③ 目标与权限面 —— 本轮可信用户原文经 ToolContext 注入，propose_plan 的
// intent 只认该原文（模型参数不能替换）；显式入口的规划器可用工具排除派生型工具，生成提示
// 要求每步非空 allowedTools；deskpet-plan-start 载荷新增 summary 与每步 allowedTools，
// 原生面板显示目标与权限面（Rust 侧由 ui/chat 单测断言）。④ 依赖与全貌 —— 步骤可声明
// dependsOn（只引用更早步骤，规范化丢弃不可满足依赖并重映射 id）；执行时依赖未成功完成则
// 跳过并说明原因（onStepSkipped、skippedSteps、overallSuccess=false），每步提示注入整份
// 计划全貌。pl-01/pl-06/pl-07/pl-09/pl-12/pl-13 描述按当前实现修订；pl-06 新增
// plan-step-effect-receipt / plan-dependency-skip / plan-outline 三个 L3 caseId，
// pl-13 新增 plan-intent-binding 与 plan-tool-effect-receipt（提议入口侧的非只读失败证据闭环）；其余覆盖点逐点核对实现点仍在（描述/来源核对，非逐行行为
// 审计）；sourceHash 按当前源码复算。
// 2026-10-24 记忆引用溯源批次（定向复核）：sourceFiles 中 runtime.ts 只在回合提交后追加
// deskpet.memory_citations 自定义条目；计划记录、步骤交接、恢复执行与结算路径未改，
// pl-* 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-24 计划闭环批次（analyze→generate）：① 步骤交接 —— 计划记录冻结 `intent`（原始目标），
// 每步请求注入原始目标与有界的前序步骤结果（成功行带摘要与回读地址、失败行只给错误；
// 直接前驱 1500、其余 600、总额 4000，超限标注截断），恢复执行从 `plan_step_result` 条目回读
// 后按同一投影注入（只取 stepId 小于当前步的结果）；pl-06 增补三条 L3 caseId。② 结算 ——
// 终态同时写目标完成度 `completion`（按盘上 done 步数，只在终态写），pl-14 增补
// `plan-settlement-completion`。③ 交付兜底 —— `formatPlanDeliverySummary` 产出中性摘要，
// 工具入口经 `plan/delivery.ts` 暂存到会话、主回合结算取走；最终回复失败时作为系统消息交付
// （成功回合取走即清），新增 pl-15 登记 `plan-tool-delivery-fallback`；sourceFiles 补入
// `src/services/engine/plan/delivery.ts`。pl-07 增补交付摘要口径（同一 caseId 已断言）。
// 恢复回读的宿主适配仍由 memory mm-15 锚定（checkpoint-store 在其 sourceFiles）。
// 2026-10-23 计划入口收敛批次：删除关键词触发与独立复杂度评估请求，普通请求由主模型按需调用
// propose_plan，显式入口只认完整 `--plan` 前缀（`ai.plan.enabled` 单独把守）；pl-01/pl-02 的
// 描述与场景口径随之更新。失败 sticky（continue 或 ask→continue 后整体仍 failed）由 pl-06 的
// `plan-continue-keeps-failure` 断言；sourceFiles 补入 runtime.ts 与 local-extra/plan.ts。
// 恢复期副作用判定归 memory mm-15（checkpoint-store 在 memory 契约的 sourceFiles）。
// 历史批次注释中的「自动入口」与 evaluateComplexity 是当时的触发链记录，均已删除；
// 今天的显式命令入口只按 `--plan` 前缀触发。
// 2026-10-18 统一调度与子运行：手工 analyze/generate 声明修订；测试已写未运行，sourceHash 留统一验收复算。
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
// runPiAgentTurn / 续跑不再传计数上限，runPiSubAgent 仍按 `input.maxToolCalls ?? 3` 封顶；
// 计划步骤经 planner.ts:461 传 `maxToolCalls: config.stepMaxRounds`，封顶数值未动；
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
    // pl-01/pl-02/pl-09: explicit preflight entry; pl-13: tool failure result. Shared loops belong to agent-runtime.
    "src/services/engine/harness/runtime.ts", "src/services/tool/local-extra/plan.ts",
    // 2026-10-06 提议入口批次补入：模型提议计划的执行相位（相位与显式命令入口共用确认/执行机制）。
    // 2026-10-06 去超时批次：plan/limits.ts 整文件删除（常量无消费者）；等待期预算豁免的
    // 唯一登记点补入（计划时限按累计等待扣除）。
    "src/services/engine/plan/proposal.ts", "src/services/engine/user-wait.ts",
    // 2026-10-06 验收批次补入：计划结算原语（pl-14）—— 两条入口共享的写盘降级 / 收尾 /
    // 取消归宿的唯一实现（此前 runtime.ts 与 proposal.ts 各存一份同形复刻）。
    // 2026-10-24 交付兜底批次补入：回合内计划结果的暂存（pl-15）—— 工具入口写入、主回合结算取走。
    "src/services/engine/plan/settlement.ts", "src/services/engine/plan/delivery.ts"],
  sourceHash: "6bdb7df71eabf630bfc7cd00693cfd3ec9744987c98cdb66e7d134a476de9e20",
  coverage: [
    // 退役预评估的三个 caseId 随功能删除；显式入口沿用原 ID，普通入口改测零额外请求。
    { id: "pl-01", feature: "显式 --plan 入口", description: "启用 ai.plan.enabled 时，行首 --plan 后为字尾或空白才触发生成、确认、步骤执行和主回复；无额外复杂度评估请求，计划终态 done。规划器的可用工具清单排除派生型工具（isolation=delegate，到不了步骤子代理），生成提示要求每步给出非空 allowedTools，场景同时断言提示词与工具清单（只判入口触发会让权限面错误的计划照样变绿）", why: "用户仍可显式要求计划，命令不能误匹配普通文本；规划器列出的权限面必须是步骤子代理真实可达的工具集", layer: "integration", depth: "deep", scenarios: ["plan-force-trigger"] },
    { id: "pl-02", feature: "普通请求由主模型决定计划", description: "普通问候、包含旧关键词的请求、--planet 与句中 --plan 都直接请求主模型：每轮一次 Provider 调用、没有计划记录，工具面提供 propose_plan 供模型按需使用", why: "避免关键词误触发和每条消息多一次评估开销", layer: "integration", depth: "deep", scenarios: ["plan-model-entry"] },
    { id: "pl-05", feature: "generatePlan 步骤生成", description: "显式规划时 LLM 生成分步计划：解析模型返回的围栏 JSON，步骤描述、summary 与 estimatedComplexity 逐项落地（裸 JSON 的兜底正则未由本场景断言）", why: "Plan 核心能力", layer: "integration", depth: "deep", scenarios: ["plan-generate"] },
    { id: "pl-06", feature: "executePlan 步骤执行", description: "按计划逐步执行：必须提供父 scope 与 planId，子运行绑定 plan/step/run 身份，统一 status/evidence/audit 结果外壳由 agent-runtime ar-41 自持。步骤子运行启用通用 outputContract：回复非空还不够 —— 失败的非只读工具回执（afterTool 与 onChildToolResult 两路都记）标记 unconfirmedEffects，证据未闭环的产物判失败，非空正文不能把失败洗成完成；验收档由 planStepAcceptance 按证据计算（成功且无未确认效果、无证据缺口 = verified），只表示证据闭环、不证明业务正确。步骤顺序与 onStepStart/onStepDone 回调顺序都是计划顺序，逐条记账成功/失败，全成功才判 overallSuccess；失败后 continue 或 ask→continue 都不能被后续成功洗掉，执行抛错与失败输出同样保留失败且 onStepDone 只结算一次。依赖与跳过：dependsOn 只允许引用更早步骤（规范化丢弃不可满足/前向/传递阻塞的依赖并重映射 id）；依赖步骤没有成功结果时本步在逐步门之前跳过 —— 不开工、不弹门、零 Provider 请求，onStepSkipped 落 checkpoint skipped + 进度 warning + 系统消息，skippedSteps 记录原因与未满足依赖，overallSuccess=false（跳过不是失败，但计划不完整，不包装成功）。步骤交接：每一步请求都带计划冻结的原始目标（intent，预算 2000，超限标注截断）与整份计划全貌（当前/完成/失败/已跳过/待执行，依赖关系标注，单步标题预算 160，并明确「只执行当前步骤」），前序结果只注入 stepId 小于当前步的步骤 —— 成功行给标题、验收档与正文摘要（直接前驱 1500、其余 600，头尾截断保留结论），失败行只给 error、不给正文；总额封顶 4000、放不下的旧前序整条省略且不伪造摘要。子运行读不到父会话条目，交接因此不给回读地址（主回合回读由 read_session_event 承担，见 tool-execution te-13；恢复回读仍归 memory mm-15）。步骤未限定 allowedTools 时经 onStepNotice 如实报告工具面放大（2026-10-06 用户裁决收窄：未限定工具是例行情形，宿主只写进度事件与统一日志、不再逐步骤敲聊天系统消息；文案口径按「除派生型工具外的全部已注册工具」，派生型工具在子代理入口还会再被剥掉），指定了不存在的工具、或指定了到不了子代理的派生型工具（isolation=delegate，现为 agent_spawn、propose_plan 与 ask_user）走同一条硬失败：不开工、步骤判失败、产出带工具名的错误、不是取消归宿，该真异常仍写进度事件与聊天系统消息。两种「解析不到」都由本覆盖点的 integration 场景断言 —— 派生型工具那段用 agent_spawn 这个名字（getToolByName 按 AI 调用的函数名解析，不是工具 id）：恰一条带工具名的 missing_tools 通知、零 Provider 请求、overallSuccess=false、产出 error 带工具名、reply 为空且 toolCallsMade=0（快照归属那一半仍未由 unit 场景断言，production 证据见 mm-11）", why: "Plan 执行闭环，且步骤的权限面变化不能只留在日志里；失败的工具调用可能已产生效果，非空正文与跳过都不能冒充完成", layer: "integration", depth: "deep", scenarios: ["plan-execute-loop", "plan-continue-keeps-failure", "plan-step-effect-receipt", "plan-handoff", "plan-handoff-failure", "plan-handoff-truncate", "plan-dependency-skip", "plan-outline"] },
    { id: "pl-07", feature: "formatStepResults 格式化", description: "执行结果格式化为可读文本：步骤描述与产出逐条按步骤 id 落进正文，验收档与执行判定同源 —— 成功且证据闭环写「完成（证据已核对）」，成功但有未确认效果或证据缺口写「完成（未验收）」，失败写「失败」；因依赖未完成而跳过的步骤以 SKIP 行按 id 合并展示原因（不混进成功/失败计数）。已落盘的步骤结果带上可回读地址（plan_step_result 条目 id，主回合经 read_session_event 读取），没落盘时如实标注「原文未落盘」而不假称可回读；总步数按计划全量而非本次执行集合统计，整体结论区分全部完成 / 部分完成（x/y 步）/ 失败或未完成；结果末尾带收尾指令。同文件的 formatPlanDeliverySummary 产出最终回复失败时的中性交付摘要：x/y 步完成、逐条「完成（证据已核对 / 未验收）/ 失败 - 错误 / 跳过（原因）」并按 id 排序，不回读地址、不夹带步骤正文、不再要求模型生成回复", why: "Plan 结果展示，回读地址是模型从缩短结果回到真相源的唯一通道；「完成」不能冒充「已验收」，跳过必须可见，兜底摘要也不能把结果正文再倒一遍", layer: "integration", depth: "shallow", scenarios: ["plan-format-steps"] },
    { id: "pl-08", feature: "Plan 解析降级", description: "generatePlan 在模型没返回可解析 JSON 时降级为单步计划（复杂度 1、描述回落到原文、带 degradedReason=json_parse_failed），而不是抛错或产出空计划；降级在生产段的可见提示由 runtime 按 degradedReason 发系统消息，该出口未由本 unit 场景覆盖", why: "模型输出格式不可控，Plan 必须有一条不依赖模型配合的降级路径", layer: "integration", depth: "deep", scenarios: ["plan-generate-fallback"] },
    { id: "pl-09", feature: "生产入口的计划确认与进度", description: "生产入口跑完整计划闭环：确认视图与进度事件的步数都是截断后（maxSteps 生效后）的步数，终态同时落在 checkpoint 条目（terminal 快照 done、全量步骤基线两步都 done）与终态事件（done）上，步骤结果条目恰为计划步数；确认经会话键控的测试通道确定性应答（mode=auto）并带会话身份。显式 --plan 入口由 `planConfig.enabled` 把守（出厂 true；Live 基线 false，本场景显式打开）；普通请求不走预规划，由主模型决定是否调用 propose_plan。确认载荷同时带计划 summary 与每步 allowedTools 供面板显示目标与权限面（字段级断言在 pl-12 的 L3 回执场景，本 E2E 场景只看步数、终态与进度）", why: "计划入口此前只有判定与解析的 unit 覆盖，确认视图、进度 total 与终态证据这些真正的运行时接线没有任何生产入口证据", layer: "e2e", depth: "deep", scenarios: ["plan-production-loop"] },
    { id: "pl-10", feature: "计划执行期取消的结算", description: "生产入口（sendMessage）执行期停止：停止命中在跑的计划（planAborted）后，计划终态落 interrupted、剩余步骤在终态快照里保持 pending 且没有第 2 步的结果条目，终态事件 cancelled；用户主动停止不按失败结算 —— 生产结果不带 failure、outcome 是正常收尾、不写助手正文，宿主另写「已停止本次回复」的系统提示", why: "停止必须真的停住剩余步骤，且不能把用户自己的动作记成模型故障 —— 这条账只能在真实运行里核对", layer: "e2e", depth: "deep", scenarios: ["plan-execution-stop-settlement"] },
    { id: "pl-11", feature: "逐步确认的真前置门", description: "用户以 `--plan` 强制触发进入计划段（启用 ai.plan.enabled 的显式命令入口）且确认给出的 mode=stepByStep 传进计划段：2 步计划每步开工前各问一次步骤门（恰好 2 次 kind=step_gate 的 continue 裁决），门没有把计划卡住 —— 每步都执行、终态与终态事件都是 done、进度 total 是计划步数；门选择中止的 declined 归宿不在本场景（宿主通道对确认与门共用一套 planPolicy，给不出「确认自动 + 门中止」）", why: "逐步门此前没有任何运行时证据：它是否真的成为每步的前置门、确认的 mode 是否被采纳，只能在运行时接线里看", layer: "e2e", depth: "deep", scenarios: ["plan-step-gate-each-step"] },
    { id: "pl-12", feature: "计划确认回执通道的结算", description: "计划确认与步骤门共用 UI 回执反向通道（L3）：提问经 deskpet-plan-start 发出后，事件载荷带计划 summary 与每步 allowedTools（面板据此显示目标与工具权限面），确认回执按 planId 结算待确认计划并清空待确认表，步骤门回执同按 planId 结算裁决；未知 planId 的回执是 no-op —— 不结算、不误伤他人的待确认项、不抛，随后正确 planId 仍可正常结算；发布失败（UI 通道关闭）以 emit_failed 立即结算，不把 UI 不可达伪装成「继续等待」。**没有等待超时**（2026-10-06 用户裁决：选择类弹窗不留超时）：确认与步骤门的等待不设本地期限（假时钟推进 10 分钟仍待答、待确认视图不被计时器清掉），归宿只来自回执 / 取消信号 / 会话生命周期 / 发布失败", why: "回执是 UI→Node 反向通道的唯一结算入口：未知/迟到回执若误结算会替用户作答；超时结算等于把「用户还没想好」当成拒绝（已删）—— 替代它的是逐条显式逃生口（发布失败、取消信号、会话切换/关闭），吞掉任何一条都会让确认方悬挂", layer: "integration", depth: "deep", scenarios: ["plan-confirm-receipt-settles", "plan-confirm-receipt-unknown-noop", "plan-confirm-receipt-step-decision", "plan-confirm-emit-failure-settles", "plan-confirm-no-wait-timeout"] },
    // 2026-10-06 提议入口批次新增：模型给出的步骤经既有确认/执行/记录链跑完整相位。
    { id: "pl-13", feature: "模型提议计划的执行相位（propose_plan）", description: "模型在回合中调用 propose_plan（`engine/plan/proposal.ts` 复用既有机制，不另建确认通道或执行器）：确认走 requestPlanConfirm（确认记录里的步骤数就是模型给出的步骤数）；用户确认后步骤由 executePlan 的子运行真实执行 —— 子运行请求里拿到的正是模型给的步骤文本，计划记录与每步请求携带冻结的原始目标（只取本轮可信用户原文，模型参数里的 intent 被忽略、模型转述不能替换用户事实；没有可信原文时由工具层回落到 summary），步骤可声明 dependsOn（只能引用更早步骤 id，规范化为 1..id-1；依赖步骤未成功完成时本步跳过并说明原因，不照常执行），工具面按该步 allowedTools 收窄（只 read 时没有 bash），进度事件按步骤 running/done 顺序发布、终态事件 done、计划记录落 done；逐步确认模式（stepByStep）下每步开工前各问一次既有步骤裁决面板（恰两条 continue 裁决），结果按 formatStepResults 既有格式（含 plan_step_result 回读地址）作为工具结果返回模型。just_do_it 策略下跳过确认面板直接执行：零确认请求到达面板通道、步骤照常真实执行（请求账主回合 + 步骤子运行 + 收尾）、记录落 done、收尾事件照发，工具结果仍是既有计划结果格式并如实标注「未经面板确认直接执行」。失败步骤后选择继续时，后续成功不改变整体失败：步骤记录 failed/done、计划和终态事件 failed，工具结果 isError=true 且说明部分失败。非只读工具失败时，提议入口同样按证据闭环判该步失败（验收档 unverified、不冒充完成，与 pl-06 的通用执行器语义同源），计划整体失败。并发守卫（同一会话同一时刻只允许一个计划）与用户取消/面板不可用/发射失败的如实归宿归 tool-execution 契约的 te-32", why: "模型侧此前没有任何「提议计划」的工具，需要确认时只能自己用 bash 弹 GUI 对话框 —— 用户实测被工具超时打断并留下孤儿窗口；这条入口必须证明它挂的是既有链路（同确认通道、同执行器、同记录、同步进门），而不是一条绕过确认的旁路", layer: "integration", depth: "deep", scenarios: ["plan-tool-confirm-accept", "plan-tool-step-gate", "plan-tool-just-do-it", "plan-tool-continue-failure", "plan-intent-binding", "plan-tool-effect-receipt"] },
    // 2026-10-06 验收批次新增：pl-14 —— `engine/plan/settlement.ts`（计划结算原语）自 2026-10-06
    // 起是显式命令入口（runtime.ts 的 runPlanPhase）与提议入口（plan/proposal.ts）共享的同一份实现
    // （此前两处各存一份同形复刻）。归属判断：结算原语是计划域的收尾机制（终态落盘、取消步骤
    // 归宿、面板收起与收尾文案），两条入口的对外归宿都经它收口；显式命令入口侧的落地结果已由
    // pl-09/pl-10/pl-11 从生产入口核对，因此覆盖点落在 planner。agent-runtime 只持有计划条目的
    // 写入机制（checkpoint-store.ts）与回合级计划相位（ar-16/ar-17），未登记本模块行为，
    // settlement.ts 不进它的 sourceFiles。
    { id: "pl-14", feature: "计划结算原语（两条入口共享的写盘降级 / 终态 / 取消归宿）", description: "createPlanSettlement 工厂产出的结算原语钉住六类参数化分支（机制共享、语义分工：log / traceContext / reason 由调用方注入，不合并任一侧口径）：① 写盘降级 —— 写终态失败不抛不静默：统一日志 + `deskpet.plan_write_failed` 证据条目（绑 planId 与失败原因）+ 用户可见提示「计划执行记录写入失败（计划本身已执行/已取消）」，收尾照走（面板收起事件照发，跑完的计划不会一直挂着）；② 三类终态（done / failed / interrupted）各自落盘，面板收起原因逐类对应（done / failed / cancelled）；③ 通知口径只认 deadline / declined 两支 —— completed / failed / user 归宿发消息数为零（用户自己的终止与正常完成由面板与主回复承担）；④ 取消归宿 —— 仍在 running 的步骤落 interrupted、剩余保持 pending，deadline 落「计划超时…」、declined 落「已按你的选择…」，user / ui_unavailable 静默（文案由各自结算处承担，不各发一条）；⑤ 活跃会话守卫 —— 计划所属会话不是活跃会话时面板收起事件照发、系统消息不落（不写进别的会话；对照消息证明「写盘 → 回读」在等待窗口内可观测）；⑥ traceContext 只在传入时发 plan_settled 轨迹（显式命令入口口径；提议入口没有回合轨迹），不传时零轨迹；⑦ 目标完成度随终态写盘（按盘上 done 步骤数：全 done=complete、部分=partial、零=none），与生命周期状态正交 —— 取消与用户拒绝因此自然得到 partial / none，运行中迁移不写 completion。另覆盖 failPlanOnUserDecline：步骤全部 skipped、计划落 failed、面板收起 cancelled", why: "两条入口此前各存一份同形复刻，提取共享模块的动机是消除分叉；提取时若顺手合并语义（通知口径合并、守卫丢失、取消步骤归宿漂移、轨迹变成无条件发布、完成度写成第二个生命周期状态），两条入口的对外归宿会静默分叉，而这类偏差既不报错、也不会在单一入口的场景里同时暴露", layer: "integration", depth: "deep", scenarios: ["plan-settlement-write-degrade", "plan-settlement-states", "plan-settlement-cancel", "plan-settlement-inactive-session", "plan-settlement-user-decline", "plan-settlement-trace", "plan-settlement-completion"] },
    // 2026-10-24 交付兜底批次新增 pl-15：计划步骤已执行、主回合最终回复失败时，结果不能只留在
    // checkpoint 条目里（用户看不到、模型也没有第二轮机会）。工具入口在回合中途执行完计划后把
    // 中性摘要暂存到会话；主回合结算每次取走（成功回合取走即清、不跨回合残留、新回合开始清掉
    // 上一回合遗留），最终回复失败时把摘要作为计划所属会话的系统消息交付。
    { id: "pl-15", feature: "计划结果的交付兜底（最终回复失败时以系统消息交付）", description: "propose_plan 工具入口在计划执行完成后调用 formatPlanDeliverySummary 生成中性摘要（x/y 步完成、逐条完成/失败，不带步骤正文与回读地址），经 plan/delivery.ts 按会话暂存；主回合结算 takePlanDelivery 取走暂存 —— 成功回合取走但不写消息，最终回复失败时作为计划所属会话的系统消息交付，步骤结果不因回复失败而消失。--plan 入口不走暂存（执行结果留在回合作用域，由结算参数直接给出）；同一回合内多个计划按执行顺序拼接；新回合开始时清掉上一回合未消费的暂存，异常退出不把旧计划结果带进新回合", why: "工具入口拿不到回合结算：若只在工具结果里交付，模型最终回复失败时用户与模型都看不到已执行的结果，外部副作用发生了却没有任何可见交代", layer: "integration", depth: "shallow", scenarios: ["plan-tool-delivery-fallback"] },
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
