// 2026-10-05 设置页 Card 增删改查 + 模版批次：本契约 sourceFiles 中仅
// `crates/native-host/src/host/dispatch.rs` 变化 —— 新增一条 `personality_file_delete`
// 分派臂（命令矩阵 128→129），memory_* 命令的既有接线与错误语义未改。mm-* 逐点复核
// 行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— runtime.ts 与 context/builder.ts
// （RUNTIME_DATA 协议缺失检测与提醒：新增可选入参 runtimeDataReminder 与 ephemeral:runtime-data
// 块）。mm-* 逐点核对：mm-11 的 systemPromptHash「随瞬时块内容变化」口径已涵盖新增的
// ephemeral 块；mm-16 的块预算与淘汰按同一 ephemeral 通道处理；mm-29 的动态提示拼接与尾随
// 时间注记不受影响（提醒不携带时间、不进 composeDynamicPrompt）。其余点不在改动面内，
// 逐点核对实现点仍在、语义未变，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// provider_usage 快照、tokenDrift、purpose 分列与压缩素材链路未动）、src/services/debug.ts
// （updateRequestStats 真实 prompt 口径；debug.ts 在本契约的既有消费点不受影响）。mm-* 逐点
// 核对：mm-19 / mm-26 / mm-34 的 usage 记账、偏差对账与快照完整性语义未变，其余点不在改动
// 面内、实现点仍在。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与当前实现一致性
// 核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime/types.ts（新增
// CompactionDeclineRecord / CompactionTrigger / CompactionDeclineKind / CompactionOverflowDetail，
// CompactionAuditSink 增可选 decline）、harness/runtime.ts（createCompactionHook 新增
// noteDecline：empty_material / retained_tool / gate_fits / kernel_failure 四个拒绝结局全部写
// 结构化原因并各留一条统一日志，empty_material 原来完全静默）、harness/harness-slot.ts
// （compaction_end 在 status!=="completed" 且 failure 或 manual/overflow 的 decline 时落
// deskpet.compaction_declined 条目，threshold 只留日志；decline 用过即清）、compactor.ts
// （新增 describeCompactionFailure：错误码 + over_cap/oversized_unit 数字，经 engine barrel
// 导出）。用户可见文案与 declined/nothing/failed 三态映射零改动。
// mm-* 逐点核对：mm-25 按现状修订 —— 原描述只覆盖内核失败 decline 与 error 字段，现补
// 「策略性拒绝同样写结构化 decline 记录、manual/overflow 落审计条目、threshold 只留日志、
// decline 与 failure 语义分离」与内核失败 decline.failure 的错误码/超上限数字（修订理由见
// 该点描述）；mm-19 的摘要 usage 分列、mm-22 的溢出 declined 分类、mm-23 的 retain 守卫、
// mm-24 的审计落盘、mm-32 的闸门与 mm-33 的分片 fatal 逐点核对语义未变（新审计条目与日志
// 属 mm-25 的留痕面，不改各点已声明的终态、零提交与零请求断言）；mm-11 / mm-28 的快照归属
// 与换代身份、mm-34 的保留与 trace 不受影响；其余点不在改动面内、实现点仍在。
// 新增 L3/L2 用例（压缩拒绝留痕 / 压缩上限诊断）尚无 caseId 锚点，未登记进 scenarios
// （有实现无契约覆盖，属已知缺口，另行安排 caseId）；sourceHash 按当前源码刷新。
// 2026-10-05 复算补充（同一刷新轮）：复算时并发落进一处本批改动单之外的 context/budget.ts
// 变化（keepRecentTokens 上限改为随窗口长大：max(MAX_HEADROOM, min(80k, 窗口 × 1/4))，小窗口
// 逐字不变；并发写入，不在本批改动单内）。按当前源码复算，sourceHash 一并覆盖它；mm-21 的
// 保留窗口不变量经核对仍成立（keepRecent 仍是该上限与 normalInputTarget × 0.4 取小，故
// ≤ normalInputTarget < hardInputLimit；该点的 L3 用例按 contextBudget() 现算期望、随新公式
// 走）；其余点不在该改动面内。
import type { ModuleContract } from "../host/types"

