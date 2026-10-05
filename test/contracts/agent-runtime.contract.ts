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
import type { ModuleContract } from "../host/types"

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
    "src/services/engine/plan-confirmation.ts",
    "src/services/engine/preprocessor.ts",
    "src/services/engine/runtime/input-identity.ts",
    "src/services/engine/runtime/trace.ts",
    "src/services/engine/runtime/types.ts",
    "src/services/humanizer/protocol.ts",
    "src/services/humanizer/scheduler.ts",
    "src/services/humanizer/index.ts",
    "src/services/context/builder.ts",
    "src/services/context/kernel.ts",
    "src/services/reply/reminder.ts",
    "src/services/images/request.ts",
    "src/services/images/paths.ts",
    "src/services/session/manager.ts",
    "src/services/session/messages.ts",
    "src/services/session/persistence.ts",
    "src/services/session/read-model.ts",
    "src/services/session/repo.ts",
    "src/services/session/store.ts",
  ],
  sourceHash: "c863d1fe0aff769a2dbc620b5e9e7d55d070cfde9b45adb90ee3a986afc02f0b",
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
      description: "未完成操作在重新附着后默认暂停并暴露中断态：用户选择继续时由未完成操作续跑并产出回复、中断态清除，且续跑前与主回合走同一能力准备入口（重新借用 MCP、按目录指纹核对 Skill 清单），能力不足不以上游「Tool … is unavailable」通用文案上报；选择丢弃时按 aborted 收尾、不重放未知副作用，之后会话照常可用。注：「待重放的工具引用了本次借不到的 MCP 服务器 → 以显式原因失败」这条用户可见路径在 Live 宿主不可验证（宿主不渲染 UI，也构造不出「借不到 MCP」的运行），场景覆盖的是同一准备入口的代理；场景另断言恢复后披露块仍含探针技能，并以「冷写落盘 + 前置断言」证明「只有恢复路径自己的准备才能重新加载它」：恢复前绕开 `upsertSkill` 的指纹核对把探针 Skill 的新描述直接写到磁盘，断言此刻披露块仍是冷写前的旧描述（该窗口没有第二个同步调用点会刷新进程快照）；恢复后披露块必须出现仅存在于磁盘的新描述，只有恢复路径自己的能力准备会按指纹重新加载它",
      why: "进程被杀后无人决定的运行既不能自动重放（未知副作用），也不能把用户卡在一个没有出口的中断态里；恢复前能力面必须重新准备，否则续跑会拿中断前的旧能力面去重放",
      layer: "e2e",
      depth: "deep",
      scenarios: ["runtime-interrupt-resume", "runtime-interrupt-discard", "runtime-resume-capability-prep"],
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
      feature: "未预期延迟响应的挂起结算",
      description: "运行遇到上游未预期的延迟响应（suspended）时按失败如实结算并取消该 lane 操作，不挂死：waitForIdle 有界返回、下一次运行不被判忙（场景 runtime-compaction-suspended-settles 驱动的是普通回合；压缩续跑的同款挂起分支按同一「取消即结算」口径实现，未由场景单独驱动）",
      why: "只返回 failed 而不结算 lane 操作会让槽背上一个永不结算的操作：一次上游迟响应不能把会话永久判忙",
      layer: "integration",
      depth: "deep",
      scenarios: ["runtime-compaction-suspended-settles"],
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
      description: "协议提醒按会话收敛：markRuntimeDataMissing / clearRuntimeDataMissing / hasRuntimeDataReminder 以 sessionId 为键、进程内存不落盘，A 会话违约不提醒 B 会话；提醒文案 RUNTIME_DATA_REMINDER_TEXT 点名 RUNTIME_DATA 区块。buildPrompt 只在调用方传入可选入参 runtimeDataReminder 时产出一个 ephemeral:runtime-data 块（text 与传入值逐字相同、进入 systemPrompt 请求视图），不传时该块不存在。结算侧 mark/clear（完成回合缺区块标记、履约或无可写变量清除）与下一回合注入判定在 engine/harness/runtime.ts —— 本点的 L2 用例只验证状态、文案与请求视图三件套，不驱动该接线，接线的行为面尚无场景覆盖",
      why: "提醒是「上一回合违约」到「下一回合补一句」的唯一补救通道：状态不按会话隔离会提醒到别的会话，块无条件产出会让每回合都多一段本不该出现的协议要求，文案不点名区块则模型无法照做",
      layer: "unit",
      depth: "deep",
      scenarios: ["variable-runtime-data-reminder-state", "variable-runtime-data-reminder-text", "variable-runtime-data-reminder-block"],
    },
  ],
  // W0–W7 把 ar-18 / ar-22 的 memory-retry-policy-sync、runtime-compaction-suspended-settles
  // 迁出 L4 后按 L4 侧当前值重标定：门槛=当前 rules 声明值，只缩不放（数字由 checker
  // 报错提供）；跨层完整性（迁出点有没有被声明层真的跑着）由 checkLayerCoverage 负责。
  rules: { minScenarios: 25, minDeepScenarios: 24, requireBoundary: true, requireErrorPath: false },
}

export default agentRuntimeContract