export const memoryContract: ModuleContract = {
  module: "memory",
  sourceFiles: [
    "src/services/agent/memory/index.ts",
    "crates/native-host/src/memory/store.rs",
    "crates/native-host/src/memory/schema.rs",
    "crates/native-host/src/memory/mod.rs",
    "crates/native-host/src/memory/protocol.rs",
    "crates/native-host/src/memory/commands.rs",
    "crates/native-host/src/host/dispatch.rs",
    "src/services/agent/memory/ipc.ts",
    "src/services/agent/memory/protocol.ts",
    "src/services/agent/memory/provider.ts",
    "src/services/agent/memory/rerank.ts",
    "src/services/agent/memory/sources.ts",
    "src/services/agent/memory/visible-query.ts",
    "src/services/agent/memory/revision.ts",
    "src/services/agent/memory/dreaming.ts",
    "src/services/engine/runtime/snapshot.ts",
    "src/services/engine/runtime/types.ts",
    "src/services/engine/runtime/trace.ts",
    "src/services/engine/runtime/input-identity.ts",
    "src/services/error/failure-kind.ts",
    "src/services/engine/harness/runtime.ts",
    "src/services/engine/harness/model-gateway.ts",
    "src/services/engine/harness/harness-slot.ts",
    "src/services/engine/harness/delivery.ts",
    "src/services/engine/harness/session-repo.ts",
    "src/services/engine/harness/session-file-system.ts",
    "src/services/engine/compactor.ts",
    "src/services/engine/slash/commands/compact.ts",
    "src/services/engine/slash/commands/memory.ts",
    "src/services/tool/local-extra/memory.ts",
    "src/services/tool/policy.ts",
    "src/services/context/builder.ts",
    "src/services/context/kernel.ts",
    "src/services/context/budget.ts",
    "src/services/context/tool-output.ts",
    "src/services/debug.ts",
  ],
  sourceHash: "24b2461f454bbac9bd09461ff37f5a490d20be00527831f92d81086719791204",
  coverage: [
    { id: "mm-01", feature: "记忆来源准入", description: "只有 origin=user 且 taint=trusted_user 且 eligibleForMemory=true 的已提交条目能成为候选：助手台词、工具结果、压缩摘要、主动搭话、缺来源标记与 custom 控制条目一律出局；投递时刻冻结的 cardId 随来源落盘", why: "「谁说的」是记忆的唯一准入判据：把这些来源放进去，模型的一次措辞就会被当成用户长期事实", layer: "integration", depth: "deep", scenarios: ["memory-source-admission"] },
    { id: "mm-02", feature: "重排结果校验", description: "重排只接受候选白名单内的 id：未知 id、重复 id、非字符串、坏 JSON、散文与对象外形错误一律判无效并回退本地顺序，对象形态取 ids 字段；空数组是合法答案（这次不投影动态记忆），合法非空子集保序通过、不补回未选项", why: "模型只能决定「用哪几条」，不能决定「还有哪些」——白名单外的 id 会让不存在的记忆进入请求", layer: "unit", depth: "deep", scenarios: ["memory-rerank-fallback"] },
    { id: "mm-37", feature: "adaptive 选择门槛与调用边界", description: "只在动态候选超过6条时调用重排，core不参加；最多发送12个真实候选且受总输入预算限制，白名单只认已发送ID；合法空数组表示不投影动态记忆，非空只投影有序子集；写后刷新可显式跳过重排、不重复调用；精确反馈目标不参加重排并沿用同一次原子读取的revision", why: "重排的开销和模型可见范围必须由宿主冻结：候选太少不值得调用，未发送的候选不能进入白名单，合法的空选择不能被补回全部", layer: "integration", depth: "deep", scenarios: ["memory-recall-selection"] },
    { id: "mm-38", feature: "模型查询的可见范围", description: "memory_query 绑定本轮已提交可信用户事件，按该输入冻结的 Card 只查 user＋当前 Card＋当前 session；没有可信 Card 时不发起任意 Card 查询，工具执行传入的 scope 不接受模型自选管理范围", why: "独立工具路径不能绕过普通召回的 scope 隔离去读到其它 Card 或会话的记忆正文", layer: "integration", depth: "deep", scenarios: ["memory-tool-card-scope"] },
    { id: "mm-03", feature: "SQLite 记忆库生命周期与召回快照", description: "真实 Rust 记忆库：来源登记幂等且只收可信用户输入；两字中文查询靠短词回退命中；强相关命中优先于importance；user/current Card/current session scope隔离；pinned core无关键词读取并与动态候选共享revision快照；prepared候选不进召回，过期候选与遗忘来源不可见", why: "scope、revision、相关度、有效期与遗忘抑制必须在真实 SQLite 边界成立，不能由前端拼接假设代替", layer: "e2e", depth: "deep", scenarios: ["memory-store-lifecycle"] },
    { id: "mm-04", feature: "完整事实预算口径", description: "MemoryProvider按实际全文token数核算；正文超单条、tier或总剩余预算时整条淘汰，保留否定和条件，不裁事实前缀；预算内条目逐字不变，投影声明预算等于实际全文用量，多条总量不越界", why: "截掉事实尾部可能改变或反转语义，预算压力应丢低优先整条记忆而不是注入残句", layer: "unit", depth: "shallow", scenarios: ["memory-recall-token-budget"] },
    { id: "mm-08", feature: "多轮会话条目持久化", description: "真实多轮对话后可按 sessionId 从 sessions/ 下的 JSONL 读回完整换行正文；后续回合只新增条目不重放历史", why: "会话条目是真相源，UI 切换或重载不能改变读取目标", layer: "e2e", depth: "deep", scenarios: ["memory-multi-turn"] },
    { id: "mm-11", feature: "PromptSnapshot 的归属与身份", description: "三档快照（transform_context/provider_payload/provider_usage）可关联 request/turn/run；快照带请求归属（request.purpose/step/attempt）、参数（systemPromptHash 是整段 systemPrompt 的 hash：同一请求的三档必须一致，跨请求仍会随变量池、画像与瞬时块的内容变化而变（当前时间已移出 system prompt、改由尾随瞬时注记承载，不再是漂移源）—— 它只证明「同一次请求的三档没被换过」，不是配置指纹；payloadHash 与 requestParams 由 before_payload 从 Provider payload 采集，只落在 provider_payload 档、取不到就不写，不粘到同回合其它档）、计划与能力（plan/冻结的 capabilities.safetyMode 与逐请求累积的 toolDecisions）、槽代际（generation）、内核淘汰（budgetDrops）与换代身份（compaction.count、本分支最近一条压缩条目地址、摘要 hash）；一次性压缩请求以 one-shot:compaction 身份另立 payload+usage 两档条目，不写归属错误的主回合 payload（摘要正文只留 hash）；派生 rewrite 只保存 hash 与压缩条目地址；每条工具条目的 policyHash 取 toolPolicyHash(tool)，即策略指纹的 SHA-256：指纹含工具身份（id/source/sourceId）、策略版本、defaultDecision、effect/isolation/replay、resultProjection/historyCompaction、safetyLevel 与 actionCategory 共 12 项（原 `mode` 维度已随模式删除消失；策略版本已递增到 2，裁决语义变更前后写入的条目 hash 不同 —— 会话内 5 分钟的同参授权也随之不复用），这 12 项任一变即改变该工具在快照里的身份；投递输入的 agentMessages id 用其 deskpetEventId（无身份的用位置号回退），请求与输入的关联可按身份核对", why: "「这是哪次请求、带什么参数、第几代槽」必须能从快照回答：一次性请求不得写成归属错误的主回合快照", layer: "e2e", depth: "deep", scenarios: ["memory-snapshot-identity"] },
    // mm-11 原把「归属身份 + 保留/trace」合成一点（跨层混搭）；按层拆开：保留与 trace 侧为 mm-34（L3），归属与身份侧留在 mm-11（L4）。
    { id: "mm-34", feature: "PromptSnapshot 的保留与 trace", description: "快照保留顺序、hash 与 usage 区分（原始 Prompt 与密钥不落快照：systemBlocks 与 agentMessages 只存 hash），以及真实回合的 trace 完整性（provider_payload / provider_response / provider_usage 与 transform_context + provider_payload 双快照）", why: "上下文审计不能泄露原始 prompt、覆盖用户原文或把估算 token 当成实际 usage", layer: "integration", depth: "deep", scenarios: ["memory-prompt-snapshot"] },
    { id: "mm-13", feature: "工具成对观测", description: "工具调用与结果按 id 配对保留在会话条目，并被 runtime history 观测", why: "后续压缩和恢复需要完整 tool pair 基线", layer: "e2e", depth: "deep", scenarios: ["memory-tool-pair-baseline"] },
    { id: "mm-15", feature: "Plan checkpoint 恢复", description: "运行中 Plan 从会话条目 deskpet.plan_checkpoint 按事件级证据折迭恢复，产出可处置的 paused 计划（只读步骤回 pending；有 tool_start 无 tool_end 的效果工具进 unknown_side_effect，末事件是 tool_end 的取末事件回 pending）；plan 的唯一持久形态是 schemaVersion 2，旧格式条目（含存量 1）按不可恢复跳过、不做迁移；继续/丢弃由用户显式触发，未知副作用不自动重放，恢复动作可条目回读", why: "进程重启后不能重复执行没有完成凭证的外部操作", layer: "integration", depth: "deep", scenarios: ["memory-plan-resume"] },
    { id: "mm-16", feature: "上下文内核（纯预算）", description: "buildPromptBlocks 只做预算：窗口预算闭合（硬输入上限 + 输出预留 + 协议开销）、按层排序与拼接；核心块（静态人格/V1RTUAL/工具协议/工具 schema/动态运行时/会话摘要）放不进硬上限时显式 ContextBudgetError、绝不截块内文字，可选块整块淘汰并记入 budgetDrops；分配账目按层给出实际 requested/used（transcript 行保留但没有名义份额或借用字段，没有淘汰的层不写 dropped: 0）；完整静态前缀不随变量变化、工具 schema 完整计入输入预算；含会话正文的完整请求视图由托管钩子按同一硬输入上限核查（mm-22 的溢出恢复依赖它）", why: "Provider 输入需要可预测且可审计地限制在上下文窗口内，且不能静默丢失指令或未压缩历史", layer: "unit", depth: "deep", scenarios: ["memory-context-budget"] },
    { id: "mm-17", feature: "记忆投影形态与召回端口", description: "记忆块以 custom 消息投递（不是 system 消息）、不进 transcript、eligibleForMemory=false，判定函数只认专用 customType；MemoryProvider 可注入、取消、限时、裁剪并恢复，默认空实现不执行长期召回", why: "画像与长期事实必须留在派生数据一侧：一旦以 system 身份注入，它就成了指令，而召回内容还可能在下一轮被当成用户新事实重新提取", layer: "unit", depth: "deep", scenarios: ["memory-profile-rewrite"] },
    { id: "mm-18", feature: "消息条目单次写入", description: "一次真实回合后同一句话只有一条 pi 会话条目；后续回合不重复追加历史消息", why: "双写或历史重放会让重载出现重复消息与翻倍轮数", layer: "e2e", depth: "deep", scenarios: ["memory-single-message-write"] },
    { id: "mm-19", feature: "Harness 压缩与摘要内核", description: "手动/阈值压缩由 Harness 调度：宿主 before_compaction 生成结构化摘要并提交 compaction 条目，原始消息条目全部保留，contextEpoch 推进；摘要调用的 usage 落压缩条目并按 purpose 单列，不冒充主回合统计；摘要素材自身也走与请求视图同一套阶梯与投影（measureCompactionMaterial 是素材度量的唯一出口，级 0/1/2 与主请求共用 projectToolResultText 与同一份地址目录；两路同 level 逐字相同、素材级别 ≤ 视图级别，见 mm-27）：resultProjection=preserve 的工具结果正文逐字原样进入摘要请求 —— 只挡缩短/清空，不挡地址标注，同样带唯一前缀地址尾行；reference 的才被缩短并留下回读标记；素材超硬上限时按 planCompactionShards 串行分片（assistant 与其 toolResult 是不可分单元），第 N−1 片产出回填第 N 片 previousSummary，K 片 usage 合计后只提交一次（compaction 条目恒为 0 或 1 条）；「原文条目保留」同时覆盖折叠路径：压缩过的会话经生产折叠入口后，压缩前已有的条目 id 与 JSON 逐字不变、compaction 条目仍在、聊天视图正文序列不变", why: "摘要只能替换后续请求视图，不能删除会话真相源，也不能把压缩调度留在宿主第二套状态机里；一次性摘要的成本既不能混进主回合统计，也不能在总量里消失；素材超硬上限不能退化成「会话永久无法压缩」，分片必须是全量覆盖且只提交一次（部分覆盖或多次提交都会让历史视图悄悄分叉）", layer: "e2e", depth: "deep", scenarios: ["memory-compaction-checkpoint", "memory-summary-preserve-projection", "memory-compaction-shard-iterate", "memory-compaction-fold-integrity"] },
    { id: "mm-20", feature: "上下文窗口下限", description: "低于 65536 的窗口被拒绝：设置保存报错、运行期在模型解析处报错，合法窗口照常解析且不超过配置值", why: "窗口过小时压缩找不到可摘要范围，静默接受只会把预算问题推迟成运行期的另一种报错", layer: "integration", depth: "shallow", scenarios: ["memory-context-window-floor"] },
    { id: "mm-21", feature: "压缩阈值口径换算", description: "派生的 reserve/keepRecent 换算到 Harness 的计数口径：阈值落在本仓 normalInputTarget 上、先于宿主硬预算触发，保留窗口放得进消息空间，且估算器偏差不越过硬预算余量", why: "Harness 的 shouldCompact 在会话存在 provider usage 时按真实 usage 计，本仓估算同为目标真实 token 口径；估算器偏差一旦吃掉硬预算与正常输入目标的差额，硬预算就会先于压缩报错", layer: "integration", depth: "shallow", scenarios: ["memory-compaction-threshold-calibration"] },
    { id: "mm-22", feature: "硬预算超限的溢出恢复", description: "宿主 transform_context 核对出的硬预算超限经网关上报为 Provider 溢出响应，Harness 用宿主 before_compaction 摘要压缩后重试一次；超限请求不发给 Provider，压缩只改请求视图，原文条目始终保留。恢复用尽时按可解释的硬预算判定失败；上游因没有可安全摘要的范围 declined 时，失败分类保留上游文案，回复仍回落本回合的硬预算判定", why: "硬预算只是发送前的本地上限，直接终止回合会让 Harness 自带的一次性溢出恢复永远轮不到；恢复既不能改变会话真相源、不能把压缩挪到重试之后，也不能让用户丢掉可解释的预算判定", layer: "e2e", depth: "deep", scenarios: ["memory-budget-overflow-recovery"] },
    // mm-22 原把「恢复 + 分类」合成一点（跨层混搭）；按层拆开：分类侧为 mm-35（L3），恢复侧留在 mm-22（L4）。
    { id: "mm-35", feature: "硬预算拒绝的上报形状与失败分类", description: "本地硬预算拒绝以「上游认得出」的响应上报（length 停止 + 输出 0，命中 isRecoverableLength/isContextOverflow），普通投影错误不算溢出；失败分类只由「它是本地判定」决定，不随判定文案里估算数字的形态漂移（长数字串里的 5xx/401/429 片段不算状态码，真正的状态码仍命中对应分桶）——分类实现收敛在 src/services/error/failure-kind.ts 一处（生产回合结算与场景共用同一份正则表）", why: "本地拒绝先于请求发生，没有真实 provider 文案可命中上游溢出判据，上报形状是让一次性恢复轮得到的前提；分类不得把本地失败记成 Provider/认证/限流故障", layer: "integration", depth: "deep", scenarios: ["memory-budget-overflow-classification"] },
    { id: "mm-23", feature: "retain 保留守卫", description: "摘要范围覆盖声明 historyCompaction=retain 的工具调用配对时，宿主 before_compaction 内核 decline：不向模型发出摘要请求、不提交 compaction 条目、不推进换代身份，原文条目保持完整；注销 retain 声明后同一会话与同一载荷照常压缩。retain 是有意保留的能力（O-1 裁定 B）：生产工具目前全部声明 summarize，本覆盖点由测试场景驱动、字段不删", why: "宁可不压缩也不能把必须保留原文的调用配对静默摘要掉：覆盖边界一旦越过它，未覆盖历史就被模型输出的摘要顶替", layer: "e2e", depth: "deep", scenarios: ["memory-retain-guard"] },
    { id: "mm-26", feature: "估算器角色覆盖与偏差对账", description: "内容投影按角色表覆盖 compactionSummary/branchSummary/bashExecution/custom（摘要只计 summary 正文、excludeFromContext 的 bash 执行计 0），未知角色按整条估算并留痕；provider_usage 快照记录 tokenDrift（estimated/actual/ratio），超 ESTIMATE_DRIFT_WARN_RATIO 只 warn 与 trace 带 driftRatio，不改变预算判定", why: "估算器系统性漏算某类消息会让硬预算与压缩触发点整体漂移，估算与真实 usage 的偏差必须可见才能定位", layer: "integration", depth: "deep", scenarios: ["memory-estimator-role-coverage"] },
    { id: "mm-27", feature: "L0 地址完整性", description: "工具结果的回读地址是条目 id 的唯一前缀（shortenAddresses 在当次 id 全集上取最短唯一，下界 MIN_ADDRESS_PREFIX=8；槽级缓存已发出的地址，仍唯一就复用、失效才重算 —— D-W2-8，故长度不是契约；读取端 resolveAddressRef 给 exact/unique/ambiguous/none 判别联合，完整条目 id 永远 exact 命中，前缀命中多条绝不任选）；地址无条件标注 —— 超阈值与否都带 `[回读地址 eventId=<前缀>，可用 read_session_event 分页读取]` 尾行，未缩短的结果同样带，preserve 的结果只挡缩短/清空、照带地址；无地址的结果不写假 eventId（缩短形态标「不可回读」占位串，未缩短形态不追加任何行）；无地址留痕按内容指纹（长度 + 首 NO_ADDRESS_WARN_KEY_CHARS=32 字符）分键去重、同键只报一次，集合有界（NO_ADDRESS_WARN_KEYS=64，满员按插入序 FIFO 淘汰最旧；淘汰分支当前无场景断言，按实现事实记录）；主请求与摘要素材共用同一份地址目录与投影实现，同一 level 下逐字相同、素材级别 ≤ 视图级别（素材升档判据 hardInputLimit、视图 normalInputTarget）", why: "回读地址是模型从缩短结果回到真相源的唯一通道，假地址会让模型读到「当前会话没有此工具结果」", layer: "e2e", depth: "deep", scenarios: ["memory-l0-address-integrity"] },
    { id: "mm-24", feature: "审计落盘闭环", description: "审计条目只入队、由唯一 flush 入口在 lane 空闲时写入；失败条目保留并重试一次；槽关闭前 flush 且残留非空记 error；transform_context/provider_payload/provider_usage 三档快照在一轮 production 回合里各至少一条且释放槽后集合不变", why: "证据链的组成项不能在槽生命周期结束时静默消失，否则「请求发过什么」这件事在重启后不可查", layer: "e2e", depth: "deep", scenarios: ["memory-snapshot-audit-closure"] },
    { id: "mm-25", feature: "摘要降级显式 decline", description: "宿主摘要内核失败时钩子返回 decline 而非抛出：/compact 报 failed 并在用户可见文案里给出原因；不提交 compaction 条目、不推进换代身份（readContextEpoch 与槽快照同为 0 —— decline 不是提交）；回合路径写 deskpet.compaction_declined 审计条目 —— 内核失败带 error 字段（原因文案；manual/overflow 触发的条目另带 decline.failure：错误码 + over_cap/oversized_unit 数字，经 describeCompactionFailure 映射），策略性拒绝（empty_material / retained_tool / gate_fits）在 manual/overflow 触发时同样落条目并带结构化 decline（kind/trigger/sessionId/关键数字），threshold 是每个检查点都会重试的内部优化、只留统一日志不落盘；decline 与 failure 语义分离（策略性拒绝不写 error、不翻用户文案），decline 记录用过即清；四个结局各自留一条统一日志（empty_material 此前完全静默）；失败路径不产生任何宿主之外的摘要正文 —— 助手正文序列逐字不变、provider 请求增量恰好等于内核摘要请求数（直接区分「钩子 decline」与「钩子抛错被上游回退通用英文摘要」两个世界：后者会多发一次请求并提交一条不可回滚的摘要）", why: "上游通用英文摘要一旦提交就成为后续所有回合唯一的历史视图且不可回滚，宁可不压缩也不落违反协议的历史；decline 也不能顺手推进请求视图的换代身份；策略性拒绝同样没有用户可见原因（上游 declined 终态不带 error），审计条目与统一日志是它唯一的留痕出口 —— 不写就无从区分「素材为空」「保留守卫」「闸门装得下」与「超上限失败」", layer: "e2e", depth: "deep", scenarios: ["memory-compaction-degrade-declines"] },
    { id: "mm-28", feature: "上下文换代身份沿分支", description: "context epoch 由 delivery.ts 的 readContextEpoch 沿 lane 分支回溯已提交 compaction 条目得出；槽快照、请求快照与设置页显示共用它；读失败不写 0；K 片分片压缩仍只提交一次 compaction 条目，换代身份因此每次压缩只推进一次（不按片计数）", why: "换代身份必须按分支算：会话级全量计数会把其它分支的压缩算进来，未知时写 0 会让快照谎称请求视图未换代", layer: "e2e", depth: "deep", scenarios: ["memory-context-epoch-branch"] },
    { id: "mm-29", feature: "动态提示与思考强度文案", description: "聊天动态提示由 composeDynamicPrompt + CHAT_THINKING_HINTS 唯一拼接：变量池正文 [+ 强度后缀]，**不含当前时间**；一次性调用不经过这条拼接，非推理模型 + low 档时的兜底提示是 ONE_SHOT_LOW_EFFORT_HINT，两者刻意不同。当前时间由 currentTimeNote 唯一生产（`[当前时间] YYYY-MM-DD HH:mm 周X`，26 字符、分钟精度），再经 createTurnNoteMessage 作为 **custom 尾随瞬时注记**逐请求附在请求视图**最末** —— 不出现在 buildPrompt 的任何块、systemPrompt 或 staticPrefix 里。落位理由是前缀缓存：缓存只在第一个差异处之前命中，而 system prompt 整体排在会话正文之前，每回合变化的内容留在那里会让整个会话正文每轮重新计费；附在消息数组末尾时差异点落在「本来就是新的」那一段，不额外损失缓存。注记带 eligibleForTranscript/eligibleForMemory = false，并被 isTransientInputMessage 判为瞬时输入（token 归 ephemeral 行，不虚增 transcript 行）", why: "文案散落三处时改一处就分叉，且没有任何断言拦它；system prompt 必须逐字节稳定，否则会话正文的前缀缓存每轮作废", layer: "integration", depth: "shallow", scenarios: ["memory-prompt-composition"] },
    { id: "mm-30", feature: "窗口下限错误的归因", description: "模型解析处报出的窗口下限错误区分「模型目录窗口与配置取小」：指出模型 id 与配置值并建议换模型；设置页校验文案不变", why: "把模型能力问题报成配置问题会让用户去改一个本来合法的值（无可修旋钮）", layer: "integration", depth: "shallow", scenarios: ["memory-context-window-message"] },
    { id: "mm-33", feature: "摘要素材分片与上限失败", description: "摘要素材按硬上限分片：规划器 planCompactionShards 把 assistant 与其 toolResult 串成**不可分单元**（工具批次原子性——绝不把一条 tool call 与其结果拆到不同片），贪心装箱到 COMPACTION_SLICE_RATIO = 0.8 的片预算，非法起点并前，两种 fatal 用可区分原因明确失败而不是尽力而为：`oversized_unit`（单条素材本身超硬上限，used = 单元成本 + overhead、limit = hardInputLimit、needed = ceil(used / sliceBudget)）与 `over_cap`（片数超 MAX_COMPACTION_SLICES = 8），抛 CompactionOverflowError（code = COMPACTION_MATERIAL_OVER_CAP，detail = { reason, needed, used, limit }）且**零 provider 请求、零提交**。**fatal 存在时 `ranges` 恒为空数组**（判片数必须先判 fatal）。摘要内核按片**串行**请求（不并行），第 N−1 片的产出回填为第 N 片的 previousSummary，K 片 usage 合计，最后**只提交一次**。素材度量由 measureCompactionMaterial 单点产出（overhead + Σcosts === used 是构造性恒等）。真实链路的 preserve 载荷分片迭代见 `memory-compaction-shard-iterate`（mm-19 名下）", why: "问题 B 的根因是「素材超硬上限即抛错 → decline → 上游放弃」，约 12 条满额工具结果即可触发且此后阈值/溢出//compact 全部同样失败（会话永久无法压缩的高危洞）。分片是唯一能同时满足「不丢内容」与「装得下」的改法；而工具批次若被拆开，摘要会看到半截工具对，那是静默的语义损坏", layer: "unit", depth: "deep", scenarios: ["memory-compaction-shard-plan"] },
    { id: "mm-32", feature: "手段阶梯与闸门", description: "工具结果压缩改为按**激进度**排的分级阶梯（级 0 不动 → 级 1 缩短 → 级 2 清空 → 级 3 摘要），规划器 planToolResultLadder 只认一个「装得下」判据：请求视图估算 ≤ contextBudget(window).normalInputTarget（运行期口径，不传 maxOutput），升到装得下就停、不做无谓升档。级 1 与级 2 共用同一个「单条上限」（校准时只调一个旋钮）；**级 2 的硬前提是必须有地址**——无地址的结果永远停在级 1（清空后捞不回来才是灾难），实测无地址 + 级 2 的输出与级 1 **逐字相等**。级 3 前是**闸门**（纯函数 ladderGate，与投影同一个 measure）：before_compaction 先跑级 1/2 的零成本阶梯，压完视图装得下就不花摘要调用（**一次摘要 LLM 都不花**）；压完仍装不下才走级 3；仅 reason === \"threshold\" 生效，manual/overflow 与缺 systemPrompt/buildGate 一律安全回退为照常摘要。**闸门自身的 decline 分支在当前 production 阈值路径上不可达** —— 实测由前置守卫「摘要范围为空」先拦截，场景钉住的是 0 次调用这个事实；不得据此宣称用户可见的「策略性不压缩」行为。", why: "零成本手段只有一档时，要么压缩失败（会话永久无法压缩）要么白花一次 LLM。本覆盖点是问题 C 的唯一出口，同时钉住「装得下」只有一个判据、级 2 只有一个硬前提，避免第二份判定链", layer: "e2e", depth: "deep", scenarios: ["memory-projection-ladder", "memory-ladder-gate"] },
    // mm-32 原把「阶梯/闸门 + 保护区」合成一点（跨层混搭）；按层拆开：保护区侧为 mm-36（L2），阶梯与闸门侧留在 mm-32（L4）。
    { id: "mm-36", feature: "工具结果阶梯的保护区", description: "**保护区**（LADDER_PROTECTION_TURNS = 3，轮口径取上游 findTurnStartIndex：user/bashExecution 开轮，toolResult/assistant/custom/compactionSummary 不开轮，不足 N 轮全保护）**只挡级 2 与级 3，不挡级 1**——级 1 是无损缩短，保护区内照做", why: "没有保护区的清空会把用户刚说的话也清掉；轮口径必须与上游 findTurnStartIndex 同源，否则保护边界整体错位", layer: "unit", depth: "deep", scenarios: ["memory-ladder-protection-zone"] },
    { id: "mm-39", feature: "记忆 revision 的进程内分发", description: "publishMemoryRevision / subscribeMemoryRevision 是 Node 领域侧的进程内总线（L3）：订阅者收到已提交的 revision（含 await 到全部消费者处置完成再返回的本地语义），退订后不再分发；跨窗口同步（旧壳 deskpet-memory-revision-changed/-applied）不属 Node 图 —— 单 Node 架构下所有提交都发生在本进程，订阅与发布都在本地完成", why: "revision 是「已提交」的通知值：丢弃它会让 runtime 对陈旧投影继续应答；退回事件回环则把纯 UI 的窗口协调重新塞进 Node 领域面", layer: "integration", depth: "shallow", scenarios: ["memory-revision-local-dispatch"] },
    { id: "mm-40", feature: "保留窗口随窗口长大", description: "`keepRecentTokens` 的上限**不与压缩余量共用 `MAX_HEADROOM`**：先 `max(20_000, min(80_000, ⌊窗口 × 1/4⌋))` 得到本次上限，再与既有的 `⌊normalInputTarget × 40%⌋` 取小。小窗口仍被 20k 兜住（与拆封顶之前的旧口径逐字相同，不回退），大窗口才松开——128k 窗口 20_000→32_768、200k→50_000、1M 在 80_000 封顶；比例项不变保证保留窗口永远吃不掉输入目标，压缩之后请求必然缩小；曲线随窗口单调不减", why: "两个量性质不同：压缩余量是**压缩调用自身的操作开销**（固定封顶是对的），保留窗口是**给用户的近期上下文**（该随空间涨）。共用封顶会让窗口越大越早、越狠地压掉历史——200k 与 1M 窗口下占窗口的比例越来越小", layer: "unit", depth: "shallow", scenarios: ["memory-keep-recent-scaling"] },
    { id: "mm-41", feature: "策略性拒绝的留痕", description: "策略性 decline（`empty_material` / `retained_tool` / `gate_fits`）在 manual / overflow 触发时落 `deskpet.compaction_declined` 条目，带结构化 `decline`（kind、trigger、sessionId、关键数字如 messagesToSummarize / retainedMessages / tokensBefore / keepRecentTokens），并在统一日志里留一条可读原因；`threshold` 只在日志留痕、不落条目（它是每个检查点都会重试的内部优化，落盘会逐回合累积噪音）。用户可见文案不变：`declined` 仍映射 Card 的 `compactDeclined`，**不并进 `failed`**（条目 `error` 字段必须为空），也不并进 `nothing`", why: "拒绝不留痕时，用户与开发都无法回答「为什么没压」——实测一次 44 条会话的手动压缩被判 declined，会话与日志同时零痕迹，只能靠回放 journal 复算才查出是「素材全在保留窗口内」（6,686 token < 20,000）", layer: "integration", depth: "shallow", scenarios: ["memory-compaction-decline-audit"] },
    { id: "mm-42", feature: "压缩失败诊断的可判定性", description: "`describeCompactionFailure` 把摘要素材规划的两条 fatal（`over_cap` 片数超上限、`oversized_unit` 单元超硬限）描述成**可判定的错误码 + 全部数字**（需要片数/上限、单元成本/上限），普通错误与预算错误**不得冒充** overflow 形态", why: "「压不动」和「没得压」是两条完全不同的处置路径：前者要调上限或改分段，后者什么都不用做。描述层含糊会让用户和诊断都分不清该走哪条", layer: "unit", depth: "shallow", scenarios: ["memory-compaction-overflow-diagnostic"] },
  ],
  // W0–W7 把本契约的场景迁出 L4 后按 L4 侧当前值重标定：门槛=当前 rules 声明值，
  // 只缩不放（数字由 checker 报错提供）；跨层完整性由 checkLayerCoverage 负责。
  rules: { minScenarios: 17, minDeepScenarios: 17, requireBoundary: true, requireErrorPath: true },
}
