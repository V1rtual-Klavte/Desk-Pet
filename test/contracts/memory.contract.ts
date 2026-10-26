// 2026-10-26 聊天评测消息绑定（本批刷新）：sourceFiles 中 engine/harness/delivery.ts 新增
// readRequestResponse（按 requestId 取证回复，首次 run 的 fromTipId=null 按会话开头处理）；
// readContextEpoch 与压缩换代口径未变。mm-* 覆盖点未修订，仅按当前源码刷新 sourceHash。
// 2026-10-24 契约覆盖复核批次（analyze 定向）：sourceFiles 补入
// `src/services/agent/memory/ref.ts` —— mm-76 的 id@version 拆解行为真正定义在这里，
// 此前只列了导出它的 memory/index.ts。mm-76 的覆盖描述与三个 caseId 未变，其余 mm-* 未修订；
// sourceHash 按当前源码复算。
// 2026-10-24 话题去重窗探针批次（定向复核）：sourceFiles 中 proactive/store.rs 仅新增
// Rust 单测（scan 只回传 30 天内使用过的 topicKey、窗外行随扫描清理），记忆整理、召回与
// 引用路径未改；mm-* 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-24 整理取消/失败窗口批次：dreaming.ts 在模型返回后、批次 checkpoint 后与提交前
// 分别重核取消信号（晚到响应只结算预算，不写候选、不提交），失败路径保留已推进水位并回收
// 作业；新增 mm-82（4 个 L3 caseId）。同批补齐 mm-44 早已登记但无测试的
// dreaming-slot-restart-no-replay 与 dreaming-claimed-slot-restart-no-replay（模块重载/崩溃遗留的
// claim 槽跨重启不重放）。sourceHash 按当前源码复算。
// 2026-10-24 故障槽恢复与共享图片批次（定向复核）：sourceFiles 中 runner.ts 的用户消息入口
// 新增故障槽显式恢复（recoverFaulted → dispose），harness-slot.ts 新增 isFaulted/recoverFaulted
// （open() 仍不静默重建）；manager.ts 的删会话图片清理新增跨会话引用过滤。记忆读取、写入与
// 整理调度不经过这两条路径，mm-* 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-24 计划抗漂移批次（定向复核）：checkpoint 的记录形态新增可选 dependsOn（随步骤记录
// 持久化，缺省不写），mm-15 的恢复语义补一句「依赖已完成步骤视为满足、缺失/跳过/失败的前序
// 步骤让后继按未满足跳过」；跳过判定与结果格式归 planner pl-06/pl-07。harness-slot.ts 的
// 可回读命名空间扩为「工具结果 + 计划步骤产出」（跨类前缀唯一性、未命中文案改「当前会话没有
// 此条目」），该读取面归 tool-execution te-13/te-45，mm-15 只持有恢复侧的 readStepResults；
// host/types.ts 的 plan-start 载荷新增 summary 归 planner pl-12；runtime.ts 的可信用户原文与
// 规划器权限面归 planner pl-01/pl-13。mm-* 其余点逐点核对实现点仍在、覆盖描述与当前实现
// 一致（描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-24 时间语义与引用溯源批次：事实投影、证据包与管理详情保留 observedAt/validFrom/
// validTo/eventAt/expiresAt，按日锚输出本地日期、分钟锚输出带时区偏移时刻；纠正与合并让旧
// validTo 与新 validFrom 同刻衔接，合并保留最早已知起点。mm-78 登记 2 个 L2 caseId。助手回复
// 实际渲染的条目 id 写入 deskpet.memory_citations，重建索引登记 conversation_index_entry_refs，
// 检索/上下文/锚定读取统一排除引用已消失条目的助手转述（用户复述不受影响）；mm-79 登记 2 个
// L2 caseId；runtime 自定义条目写入接线尚无独立 L2/L3 断言，登记为已知缺口。
// 更正闭包（2026-10-24）：条目被内容/时间不同的活动版本取代后，旧版本来源原话、同轮锚定
// 转述与按有效区间判定为旧版本的助手转述一并退出召回；同值更新不触发。该行为由
// conversation.rs 的 Rust 单测直接覆盖，L1 不进 caseId 账，未新增 scenarios。
// sourceHash 按当前源码复算。
// 2026-10-24 计划 schema v3 与恢复交接批次：mm-15 的持久形态更新为 schemaVersion 3
// （新增冻结的 intent 与终态 completion；旧版本仍按不可恢复跳过、不做迁移）；新增
// readStepResults 从 plan_step_result 条目回读步骤结果（同 stepId 后写覆盖先写、形状不合跳过、
// I/O 失败降级为空），恢复执行据此注入前序交接；runtime 侧只把 stepId 有限的结果交给执行器。
// plan_step_result 条目新增 title 与 acceptance（verified/unverified）字段。恢复判据本身
// （累计副作用证据、paused 重扫、未知效果拒绝）未改。sourceHash 按当前源码复算。
// 2026-10-23 提醒拒绝与计划恢复批次：mm-15 的恢复判据更新为步骤累计副作用证据、暂停计划内
// 再次中断与同进程 prepareResume 只重分类 interrupted；mm-77 登记拒绝提醒不改事项版本、写抑制
// 并阻止重新派生；schema v6 新增 proactive_reminder_suppressions（选择性记忆恢复不触碰当前
// 安装的抑制记录，事项清除或整理删除后随闭包修剪）。sourceHash 按当前源码复算。
// 2026-10-20 列项修正：弃答句由已校验列项替换（mm-74）；枚举证据按会话轮转覆盖完整回合（mm-72）；
// 最终阅读策略优先结构性限制（工作/居住/预算等），不只列现有爱好。
// 2026-10-18 统一调度与子运行：手工 analyze/generate 声明修订；测试已写未运行，sourceHash 留统一验收复算。
// 2026-10-18 列项答案补全：新增 enumeration-answer.ts（缺失项判定/语言匹配后缀），runtime 在
// afterResponse 剥离与拟人变换之后、提交之前补全，并让结算回复采用与 JSONL 条目同源的补全正文；
// mm-74 登记 5 个 L2 边界与 1 个 L3 提交/结算同源 caseId。
// 2026-10-18 B2C：conversation.ts 新增有界同线程邻接补全，query.ts 改写提示允许语料校验后的方面候选词，
// projection.ts 读者允许相邻原文直接写明的同类项目；mm-72 登记 7 个 L2 caseId。
// 2026-10-18 B2：新增 conversation-key.ts / selection-score.ts；查询计划增加 aspectQueries，
// 会话准入按事件计数、完整回合优先，确定性选择分接入 admission/rerank/coverage；mm-71 登记 11 个 L2 caseId。
// 2026-10-18 整理诊断批次：dreaming.ts 的 parseReviewCandidates 在整批候选无效时把拒绝原因
// （content-empty / kind / scope / sourceIds-unknown）带进错误信息，便于定位模型输出漂移；
// 校验结果、成功路径、提交语义与既有覆盖点不变，sourceHash 按当前源码复算。
// 2026-10-17 缺口扩读定向复核：mm-66 只按未满足required、count uncertain或inference未决answer引用补读；
// 无引用线索保留笔记兜底，明确缺口已尝试后不复活已支持/排除/可选旁支；三条L3观察真实回调参数及停止状态。
// 2026-10-17 按需上下文批次：复核 mm-03/58/61/63/65/66 及 runtime 回调；英文词表共用、
// 普通首读不再按剩余空间扩读，缺口引用驱动分页，显式回顾保留全文；新增 L2/L3 反例并增强多轮 L4。
// 2026-10-17 analyze/generate：mm-59/62 复核倾向题的原话保留、非排他索引与整回合预算；
// 直接历史/计数仍走核对来源边界，推断表仅驱动补查，不作为最终结论白名单。
// 新增合法但漏选的读者输出反例与预算配对；真实 JSONL 原话经 runtime 到主请求，fake 不证明模型语义。
// 2026-10-16 回答范围 analyze/generate：mm-59/62 保留所有检查引用与完整回合，
// required+supported 汇总 answerSourceIds，未检查旁支淘汰，partial 原池回退与预算原子降级；
// mm-66 预算配对夹具增大原文以进入补查分支，并断言 retrieve/validate 真被调用。
// 2026-10-16 analyze/generate: mm-62 复核同请求引文重验、短别名重映射和来源/语义失效；mm-66 复核仅缺口词补查、后轮空笔记/范围缺失与新矛盾优先。fake 覆盖接线，语义质量另用固定证据真实模型诊断。
// 2026-10-16 同步复核：保留第三人称历史 mm-65/mm-66 与 Windows cwd/光标事件变更的各自覆盖归属，按合并后的 sourceFiles 重新计算源码指纹。
// 2026-10-15 Windows 路径验收 analyze -> generate：session-repo.ts 仅规范化 Windows cwd 标识与显式 cwd 列举筛选，JSONL 提交/读取/折叠和记忆来源规则不变；回归用例归 harness-storage hs-11，memory 覆盖点与 caseId 不变。
// 2026-10-15 Windows UI 验收 analyze -> generate：types.ts 只删除无 Node 消费者的光标事件，记忆命令/请求/回执形状不变；本契约 coverage/caseId 不变。
// 2026-10-15 证据义务analyze→generate：mm-61审查显式required/supporting解析与拒绝降级；
// mm-62/66审查主请求边界及仅必要缺口补查；mm-68审查受控obligation诊断枚举。
// 直接消费者与既有历史/主体/预算/取消用例保留，新加schema、缺口和sendMessage反例；真实语义另做小样本。
// 2026-10-14 P3：短引用只接受当次别名再映射真实来源，complete阅读按相关原文/完整配对聚焦主请求；
// 去重只合并同原条目/版本/信任/角色的逐字包含片段，信息增量停止并退休撤销来源的指南；
// premise/detail分别核对主体事件与所求细节，确证前提冲突停止补查；ID审计分页保持隐私上限。
// mm-55/61/62/66/68及直接消费者逐项审查，新增L2/L3定向断言；L4五个fake回包随格式同步。
// 2026-10-13 改写关闭思考（本批刷新，承上一条）：sourceFiles 中 agent/memory/query.ts（改写调用 thinkingEffort low→off，
// 信封仍走 memorySelectionOutputBudget）与 test/unit/memory/联合记忆召回.test.ts（断言同步为新定档）变化；改写产出
// 仍过落地校验，mm-* 逐点复核未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-13 记忆侧 token 优化（本批刷新）：sourceFiles 中 agent/memory/dreaming.ts（review/merge 一次性调用显式
// thinkingEffort=low，原为不传参=服务端默认；与业界整理侧低档口径对齐）与 agent/memory/budget.ts
// （memorySelectionOutputBudget 思考余量 512→4096：MemoryBank 终态实测低档思考顶穿旧尺，21/90 次改写
// status=length 截断回退，白烧 61k 输出）变化；召回/投影/排序语义不变，mm-* 逐点复核实现点仍在，
// 仅按当前源码刷新 sourceHash。
// 2026-10-10 整理水位推进修复（本批刷新，定向复核）：sourceFiles 内容变化 —— memory/store.rs 的
// job_checkpoint 新增 coveredSourceIds，批内水位按「批内每个会话」各自推进（旧实现只推游标所在
// 会话，批中段会话的来源留在水位之后、下个作业整段重读；LongMemEval S 实测头部来源被处理 10/10 次）；
// memory/commands.rs 与 host/dispatch.rs 加同名可选参数，agent/memory/ipc.ts 与 dreaming.ts 按批内
// 已处理来源传参，host/types.ts 的命令形状同步。行为面不变（水位仍是 per-session MAX(seq) 单调推进，
// pending 判定与墓碑口径未动）；新增 Rust 单测 job_checkpoint_advances_watermarks_for_every_covered_session
// 钉住修复（退回复修先见红），两处既有断言随签名机械更新（caseId 保留）。未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-10 阅读口径第三批（全量复核后收口）：52 题全量把总体从 90.4% 抬到 96.2%（abstention 10/10、
// preference 与 knowledge-update 各 100%），但 multi-session 的「数项目」题由对转错 —— 「计划≠已发生」
// 被过度应用，把 currently leading 的在办项目也排除掉。据此把该条收口为「已完成**或进行中**的动作算已
// 发生，只有 thinking of / about to / 打算 / 计划 才算未发生」，reader 提示与作答策略同步。契约描述与
// 断言随之更新，sourceHash 同批重算；仍需按探针复核该题。
// 2026-10-10 阅读口径补修第二批（同批刷新）：在上述两条之外再补 —— missing 项不得用相似事实充当答案主体
// （先说明该条件无法从记录确认，相似事实只能作附带说明）、第一人称已完成动作（decided/did/started 带
// today/yesterday）按已发生处理而与 thinking of/about to/计划 区分、supported 个人证据由「应落实」改为
// 「必须落实、不得只给与用户无关的通用建议」。mm-61/mm-62 描述同批补入；单次探针（5 题）显示 conflicted
// 计数归零、852ce960 与 gpt4_7f6b06db 由错转对，仍需全量复核，故不改 minScenarios。sourceHash 同批重算。
// 2026-10-10 阅读口径补修（本批刷新，analyze→覆盖描述同步）：sourceFiles 变化 —— projection.ts 的
// MEMORY_READING_POLICY 与 reader.ts 的阅读器系统提示各新增两条口径：(1) 同一事实/事件存在多条时间
// 不同的记录时按时间序解释，更晚的确认记录更新先前值（用户当前纠正优先），能消解即标 supported 并在
// condition 写明采用与被更新的记录，仅同一时点互斥或先后无法判定才标 conflicting；(2) 相对时间问句
// （如上周末/多少天前）先按题面给出的当前时间换算成日期区间再与记录时间比对，不因原文未出现相同表述
// 而标 missing。作答侧补「supported 已覆盖问句所需条件时直接给出结论，不以看不出/不敢确定/没翻到收尾」。
// mm-61 补冲突消解与相对时间窗的核对义务，mm-62 的提示规程范围随之扩展；oracle 语义质量另行观测
// （单 trial 翻转率 14–28%，±3 题属噪声，结论见 test/memory-bench 报告）。sourceHash 按当前源码刷新。
// 2026-10-10 阅读口径补修第三批（本批刷新）：MemoryBank 终态复跑的三道边界题同因 —— 核心事实答对后
// 补入历史中不存在的细节（光线/反应）或用自己的偏好、愿望与一般常识补足历史内容（「海边日落」「画前
// 走不动」「门口甜品店」均无来源）。MEMORY_READING_POLICY 无可核对来源的细节清单扩到地点/天气/光线/
// 物品/双方反应，并明确「不得用自己的偏好、愿望或一般常识补足历史内容」；mm-62 提示规程范围随之扩展，
// 断言在 test/integration/memory/记忆证据阅读.test.ts 同批补入。sourceHash 同批重算。
// 2026-10-10 定向分析：Rust原文搜索改为全量合法命中评分、有界保留最佳候选，移除时间优先1000截断；prune不再限制总会话数，治理和事务保留，内联回归负责此存储边界。
// 2026-10-10 帧容量与阅读使用补修：mm-08补超64KiB真实会话索引与完整检索回包，通用大JSON传输归host契约；mm-61/62补supported与missing并存及跨话题来源角色接线，语义质量仍由oracle衡量。
// 2026-10-09 分层召回：声明真实headroom预算、完整渲染成本、会话覆盖与 token 分块的回归点；用户要求本轮不做 review，未声明审查完成。
// 2026-10-09 验收修复：会话索引两处实机缺陷——(1) 会话文件统计改走 metadata 绝对路径（此前把数据根相对路径喂给 file_info，按宿主进程 cwd 解析必失败，真实宿主里索引从未建起来：LME oracle 实测 0 会话、assistant 题 8/8 零候选）；(2) 空会话（条目文件未落盘）按会话跳过而非中止整轮索引。新增 caseId conversation-index-session-absolute-path / conversation-index-empty-session-skipped；sourceHash 按当前源码刷新。
// 2026-10-09 验收补充：顶栏 typing 所有权泄漏修复波及本契约 sourceFiles（runner/runtime/titlebar 的 defer 判据收口与旧代际清扫），逐点复核与本院行为面不相交，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-09 最终静态复核：联合改写重排、会话原话索引、数据库结构修复与派生证据撤销已静态复核，覆盖声明同步；验收已执行（L2/L3 与 Rust 单测全绿），sourceHash 按当前源码在验收轮刷新。
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
// 2026-10-05 dreaming 前置查询批次（W3-1）：sourceFiles 变化 —— store.rs（`job_sources` 与
// 新增 `pending_source_count` 共用同一段水位判定 SQL，不另建第二套水位逻辑）、commands.rs 与
// dispatch.rs（新增只读命令 `memory_pending_source_count`）、ipc.ts 与 dreaming.ts（开作业前
// 先查水位之后有无待处理来源：没有就不创建 job、不动预算/租约；手动入口同走这条前置查询，
// 恢复既有作业不受影响）。新增覆盖点 mm-43（L3 `整理前置查询.test.ts` 的 4 个 caseId）；
// 其余 mm-* 实现点仍在、语义未变。sourceHash 本轮不重算 —— 契约刷新统一在收口波走
// analyze → generate（本轮工作单禁止跑契约 generate）。
// 2026-10-05 频率档位收口波（analyze→generate）：新增 mm-44（记忆整理的档位门禁与数值消费，
// L3 记忆整理档位门禁.test.ts 的 4 个 caseId——W2-M1 登记转正）；mm-43 的 4 个 caseId 登记经
// 对账通过；其余 mm-* 实现点按当前源码复核仍在、语义未变。sourceHash 按当前源码复算。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— crates/native-host/src/host/dispatch.rs
// 新增一条 chat_delete_session_images 分派臂（命令矩阵 134→135），memory_* 命令的既有接线与
// 错误语义未改，与记忆存储、召回与整理链路不相交。另核对：聊天消息右键菜单恢复「记住这条」
// 入口（crates/native-host/src/ui/chat/*.rs 的 UI 层意图链；chat_remember_message 的 Node 侧
// 处理体与线形状一行未改）—— 不在本契约覆盖面（记忆来源准入/提交）内，平台手势与菜单渲染
// 不在这里冒充。mm-* 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前
// 源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（子运行 provider 准入转发；createTurnSpec 现在也把
// 调用方声明的 disableAutomaticCompaction（规划子运行）转发进 spec，子运行的隐式压缩开关
// 真正生效；主回合压缩/摘要/快照链路未动）。mm-* 逐点核对：压缩阈值、摘要内核、审计与保留
// 口径不在改动面内、实现点仍在，覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（analyze→generate）：sourceFiles 变化 ——
// src/services/context/budget.ts（新增纯函数 totalInputTokens = input + cacheRead + cacheWrite）、
// src/services/engine/harness/{runtime,model-gateway}.ts（estimateDriftRatio 的 actual 与快照
// actualInputTokens / tokenDrift.actual 从 usage.input 改为 totalInputTokens —— usage.input
// 只是未命中缓存的一截；真机实测单比 input 43×、三者相加 1.14×，落在 1.15 阈值之下）。
// 新增 mm-45（unit，caseId memory-estimate-drift-total-input）；mm-26 描述订正（tokenDrift.actual
// 的定义按新口径写清，指向 mm-45）。mm-19/mm-34/mm-40 的 usage 记账、快照保留与窗口预算语义
// 未变，其余点不在改动面内、实现点仍在；sourceHash 按当前源码复算。
// 2026-10-06 回合治理与图片生命周期批次（analyze→刷新）：sourceFiles 变化 ——
// src/services/agent/memory/protocol.{json,ts}（ProactiveBudget 新增 cooldownUntil: number|null，
// 与 proactive 侧共用同一份定义；mm-* 无覆盖点描述该字段的消费，未修订）、dreaming.ts
// （isAIGenerating 改从 engine/harness 取：AI 生成锁真相源随 `src/services/cooldown.ts` 删除
// 移居 harness 的回合受理状态，整理调度门禁语义不变）、engine/harness/harness-slot.ts 与
// engine/harness/runtime.ts（受理计数与旧锁路径）、context/tool-output.ts（工具结果投影新增
// 可选「工具循环软提示」尾行：未缩短/缩短/清空三档都不丢、长度不计入单条上限判定）。mm-27 按
// 现状补注：该尾行是回合级视图独有输入，摘要素材按持久条目重建、不带它——「两路同 level 逐字
// 相同」因此限定为除该可选尾行外；mm-19 同口径同步一句。其余点不在改动面内、实现点仍在，
// 未修订；本轮只做描述与来源一致性核对（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 dreaming 日 token 闸撤除批次（analyze→generate）：sourceFiles 行为面变化 ——
// src/services/agent/memory/dreaming.ts（空闲调度器不再查 token 账做门禁；批次不再因预占失败
// 中止；token 预留/结算照记）、ipc.ts 与 protocol.{json,ts}（reserve 改纯记账：去 dailyLimit 参数、
// 响应 boolean → null；生成物 memory/protocol.rs 同批更新）、crates/native-host/src/memory/
// {store.rs,commands.rs}（预留一律接受并照记；档位表 tiers.dreaming 删除 dailyTokens——日上限
// 不再是门禁，也不留观测阈值）、host/dispatch.rs（分派臂同步）。mm-44 按新口径改写（日 token
// 上限撤除、idleSeconds / minIntervalMinutes 节奏门禁不变、token 账照记）；mm-43 的实现点仍在、
// 未修订；其余点不在改动面内。sourceHash 按当前源码复算。
// 2026-10-06 计划提议工具批次（本批刷新）：sourceFiles 变化 —— src/services/context/builder.ts
// （工具协议块新增一句中性计划提议指引：只在工具面含 propose_plan 时注入「先调用 propose_plan
// 请求确认、不要用 osascript/GUI 弹窗等待用户」；块的注入条件与预算口径未变）。mm-11 的
// systemPromptHash「随静态块内容变化」口径照常成立；其余点不在改动面内，逐点核对实现点仍在、
// 覆盖描述与当前实现一致，未修订覆盖点。本批刷新同时包含工作树中其它并发改动的源文件
// （非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 提问选择与去超时批次（本批刷新）：sourceFiles 变化 —— `context/builder.ts`
//（工具协议段重写：保留多步指引与权限类直接执行口径、删除方向错误的旧句、新增 ask_user
// 指引，注入条件仍按工具面；覆盖登记在 tool-execution 的 te-37）、`tool/policy.ts`
//（`execution.timeoutMs` 允许显式 `null` = 不设执行超时）与 `harness-slot.ts` / `runtime.ts`
//（等待期回合墙钟可暂停，注释面）。mm-11 的 systemPromptHash「随静态块内容变化」口径照常
// 成立；各点逐条核对实现点仍在、描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 派生行为结论沉淀批次（analyze→generate）：长期记忆新增第二类准入来源
// `derived_behavior`（画像稳定结论，taint=derived，成对约束、错配拒收；抽取视图见 behavior
// 契约 bh-07）。sourceFiles 变化 —— `behavior/conclusions.ts`（新增，沉淀视图唯一出口）、
// store.rs（来源登记/待处理判定按两类且按 origin 过滤；发布与治理写入双口校验来源分池：
// 混用/派生+pinned/派生+working 拒绝、不跨来源类别改写；新增
// `forget_derived_behavior_items_tx`——清画像时先失效引用、再写墓碑、清正文/索引/候选并推进
// forget_epoch 与 revision，空库不空转；条目 origin 由来源类别派生、不落列，无 schema 变更）、
// schema.rs（注释仅补来源类别口径）、commands.rs 与 dispatch.rs（`memory_job_sources` /
// `memory_pending_source_count` 增可选 `origin` 参数）、proactive/store.rs 的
// `clearBehaviorSources` 事务（同一事务里调用派生记忆失效）、memory/ipc.ts 与 protocol.{json,ts}
//（MemoryOrigin；MemoryItem 增必填 origin）、provider.ts（投影带 origin 与「系统观察」呈现
// 标记）、dreaming.ts（来源分两区、各自成作业：用户区走模型，系统观察区确定性映射不过模型、
// 不占 token 预算、同槽位 supersedesId 覆盖；前置查询按类别）与 index.ts（导出）。修订
// mm-01（两类准入通道与不混池）、mm-03（来源登记准入范围）、mm-43（前置查询按类别）；新增
// mm-46/mm-47/mm-48（L3）与 7 个 caseId（3+3+1）。行为画像清除对本域派生闭包的证据是 Rust 单测
// `behavior_clear_forgets_derived_items_and_blocks_replay`（正文/索引/候选三处覆盖、墓碑拦
// 迟到回灌、跨清除代作业发布被拒、空转保护；Rust 单测不进 caseId 账，属既有口径）。
// mm-* 其余逐点核对实现点仍在、语义未变；sourceHash 按当前源码复算。
// 2026-10-06 记忆判据与计划报告批次（本批刷新）：sourceFiles 变化 ——
// src/services/agent/memory/dreaming.ts（REVIEW_SYSTEM_PROMPT 判据加强：新增「记忆种类与
// 范围」一条（kind/scope 取值说明）；请求句/当场需求不算偏好、测试与调试任务不记；空数组是
// 常见且正确的输出、宁可少记不可滥记 —— 2026-10-06 用户裁决）、
// src/services/tool/local-extra/memory.ts（memory_change 工具描述加强：值得长期保留的内容
// 当场写入、不要留给自动整理；一次性请求/测试调试/临时任务不写；补记忆种类与范围说明）、
// src/services/engine/harness/runtime.ts（runPlanPhase 的 onStepNotice 收窄：工具名不存在
// 仍发聊天系统消息；未限定工具只写进度事件与统一日志）。mm-47 的用户区模型 Review 链路
//（按来源分池、前置查询与提交语义）未变 —— 本批只加强生成侧提示判据与工具描述文案，不改
// 任何已声明的准入、批内取数、候选校验与提交行为；memory_change 的参数面与执行路径未动；
// runtime 的计划报告分支与记忆链不相交。mm-01..mm-48 逐点核对实现点仍在、覆盖描述与当前
// 实现一致（描述/来源核对，非逐行行为审计）。未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-06 收尾修复（本批刷新）：sourceFiles 变化 —— src/services/agent/memory/index.ts 的
// forgetUnderstandingDerivedMemory 对「此宿主没有记忆后端」（UnsupportedInNodeError，L3 Node
// 适配层）按既有 standard-setup 口径跳过并留痕（无后端 = 没有可清的记忆，跳过是准确结论而非
// 放行），其余错误照旧如实抛出；修复了清画像链路在 L3 触达 memory_status 的 UnsupportedInNode
// 崩溃（画像采集落盘用例双红）。未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-08 定向复核（本批刷新）：sourceFiles 变化 = `src/services/engine/harness/runtime.ts`。
// 该文件是本契约的枢纽文件之一；本批对它的改动**只在 `continueInterruptedRun` 的三处请求
// 装配上补 `humanizerEnabled`**（让「中断后继续」的拟人化口径与主回合对齐）—— 不碰记忆投影、
// 召回、候选准入、遗忘与整理链的任何实现点（该路径连 `runtimeDataReminder` 都是既有分支）。
// 逐条核对本契约覆盖点后未发现需要修订的项，无 caseId 迁移。
import type { ModuleContract } from "../host/types"

// 2026-10-06 实测反馈收口（本批刷新）：sourceFiles 变化仅限 context/builder.ts 的计划提议指引
// 补一句「单个动作需要确认时直接执行（危险动作由确认面板向用户确认），不要用文字先征求同意」——
// 注入条件（工具面含提议工具）与注入通道未变，属同一行为的文案增补；各覆盖点逐条复核与当前实现
// 一致，未修订覆盖点，按当前源码刷新 sourceHash。
// 2026-10-06 记忆面板来源标签批次（本批刷新）：sourceFiles 变化仅限
// src/services/agent/memory/index.ts —— 导出面 barrel 转出 DERIVED_PROVENANCE_MARK（原生 UI
// 记忆面板复用同一枚呈现标记，判据 isDerivedBehaviorSource 与措辞同源；模块行为不变，面板侧
// 覆盖点登记在 native-ui 契约 nui-28）。mm-* 逐点核对实现点仍在、覆盖描述与当前实现一致；
// sourceHash 按当前源码复算。
// 2026-10-06 验收批次（analyze→generate 的声明部分；sourceHash 留待主会话统一批量刷新）：
// sourceFiles 变化 —— 新增 src/services/agent/memory/draft.ts（记忆草稿 summary 截断长度的
// 唯一定义点 DRAFT_SUMMARY_CHARS = 120，零依赖叶子；dreaming 两处、native-ui 两个入口与
// memory_change 工具改引它，不再各存 120 字面量；守门测试 test/unit/memory/草稿摘要单点.test.ts
// 无 caseId，按「文件在列 + 单测背书」口径不登记覆盖点，属已知锚点缺口）、
// src/services/context/budget.ts 新增 ESTIMATOR_WORST_CASE_BIAS（估算器最坏内容偏差 = 4）与
// engine/harness/harness-slot.ts 的 compactionSettingsFor 按它封顶保留窗口（跨尺子换算：
// 上游 findCutPoint 按 chars/4 计，纯非 ASCII 下保留段可放大 4 倍，不封顶会顶破
// normalInputTarget —— 阈值压缩素材恒空却先撞硬预算、中文会话到窗口上限后无法再压缩）。
// 修订 mm-40（保留窗口的预算值与生效值分层写清，数字按生效值重写：128k 预算值 32_768 经
// 偏差封顶后生效 23_016、200k 50_000 → 37_750、1M 仍 80_000）与 mm-21（补「保留窗口按
// 估算器最坏偏差封顶」不变量；其 L3 用例 memory-compaction-threshold-calibration 已直接
// 断言 upstreamBias × keepRecentTokens ≤ normalInputTarget）。memory 压缩/快照族 L4 场景已按
// 该最终口径修订（真窗口来自注入模型的 131_072、载荷按生效保留窗口推导，见 test/e2e/dataset.ts
// 的 2026-10-06.1 bump）。记忆面板（逐条来源展开 / 备份列表 / 取消继续）不在本契约覆盖点内
// （面板侧覆盖登记在 native-ui）。mm-01..mm-48 其余逐点核对实现点仍在、覆盖描述与当前实现
// 一致（描述/来源核对，非逐行行为审计）。
// 2026-10-06 固定钟点批次（本批修订描述与 sourceFiles，sourceHash 与 caseId 登记留验收环节
// analyze→generate）：sourceFiles 行为面变化 —— src/services/agent/memory/dreaming.ts（定时
// 调度器改按钟点表触发：idleSeconds 空闲阈值与 idleSince 状态删除，「AI 生成中」排除去掉，
// 保留最小间隔防重与前置水位查询）、src/services/proactive/protocol.json（tiers.dreaming 与
// tiers.silent 的两域空闲字段删除、新增 hours 钟点表；dailyBatches 不再单列——每日上限 =
// 钟点表轮数）与其生成物 protocol.ts / crates/native-host/src/memory/protocol.rs（钟点表发射为
// &[i64] 切片常量）、scripts/generate-memory-protocol.mjs（数组叶子发射支持）、
// crates/native-host/src/proactive/store.rs（辅助预留的 observation 天花板改取钟点表轮数，
// 静默档最高 12 → 6）、新增 src/services/proactive/schedule.ts（钟点判定纯函数，dreaming 与
// 静默了解共用）。mm-44 按新语义改写（钟点表 = 每日 2/4/6 轮、到点即跑、不再要求空闲；
// 最小间隔 240 / 60 / 30 分钟保留）。mm-43 与其余点不在改动面内。
// 2026-10-06 最终波统一刷新（analyze→generate 收口；上一条留待验收的 sourceHash 一并完成）：
// F（dreaming 扩源）——sourceFiles 变化：`src/services/agent/memory/sources.ts`（派生区第二条
// 来源通道 `collectUnderstandingMemorySources`：静默了解观察摘要原样登记为 derived_behavior
// 来源，身份 = 摘要文本 sha256 前 16 位（同文本幂等、水位不推进）、每次只取最新 12 条
// （UNDERSTANDING_MAX_ENTRIES，与了解层读取窗口同阶）有界窗口、档位 off 或无观察时不登记）、
// `dreaming.ts`（系统观察区加了解子类的确定性候选 `buildUnderstandingCandidates`：文本原样
// 沉淀、达上限后新观察按最旧优先逐个 supersedesId 覆盖、覆盖目标作业内不重复使用、用尽后
// 旧观察不再产出；两区都没有新来源时不整段跳过，转入库内合并整理 `runMergeSweep`——只在
// 用户区、同 scope/kind ≥2 条分组、最多 3 组 × 单组 ≤4 条、无分组时一次有界列举后零写早退、
// 有分组时走模型并复用 Review 作业与自动提交链）、`index.ts` 与 `ipc.ts`
// （`forgetUnderstandingDerivedMemory` 导出与 `forget_understanding` 治理动作：清除静默了解
// 的记忆闭包，只圈定 `understanding:` 前缀来源，与清画像共用同一 Rust 闭包实现）、
// `protocol.json` / `protocol.ts`（候选草稿新增可选 `supersedesIds`，1–4 条）、
// `crates/native-host/src/memory/store.rs`（发布事务：supersedesIds 形状校验、被吸收条目复核
// 「仍在库、同 scope/kind、未置顶、同来源类别」、来源并集在事务内强制（旧条目自己的来源
// 一条不丢，墓碑复核按并集后的集合）、多目标逐个 supersede（旧行与版本链保留、链上代表取
// 首条）、治理写入路径明确拒绝 supersedesIds；新增 `forget_understanding_items_tx`，范围内
// 无数据时不动 epoch/revision）与生成物 `crates/native-host/src/memory/protocol.rs` /
// `protocol.ts`（scripts/generate-memory-protocol.mjs 重生成）。
// 覆盖点修订：mm-47 扩为两个子类（`conclusion:` 结论 + `understanding:` 了解摘要，含有界池 /
// 最旧优先覆盖 / 清除闭包）；mm-43 按新语义修订（无新来源转库内合并整理、零写早退、来源并集
// 与多目标 supersede——上一条「mm-43 不在改动面内」据此更正）；mm-01 / mm-03 的来源名单措辞
// 同步扩为两个子类（origin/taint 成对约束、登记幂等与准入范围未变）。mm-44（钟点表 / 最小
// 间隔 / 日 token 撤除）与其余点逐点核对实现点仍在、描述与当前实现一致。
// F 队新写的一组 L3 用例（了解沉淀登记 / 了解沉淀整理 / 库内合并整理）已写、**暂无 caseId
// 锚点**（按纪律不为其登记 caseId），覆盖描述已按新语义更新。
// sourceHash 按当前工作区源码复算。
// 2026-10-06 抽屉 CONFIG 写批次（本批刷新）：sourceFiles 行为面变化 ——
// src/services/debug.ts（会话级思考/安全覆盖机制整体删除：setSessionThinkingEffort /
// setSessionSafetyMode / getEffectiveThinkingEffort / getEffectiveSafetyMode 等移除，debug
// 模块只留用量统计与工具清单，不再持有第二条状态）、src/services/engine/harness/runtime.ts
// （三处思考强度消费点改直读 `aiConfig.thinkingEffort`）。2026-10-06 用户裁决：抽屉三个下拉
// （投递/思考/安全）与设置页统一为同键 CONFIG 写 —— 思考唯一真相源 = aiConfig.thinkingEffort、
// 安全唯一真相源 = safetyConfig.mode；投递意图唯一来源 = ai.conversation.defaultDelivery
// （chat_send 的 delivery 参数删除，不属本契约覆盖面）。mm-29 按当前事实补一句「强度后缀取
// CONFIG」；mm-11 的「冻结的 capabilities.safetyMode」核对仍成立（preflight 冻结一次、值取
// CONFIG 现值，与权限裁决同一份快照）；其余 mm-* 逐点核对实现点仍在、覆盖描述与当前实现
// 一致（描述/来源核对，非逐行行为审计）。sourceHash 按当前工作区源码复算。
// 2026-10-10 统一记忆查询验收：sourceFiles 补入 coverage.ts（补查闭环）、context/index.ts（冻结时间锚 API）
// 与 host/types.ts（conversation_search 记录时间线型）；mm-64绑定生产记录时间 IPC，mm-65/66/68
// 分别登记统一查询计划、reader补查闭环与安全轨迹字段。mm-49保留原L2归属，新增L4不混层。
// 2026-10-10 自动预算收口：删除 CONFIG/getter 的手动分层额度及预算函数的查询/覆盖参数，
// 直接消费者统一传 purpose/headroom；mm-54 修订自动共用额度，超额原文淘汰仍由真实窗口触发。
// 2026-10-10 oracle断点修复：mm-58/63归属受控会话分页及选择边界，mm-61/62归属逐条笔记与问题前提清单，mm-55覆盖主请求guide接线；mm-08以真Rust IPC补负对照、before与clear。
// 2026-10-16 查询召回复核：provider.ts 将原问题与互补改写词逐条召回后稳定补位合并；protocol/IPC/store 增加 eventTime 约束，将 eventAt 按 [start,end) 与日历日期过滤，record 时间仍只约束会话记录。既有查询融合、事件时间和真实 IPC 覆盖点保留；本轮仅复核源码与覆盖声明并刷新指纹。
// 2026-10-16 词面召回实现：fact 与 transcript 索引统一 NFKC/lowercase；facts 使用加权 bm25 + 确定性排序，eventTime 在 SQL 过滤，原问题查询锚定 RRF；proactive working-memory 版本写入沿用同一投影。
// 2026-10-21 思考强度值域批次（本批刷新）：ThinkingEffort 增加 max，`ai.thinking.effort`
// 默认 auto → high；sourceFiles 中 config/types 变化，本域覆盖描述未受影响，
// sourceHash 按当前源码复算。
// 2026-10-21 原始助手正文进请求视图（本批刷新）：runtime.ts 请求视图开头恢复历史助手
// 原文，记忆投影与召回路径未变；sourceHash 按当前源码复算。
export const memoryContract: ModuleContract = {
  module: "memory",
  sourceFiles: [
    // mm-44: the domain consumes one process scheduler and durable private fixed-slot claims.
    "src/services/scheduler/slots.ts",
    "src/services/scheduler/kernel.ts",
    // Shared TS/Rust lexical constants are emitted by this producer.
    "scripts/generate-memory-protocol.mjs",
    "src/services/agent/memory/index.ts",
    // mm-76: `id@version` 的解析规则定义在这里（index.ts 只是再导出）。
    "src/services/agent/memory/ref.ts",
    "crates/native-host/src/memory/store.rs",
    "crates/native-host/src/memory/schema.rs",
    "crates/native-host/src/memory/mod.rs",
    "crates/native-host/src/memory/protocol.rs",
    "crates/native-host/src/memory/commands.rs",
    "crates/native-host/src/host/dispatch.rs",
    "src/services/agent/memory/ipc.ts",
    // conversation_search record-time bounds are defined on the host command boundary.
    "src/services/host/types.ts",
    // 2026-10-06 契约账本批次 systematic sourceFiles 复查补入：protocol.json 是记忆命令
    // **线协议的权威定义**（protocol.ts 由 scripts/generate-memory-protocol.mjs 从它生成）；
    // proactive 契约对同构文件已把 .json 与 .ts 并列声明，这里此前只列 .ts。
    "src/services/agent/memory/protocol.json",
    "src/services/agent/memory/protocol.ts",
    "src/services/agent/memory/provider.ts",
    "src/services/agent/memory/fusion.ts",
    "src/services/agent/memory/conversation-key.ts",
    "src/services/agent/memory/selection-score.ts",
    "src/services/agent/memory/query.ts",
    "src/services/agent/memory/query-shape.ts",
    "src/services/agent/memory/budget.ts",
    "src/services/agent/memory/projection.ts",
    "src/services/agent/memory/enumeration-answer.ts",
    "src/services/agent/memory/reader.ts",
    "src/services/agent/memory/evidence-review.ts",
    "src/services/agent/memory/reading-errors.ts",
    "src/services/agent/memory/coverage.ts",
    "src/services/agent/memory/evidence.ts",
    "src/services/agent/memory/conversation.ts",
    "crates/native-host/src/memory/conversation.rs",
    "crates/native-host/src/proactive/store.rs",
    "src/services/session/manager.ts",
    "src/services/session/read-model.ts",
    "src/services/session/repo.ts",
    "src/services/agent/memory/rerank.ts",
    "src/services/agent/memory/sources.ts",
    "src/services/agent/memory/visible-query.ts",
    "src/services/agent/memory/revision.ts",
    "src/services/agent/memory/dreaming.ts",
    // 2026-10-06 验收批次补入：记忆草稿 summary 截断长度的唯一定义点（DRAFT_SUMMARY_CHARS =
    // 120，零依赖叶子）—— dreaming 的候选回退与派生候选、native-ui 两个入口与 memory_change
    // 工具都从这里取；改值 = 改行为。守门测试无 caseId（不登记覆盖点，属已知锚点缺口）。
    "src/services/agent/memory/draft.ts",
    // 2026-10-06 固定钟点批次补入：dreaming 定时调度器的到点判定（静默了解共用，零依赖叶子）。
    "src/services/proactive/schedule.ts",
    "src/services/behavior/conclusions.ts",
    "src/services/engine/runtime/snapshot.ts",
    "src/services/engine/runtime/types.ts",
    "src/services/engine/runtime/trace.ts",
    "src/services/engine/runtime/input-identity.ts",
    "src/services/error/failure-kind.ts",
    // mm-15 owns checkpoint effect evidence and runtime resume admission; generic loops belong to agent-runtime.
    "src/services/engine/plan/checkpoint-store.ts",
    // runtime also owns recall gating/projection (mm-17/mm-37/mm-38), HarnessSlots compaction (mm-19/mm-40).
    "src/services/engine/harness/runtime.ts",
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
    // Frozen time-reference API consumed by memory query planning and reading.
    "src/services/context/index.ts",
    "src/services/context/kernel.ts",
    "src/services/context/budget.ts",
    "src/services/context/tool-output.ts",
    "src/services/debug.ts",
  ],
  // 2026-10-10：预算/结构化证据归 mm-54..61，阅读器网关、缓存与取消组合归 mm-62；
  // runtime 的本域请求装配仍归 mm-55，通用循环与分泡提交由 agent-runtime 持有。
  // 2026-10-18 列项答案补全批次：新增 enumeration-answer.ts，runtime afterResponse 补全并与结算同源；reader 抽取器来源上限与最终证据对齐到 32、按 8 条分批合并、类别/问句片段具体性过滤、完整口味组合保留、最长项目吸收短片段、去空格变体去重；人物归属留在 LoCoMo 适配器（memory-bench mb-12），产品不解析 speaker 头；mm-73/mm-74/mm-75 覆盖，刷新。
  // 2026-10-24 引用溯源：会话原文引用同落 chunk 0，按 (sessionId, entryId) 去重后写入 quoteRefs；mm-79/mm-80/mm-81 覆盖，刷新。
  sourceHash: "d8af19e35488a9098c89dbb9c27bbf14c9d6e04830da44865eb2e6fba160c1b7",
  coverage: [
    { id: "mm-54", feature: "需求与真实空间驱动召回预算", description: "两层自动共用本次请求实际headroom，由共享total裁决；无手动分层额度或查询参数，不按固定比例/倍率/填充下限/绝对封顶分配，主动core为0，总量不越正常输入目标", why: "真实可用空间与相关证据需求决定装配上限，旧配置不能压低自动额度", layer: "unit", depth: "deep", scenarios: ["memory-recall-layered-budget", "memory-selector-output-budget"] },
    { id: "mm-55", feature: "真实请求空间接线", description: "transform完成正文和工具投影后按实际headroom召回，预留新增消息结构成本；正文增长使provider预算同步下降，超过旧1000-token上限的完整事实仍可到达请求；trace与候选端沿用同一预算；宿主阅读规程进入system，原始引用仍在custom消息且不升级为指令；静态规程声明默认自然日期及显式机器格式/年份/相对量边界，接线断言核对system消费，表达质量另由固定证据与真模型专项观测，不以fake回复证明", why: "静态比例或构造期估算不能反映本次Provider请求的真实空间", layer: "integration", depth: "deep", scenarios: ["memory-recall-layered-runtime", "trace-memory-reading-guide-in-request"] },
    { id: "mm-56", feature: "动态证据会话覆盖", description: "核心和精确目标优先；动态装配先为后续可容纳会话预留索引命中片段，再在每个候选会话内寻找可容纳完整用户/锚定助手证据组，再按原排名补位；超限退回索引命中片段且不阻断后续证据；最终条数由实际全文与JSON总预算限定，无固定6条上限", why: "单会话高分候选不能在预算与名额竞争中挤掉其余命中会话", layer: "unit", depth: "deep", scenarios: ["memory-recall-session-coverage", "memory-recall-complete-turn-bundle", "memory-recall-session-reservation"] },
    { id: "mm-63", feature: "重排后的会话上下文展开", description: "个人意图的倾向问题沿已准入用户事实补读来源，普通知识中的would不授权补读；个人/具名偏好假设在共享query-shape识别，直接历史仅对合法缺口事实引用补读，派生观察和精确主动目标不扩展；枚举/建议问题先做类别aspect扇出（books/activities等）与首轮命中作品名反馈查询，再对命中的完整会话做整段补全，普通查询仍走既有边界；只用已准入证据剩余预算；普通查询先读命中的完整回合；显式整段回顾或指明会话的历史查询可分页读全，其他缺口仅按已校验规范引用展开当前仍选中的会话，模型短别名或可选source需求不授权扩读；仅选中会话可继续读取上下文，显式空选择与已拒绝entry不复活；版本变化丢会话保留核心事实，I/O失败保留已验证命中并登记失败", why: "补全会话不能绕过既有重排与资格边界，也不能让可选扩展故障拖垮整次召回；枚举/建议的答案项常分散在同会话远邻或另一会话的标题/作者桥接里，只读精确命中会漏证据", layer: "unit", depth: "deep", scenarios: ["memory-fact-source-general-question", "memory-fact-source-backfill", "memory-fact-source-demand", "memory-fact-source-fallback", "memory-context-demand-driven", "memory-context-explicit-overview", "memory-context-after-selection", "memory-context-empty-selection", "memory-context-revision-fallback", "memory-context-io-fallback", "memory-context-enumeration-feedback", "memory-query-third-person-aspect"] },
    { id: "mm-58", feature: "检索命中回读完整证据", description: "事实来源仅取受治理元数据，审计预览不作为正文；经context与JSONL验证entry/event/seq和完整正文hash，补回对应完整回合而不翻全会话；信任/资格/hash/预算失败不发布，治理代变化或取消撤销迟到正文；索引条目带 `search_text`（记录日期、相邻原话与事件日期词项）及 `event_at_ms`/`event_at_date` 投影，展示正文不变；常态检索上限50，count/overview/advice/enumeration 扫描意图下发 `scan: true` 且上限500；所有去重词面query各自检索后以RRF融合，原问题权重2.5但不硬锁前排、改写只补充新候选，版本/遗忘代对齐；Rust词面检索对原词无命中时按索引词表纠正距离1的拉丁拼写，`conversation_term_check` 按索引词表回答词项是否存在（供改写侧判定语料同义词）；只对SQLite返回的稳定entry回读可见JSONL，角色/seq/时间/重建chunk逐字匹配才取完整正文，缺失及陈旧命中丢弃；仅明确短指代在所有词面查询均无命中时追加近期回退，回退返回的零分entry也作为候选回读，普通miss不扫描近期原文；个人意图只在已选中会话内经SQLite治理分页补回其他正文，按真实headroom停止，分页复核revision/遗忘代，不将50候选作为最终条数上限；记录日期概览按半开记录时间范围检索，事件日期不作记录过滤；日期概览缺少具体主题时由reader给出grounded follow-up并补查；紧预算按命中邻近轮次及完整user/assistant回合组展开", why: "会话命中不代表答案所在轮或细节完整，原话回读不能绕过可信来源及遗忘裁决；改写召回也不能覆盖原问题的精确事件命中", layer: "unit", depth: "deep", scenarios: ["conversation-fact-source-original", "conversation-fact-source-governance", "conversation-fact-source-fence-cancel", "conversation-query-complete-turn-cap", "conversation-expand-hit-to-full-entry", "conversation-drop-stale-hit-chunk", "conversation-query-facet-fusion", "conversation-query-snapshot-fence", "conversation-expand-matched-session-pages", "conversation-query-plan-record-time", "conversation-temporal-only-and-event-time", "conversation-dated-overview-followup", "conversation-context-nearby-headroom", "conversation-context-nearest-prior-turn-bundle", "conversation-context-revision-fence", "conversation-context-jsonl-and-cancel", "memory-conversation-scan-mode"] },
    { id: "mm-59", feature: "结构化证据及编码预算", description: "JSON evidence数组分别呈现kind/source/正文以及原话role/time/seq/entry字段，按会话及原始顺序读取，正文不能伪造宿主metadata；readingNotes置于完整证据之后并按sourceId引用原文，完整JSON编码计入最终预算，少1token即整条淘汰；直接历史完整有效阅读的最终回答层保留所有检查引用和完整回合，剔除未引用旁支；倾向题保留全部已准入原话/事实/观察，参考包S/C/E短别名与笔记同步，完整身份留宿主而不混用工具参数，主答包以answerMode=inference及逐字索引供独立核对，不携带读者结论/清单/答案白名单，预算收缩整回合跳过；answerSourceIds只含required且supported来源，共用来源不因supporting引用误删，冲突与佐证引用仍可解引用；无检查引用时仅保留清单，部分阅读保留候选，预算不足原子舍弃辅助层", why: "结构化读取保留事件归属与时间，双重来源标签及未计费编码不能继续侵占小预算", layer: "unit", depth: "deep", scenarios: ["memory-recall-structured-evidence", "memory-recall-structured-cost", "memory-recall-reading-order", "memory-recall-reading-notes", "memory-recall-question-guide-budget", "memory-recall-required-evidence-scope", "memory-recall-missing-guide-only", "memory-recall-partial-reading-fallback", "memory-reading-answer-evidence-scope", "memory-recall-inference-originals", "memory-recall-inference-turn-budget", "memory-recall-inference-reference-aliases"] },
    { id: "mm-61", feature: "请求内阅读笔记来源与预算", description: "只接受实际输入sourceId、连续逐字引文和有界关联说明；推断/计数表每个文本字段的320 Unicode字符上限由宿主常量同步进阅读提示，超限仍拒绝而不截字；明确经历次数题的请求内evidenceReview按实例汇总counted，直接频率和静态数量仍走直接核对，重复必须指向已有counted，频率/计划/范围外/未发生不计数，零次保留明确否定来源且仅频率/计划不能证明零次，未决不能被complete覆盖；倾向结论逐项保存支持与反例，answer项目与excluded边界分开，列表排除项不作为补查目标且其缺失不强制补查，推断表不进入主答白名单，否定的是非结论仍可回答，引用经同一短别名白名单校验，缺表或非法表保留合法引文但核对未完成；结构校验不证明语义正确；坏笔记逐条丢弃并保留合法逐字引文，坏清单独立失效；questionChecks显式声明required/supporting，主体premise与conflicting不得降级且至少一项required，未知或缺少字段独立拒绝指南；只引用合法笔记，supported与missing可并存；缺失前提可无来源且仅约束自身，禁止替换实体继续计算，说明是否含暂定措辞不决定合法性；笔记保留原始证据及信任字段，超共享预算只舍弃笔记，不写回事实；同一事实/事件的多条记录先按时间序消解（更晚的确认记录更新先前值，用户当前纠正优先），能消解即标supported并在condition写明采用与被更新的记录，仅同一时点互斥或先后无法判定才标conflicting；相对时间问句先按currentTimeNote换算成日期区间再与记录时间比对，不因原文未出现相同表述而标missing；建议题与推断题共用推断表；行政区/地理归属在广为人知且唯一时可作为supported依据并引用地点原文，同名/模糊地点保持missing；序数题先枚举匹配事件并按事件时间取第N次，plan on等未来计划不能替代过去同类事件，无法唯一确定序数时标missing", why: "召回到的个人经历仍可能被回答忽略；显式阅读阶段必须可追溯且不能成为事实写入通道", layer: "unit", depth: "deep", scenarios: ["memory-reading-obligation-schema", "memory-reading-obligation-invalid", "memory-reading-supported-and-missing", "memory-reading-partial-validation", "memory-reading-missing-premise", "memory-reading-guide-isolation", "memory-reading-all-invalid-raw", "memory-reading-source-preservation", "memory-reading-budget-fallback", "memory-reading-grounded-followup-search", "memory-reading-alias-whitelist", "memory-reading-information-increment", "memory-reading-focused-turn-pair", "memory-review-count-instances", "memory-review-count-uncertainty", "memory-review-count-invalid", "memory-review-count-zero-evidence", "memory-review-inference-grounding", "memory-review-inference-exclusion-scope", "memory-review-missing-work-sheet", "memory-review-count-vs-direct-quantity", "memory-review-answer-packet", "memory-count-batch-merge", "memory-review-inference-geography"] },
    { id: "mm-62", feature: "回合内阅读编排与安全缓存", description: "短S别名只按当前sources白名单校验并映射真实来源；complete且guide有效时主请求保留相关原文、完整user/reply组与core，最终回答层保留全部检查引用及完整回合，直接历史计数按counted实例与明确否定生成answerSourceIds，其他直接历史按required且supported生成，未核对旁支淘汰；倾向题保留全部已准入原话/事实/观察，不以读者complete或missing淘汰原话，主答只接收answerMode=inference及原文/索引而非读者结论与白名单，预算按完整回合裁决，佐证和冲突仍可核验，部分/无效输出保留完整原池；premise/detail独立核对当事人和事件，不以旁观反应代替经历。真实personal-history/advice命中（含单条来源与零条来源的已知历史）通过fake gateway生成可验证readingNote；queryPlan声明优先发言角色但保留配对角色上下文，提示规程扫描跨话题用户经历、按题面冻结时间换算相对时间窗、对同一事实的多条记录按时间序取更新值，并要求主答采用相关supported证据、已覆盖问句所需条件时直接给出结论、不补造历史中未出现的地点/天气/光线/物品/心情/原因/结果/经历与双方当时的反应、不用自己的偏好/愿望/一般常识补足历史内容，计划/假设/assistant建议不可升级，fake只验证接线不证明语义质量；同AbortSignal内证据与request语义未变时复用；requestId、来源正文/角色变化或新signal隔离缓存；预算收缩整组舍弃guide/notes保留原文，部分/全坏解析结果也按同回合来源缓存，来源验证移除后重新聚焦以防指南残留；同问题补查后仅保留身份/revision/完整正文均未变的逐字引文，以当前S别名重验并可覆盖；条件状态每轮重算，不继承supported，空新增笔记不抹掉合法引文；取消晚到、非stop、网关失败及伪造来源均回raw，不改变来源身份与trust", why: "阅读注释只在当前回合暂存，跨请求复用或不复核来源会造成注释错绑/信任升级；重复读又会增加无用模型调用", layer: "integration", depth: "deep", scenarios: ["memory-reading-known-history-small-evidence", "memory-reading-social-acknowledgement-skip", "memory-reading-grounded-search-integration", "memory-reading-advice-ownership-boundary-guidance", "memory-reading-notes-trust-preservation", "memory-reading-signal-cache-budget-shrink", "memory-reading-cache-invalidation", "memory-reading-retained-notes-current-checks", "memory-reading-retained-notes-invalidation", "memory-reading-cancel-invalid-source-fallback", "memory-reading-partial-notes-guide", "memory-reading-missing-premise-guide", "memory-shared-time-anchor", "memory-reading-inference-original-reserve"] },
    { id: "mm-60", feature: "个人检索意图与单词边界", description: "个人历史/跨事件问句和个性化建议启用记忆扩词资格；社交及一般问答不触发，英文指代按单词边界匹配", why: "少量关键词命中不能证明个人约束完整，普通单词中的it也不能冒充历史指代", layer: "unit", depth: "deep", scenarios: ["memory-query-personal-intent", "memory-query-word-boundaries"] },
    { id: "mm-65", feature: "统一本地查询计划与时间锚", description: "从原始query一次确定personal recall intent、entities、evidence needs、偏好source roles和时间约束；英文功能词由protocol单一词表供Rust/TS共用，中文疑问词与指代词也由同一词表过滤（Rust词面检索与TS中文2-gram落地校验一致），不占实体名额，保留history等内容词；假设题与阅读器共用题型判断并声明偏好/理由需求，明确会话引用声明source需求；明确个人历史、具名第三人称经历/计划、对话历史任务、数量、原因、步骤、当前建议及中文第一人称问句分类，剥离委托式宾语（如帮我想想）避免把‘我’误作个人回忆主体，一般知识不误触；推荐回忆不能误判成当前建议；user/assistant角色作为检索偏好而非成对证据硬过滤；记录日期半开区间与事件日期区分，缺年不补当前年，相对日期使用冻结question time而非JSONL before cutoff；行政区/居住核对与潜在建议进入推断，序数题保留temporalOrder", why: "多处独立判别会让召回、补查与阅读对同一句话作出不同分类，且把来源截止时间当作现在会错误换算相对日期", layer: "unit", depth: "deep", scenarios: ["memory-query-plan-inference-fields", "memory-query-personal-hypothetical-boundary", "memory-query-plan-intent", "memory-query-plan-third-person-history", "memory-query-plan-personal-event", "memory-query-plan-chinese-entities", "memory-query-plan-chinese-personal-question", "memory-query-plan-chinese-object-person", "memory-query-plan-advice-vs-history", "memory-query-plan-source-roles", "memory-query-plan-dated-conversation", "memory-query-plan-english-date-position", "memory-query-plan-time", "memory-query-time-anchor", "memory-query-plan-inference-routing"] },
    { id: "mm-66", feature: "阅读器驱动的证据缺口补查", description: "同一memory query plan驱动候选及补查，未满足的required或计数/推断核对表必要缺口触发补查，词面搜索耗尽仍可按已校验原话或用户事实引用补读对应会话，每个引用只补读一次；已有必要缺口引用时只扩读未满足required、计数uncertain或推断未决answer的依据与反例，不扩读已支持/排除/可选笔记；缺口无引用线索时保留合法笔记兜底，明确缺口已尝试后不回退扩读旁支；runtime将规范引用交给召回端，supporting缺失不强制弃答；主请求保留两类义务与偏好原证据，只允许倾向问题基于相关偏好作限定推断，明确历史仍需直接证据；历史题核对亲历事件，假设选择/未来意愿题核对相关个人偏好或限制，不要求讨论过目标选项；reader识别unsupported premise并给出grounded follow-up entity/search terms，优先采用合法缺口词而不将所有引文扩展检索；对实体和来源配对做限界复核，按同原条目、版本、trust、role/time及逐字正文新增判断进展，chunk/full重表示去重且不重复阅读；来源验证撤销后退休旧指南，provenance治理标识变化也退休旧指南；合法引文证伪premise时立即结束，未检索到仍为missing；只有新增可信证据继续循环，重复无进展停止；共享deadline内不设固定轮数，取消丢弃迟到快照，revision变化清空旧新证据；补查走真实召回headroom，并把合并证据及guide送入主请求", why: "读到一个命中不能证明多条件问题已覆盖；补查也不能将模型臆造实体当成证据或在治理代际变化后沿用旧来源", layer: "integration", depth: "deep", scenarios: ["memory-coverage-required-gap-context-scope", "memory-coverage-count-gap-context-scope", "memory-coverage-inference-gap-context-scope", "memory-coverage-fact-source-gap", "memory-coverage-context-after-query-exhaustion", "memory-coverage-supporting-missing-stop", "memory-coverage-retains-notes-and-scope", "memory-coverage-provenance-change-retires-notes", "memory-coverage-retained-notes-new-conflict", "memory-coverage-required-missing-search", "memory-supporting-runtime-turn", "memory-coverage-followup-satisfies-cause", "memory-coverage-no-progress-stop", "memory-coverage-rejects-invented-entity", "memory-coverage-cancel-rejects-late-snapshot", "memory-coverage-revision-change-clears-snapshot", "memory-coverage-deadline-without-round-quota", "memory-coverage-budget-keeps-turn-pair", "memory-followup-runtime-turn", "memory-third-person-followup-runtime-turn", "memory-coverage-canonical-no-progress", "memory-coverage-conflicting-premise-stop", "memory-coverage-count-review-gap", "memory-coverage-inference-review-gap"] },
    { id: "mm-68", feature: "记忆补查轨迹的安全字段", description: "memory_recall_reference_page按renderId/offset/total分批登记全部真正渲染的来源ID和role/time锚，每页256且不放宽普通事件上限；memory_coverage_end只允许固定结构字段；memory_reading_end可登记有界的核对条件哈希、required/supporting枚举、状态和引用来源数；memory_recall_end仅保留召回计数与耗时白名单；不记录证据正文、检索词、缺口正文或任意模型错误键", why: "记忆轨迹用于回合诊断，不应把用户原文或检索提示复制进诊断留痕", layer: "unit", depth: "deep", scenarios: ["trace-memory-coverage-schema", "trace-memory-reference-pages", "trace-memory-reading-schema", "trace-memory-recall-diagnostics"] },
    { id: "mm-69", feature: "事实事件时间过滤的真实 IPC", description: "eventTime 从 Node memory API 经 memory_recall_candidates 真实 Rust IPC 到 SQLite，事件毫秒范围按[start,end)先过滤再做事实排序；诊断返回过滤前后候选数", why: "Rust SQL 测试单独通过不能证明结构化事件时间已穿过产品 IPC 并作用于事实召回", layer: "e2e", depth: "deep", scenarios: ["memory-event-time-recall"] },
    { id: "mm-70", feature: "整理 Review 的来源短别名", description: "Review 提示词对每批来源使用 s1..sN 短别名，不暴露长 sessionId:entryId；模型返回别名时映射回真实 sourceId，同时仍接受完整 sourceId；未知来源整条丢弃，整批无效仍失败且不推进水位", why: "弱模型会截断长来源 id 成 entryId，导致整批候选被来源白名单拒绝；短别名保持来源身份可校验，不放松准入", layer: "unit", depth: "deep", scenarios: ["memory-dreaming-source-alias"] },
    { id: "mm-76", feature: "整理判重与条目引用", description: "Review 输入带在库用户条目摘要（existing：最多 40 条、每条 80 字符，派生条目/working/置顶条目排除）；候选可带 supersedesIds，只认 existing 里同 kind/scope 的一条，发布口沿用库内合并的 supersede 校验与来源并集；与在库条目完全同文（忽略空白）且无替换目标的候选整条丢弃，整批都是重复时按正常空结果推进水位；memory_change 接受记忆块给出的 id@version（拆出裸 id + 版本），版本不符如实报冲突而不是「不存在」", why: "2026-10-21 实机：Review 不看库内条目导致同一事实堆成 3–4 条，纠正因 id 形态不匹配 100% 失败并退化成新增", layer: "unit", depth: "deep", scenarios: ["memory-dreaming-existing-dedupe", "memory-ref-versioned", "memory-ref-plain"] },
    { id: "mm-57", feature: "跨语种原话分块", description: "原话按400估算token及1600Unicode字符双上限切块，重叠不超过48token且不拆Unicode字符；分块规则进入索引指纹", why: "固定字符数使英文碎片过短，中文则必须防止单块超token上限", layer: "unit", depth: "deep", scenarios: ["conversation-index-token-bounded-chunks"] },
    { id: "mm-52", feature: "派生证据升级闭环", description: "默认召回与派生登记前处理持久失效待办；行为计量升级撤销全部系统观察，旧了解证据仅撤销 understanding 范围，两者同时发生共用一次全量闭包。事务失败不确认待办且允许重试，无待办不写库。了解来源必须绑定稳定 artifact 与输入版本，缺证据不能登记，用户事实不参与该闭包", why: "只隔离旧缓冲文件会留下已沉淀的旧口径结论继续被召回；确认待办早于事务会导致永久漏清理", layer: "unit", depth: "deep", scenarios: ["derived-evidence-coalesces-all-scopes", "derived-evidence-retry-after-transaction-failure", "derived-evidence-understanding-scope-only", "derived-evidence-no-pending-no-transaction"] },
    { id: "mm-53", feature: "了解沉淀的证据准入", description: "了解摘要来源身份绑定稳定 artifact、实际输入 hash 与摘要；同 artifact 只取最新可验证观察，无 evidenceId 或 evidenceHash 不登记。contentHash 仍校验摘要原文", why: "重复采样不是独立来源，只有摘要文本无法证明实际读过什么", layer: "integration", depth: "deep", scenarios: ["understanding-source-requires-evidence"] },
    {
      id: "mm-51",
      feature: "事实、画像与原话的统一查询改写和重排",
      description: "默认SQLite策略保留原问题并补有界改写查询；原问题和每条改写独立检索并以RRF融合，原问题权重2.5但不硬锁前排（强改写命中可越过弱原命中）且改写只补新候选；改写新增词须在原问题/前文或索引词表中找到依据（`conversation_term_check` 词表探测），否则拒绝该改写；事实排序使用bm25字段权重（正文3、摘要2、别名1）叠加精确短语、全关键词和实体覆盖的确定性分数，LIKE保留为词面回退。查询词与事实/对话索引统一NFKC及小写；结构化eventTime在SQL先过滤eventAt投影再排序，事实按id+version、原话按sessionId+eventId对存储来源身份去重；现实经历的重复提及与频率不等于来源条目数，仍须语义核对。模型只在同一计划上补充grounded entities/evidence needs，不重判本地intent/time/sourceRoles；模型输出受总字符预算约束但没有固定查询条数上限，已验证的同轮计划可在rewrite关闭时复用。显式指代只是路由线索，个人/历史/个性化建议即使少量动态命中也可在空当前上下文做中性扩词和有界互补检索，短跟进须有before前可见上文，社交确认或关闭模式不另调模型。候选并集标记用户事实/派生观察/原话角色，一次重排只认实际发送ID，未知ID/坏输出回退本地同份结果，合法空选择不补回。主动/精确目标不扩展检索；空query保留核心画像但不暖全库；版本不一致丢旧原话，冷索引/增强超时保留已预算的本地事实，真实取消不返回投影",
      why: "各通道各自改写或排序会重复付费且丢失可比性；只靠词表会漏自然措辞，而未锚定原问题的融合会让改写覆盖精确命中；空历史、超时和取消也必须有一致且可审计的退化语义",
      layer: "unit",
      depth: "deep",
      scenarios: ["memory-query-context-roles", "memory-query-context-headroom", "memory-query-plan-cache", "memory-query-personal-history-empty-context", "memory-query-contextual-followup", "memory-query-social-no-rewrite", "memory-query-rewrite-off", "memory-query-normalization", "memory-query-rewrite-existing-facts-history", "memory-query-rewrite-existing-facts-advice", "memory-recall-plan-followups", "memory-recall-joint-candidates", "memory-recall-joint-fallback", "memory-recall-event-identity", "memory-query-rrf-anchor", "memory-recall-targeted-isolation", "memory-recall-empty-query-core-only", "memory-query-rewrite-fallback", "memory-recall-revision-consistency", "memory-recall-empty-history-no-revision-failure", "memory-recall-local-deadline-fallback", "memory-query-corpus-synonym"],
    },
    {
      id: "mm-50",
      feature: "可见原话不包含内部写回协议",
      description: "会话读模型仅把助手text作为可见原话；RUNTIME_DATA跨text分块时先按完整正文解析去除，thinking不混入text，原entry身份与assistant角色保持。原话索引复用该投影，不另建协议解析规则",
      why: "只逐textpart解析会让跨分块的内部元数据进入会话检索和下一次模型输入",
      layer: "unit",
      depth: "shallow",
      scenarios: ["conversation-visible-text-only"],
    },
    {
      id: "mm-49",
      feature: "当前与跨会话原文索引的来源、分批发布和治理接线",
      description: "会话原文走独立只读引用通道，不把助手原话登记为用户事实；索引全部当前数据根会话而非打开标签，依照既有可见投影过滤可信用户/可见助手并保存角色、时间、原条目及锚点，同时投影记录日期、相邻原话与事件日期（`search_text`/`event_at_ms`/`event_at_date`，展示正文不变）。长正文分成有界Unicode片段，512条一批暂存，仅最后complete发布完整快照；取消不继续发布。清空捕获实际seq上界而非时间，删除后按真实会话白名单prune且召回返回前复核来源仍存在；明确短指代仅在关键词全部未命中时使用近期回退，普通miss不补随机历史。该单元层只验证TS接口与引用接线；Rust FTS/事务、墓碑与跨IPC运行由内联Rust用例负责，不冒充已运行的端到端证据",
      why: "只保留用户事实无法回答助手过去说过什么；整会话巨型提交、旧快照回写或原文绕过遗忘会让会话检索不可靠，需要把引用、预算和治理贯穿新通道",
      layer: "unit",
      depth: "deep",
      scenarios: ["conversation-index-batch-publish", "conversation-index-abort-staging", "conversation-index-sessions", "conversation-clear-seq-fence", "conversation-referential-fallback", "conversation-revalidate-deleted-source", "conversation-empty-query-no-scan", "conversation-index-session-absolute-path", "conversation-index-empty-session-skipped", "conversation-index-search-projection"],
    },
    { id: "mm-64", feature: "生产入口按记录时间检索原话", description: "真实生产回合写入可信用户原话后，经原生IPC执行空词查询；记录时间范围为[start,end)，命中范围返回该条且before同时间排他上界将其排除", why: "日期查询必须能以原话记录时间而非事件提及时间筛选，并保持 SQLite 搜索与回读的半开区间边界一致", layer: "e2e", depth: "deep", scenarios: ["memory-record-time-search"] },
    { id: "mm-01", feature: "记忆来源准入（两类通道，不混池）", description: "准入分两条互不混淆的通道：用户事实只收 origin=user + taint=trusted_user + eligibleForMemory=true 的已提交条目（助手台词、工具结果、压缩摘要、主动搭话、缺来源标记与 custom 控制条目一律出局）；系统观察只收 origin=derived_behavior + taint=derived + eligibleForMemory=true 的系统观察来源（画像稳定结论与静默了解观察摘要两个子类，见 mm-47），错配（如 derived_behavior+trusted_user）拒收。投递时刻冻结的 cardId 随来源落盘；派生来源独立登记（合成会话 behavior、身份含内容文本 hash），不冒充用户事实", why: "「谁说的」是记忆的准入判据：把工具/助手来源放进去，模型的一次措辞就会被当成用户长期事实；把系统观察混进用户事实池，归纳出的推断会被说成「你告诉过我」", layer: "integration", depth: "deep", scenarios: ["memory-source-admission", "derived-behavior-source-registration", "derived-behavior-gate-blocks-registration", "derived-behavior-new-source-version"] },
    { id: "mm-02", feature: "重排结果校验", description: "重排只接受候选白名单内的 id：未知 id、重复 id、非字符串、坏 JSON、散文与对象外形错误一律判无效并回退本地顺序，对象形态取 ids 字段；空数组是合法答案（这次不投影动态记忆），合法非空子集保序通过、不补回未选项；发送给模型的候选有界：已发送但未选中的候选视为明确不选并淘汰，发送窗口（最多24条）之外从未展示的候选保留在选中前缀之后", why: "模型只能决定「用哪几条」，不能决定「还有哪些」——白名单外的 id 会让不存在的记忆进入请求", layer: "unit", depth: "deep", scenarios: ["memory-rerank-fallback"] },
    { id: "mm-37", feature: "adaptive 选择门槛与调用边界", description: "只在动态候选超过6条时调用重排，core不参加；最多发送24个真实候选且受总输入预算限制，白名单只认已发送ID；已发送但未选中的候选按模型判断淘汰，未展示候选保留在选中前缀之后；合法空数组表示不投影动态记忆，非空只投影有序子集；写后刷新可显式跳过重排、不重复调用；精确反馈目标不参加重排并沿用同一次原子读取的revision", why: "重排的开销和模型可见范围必须由宿主冻结：候选太少不值得调用，未发送的候选不能进入白名单，合法的空选择不能被补回全部", layer: "integration", depth: "deep", scenarios: ["memory-recall-selection", "memory-rerank-unseen-retained"] },
    { id: "mm-38", feature: "模型查询的可见范围", description: "memory_query 绑定本轮已提交可信用户事件，按该输入冻结的 Card 只查 user＋当前 Card＋当前 session；没有可信 Card 时不发起任意 Card 查询，工具执行传入的 scope 不接受模型自选管理范围", why: "独立工具路径不能绕过普通召回的 scope 隔离去读到其它 Card 或会话的记忆正文", layer: "integration", depth: "deep", scenarios: ["memory-tool-card-scope"] },
    { id: "mm-03", feature: "SQLite 记忆库生命周期与召回快照", description: "真实 Rust 记忆库：来源登记幂等且只收两类准入来源（可信用户输入 origin=user+taint=trusted_user；系统观察 origin=derived_behavior+taint=derived——画像稳定结论与静默了解观察摘要两个子类，成对约束、错配拒收）；两字中文查询靠短词回退命中；强相关命中优先于importance；user/current Card/current session scope隔离；pinned core无关键词读取并与动态候选共享revision快照；prepared候选不进召回，过期候选与遗忘来源不可见", why: "scope、revision、相关度、有效期与遗忘抑制必须在真实 SQLite 边界成立，不能由前端拼接假设代替；来源类别是分池的依据，登记口放错一类等于把观察写成用户事实", layer: "e2e", depth: "deep", scenarios: ["memory-store-lifecycle"] },
    { id: "mm-04", feature: "完整事实预算口径", description: "MemoryProvider按实际全文token数核算；正文超单条、tier或总剩余预算时整条淘汰，保留否定和条件，不裁事实前缀；预算内条目逐字不变，投影声明预算等于实际全文用量，多条总量含表头、标签、出处与分隔符不越界", why: "截掉事实尾部可能改变或反转语义，预算压力应丢低优先整条记忆而不是注入残句", layer: "unit", depth: "shallow", scenarios: ["memory-recall-token-budget", "memory-recall-render-cost", "memory-recall-content-cost"] },
    { id: "mm-08", feature: "多轮会话条目持久化", description: "真实多轮对话后可按 sessionId 从 sessions/ 下的 JSONL 读回完整换行正文；后续回合只新增条目不重放历史；真Rust IPC负对照证明早轮未命中关键词而真实provider的conversation_context能补回；事实来源回读另以词面miss和有界预览为反例，验证真实来源治理、hash及JSONL完整正文，与生产收集器重复登记共用规范来源身份且不碰撞，before与clear继续阻止来源复活；超64KiB独立会话经桥接自动JSON blob索引后仍可召回末端原话，检索结果超单帧仍完整恢复，JSONL全文不变", why: "会话条目是真相源，UI 切换或重载不能改变读取目标", layer: "e2e", depth: "deep", scenarios: ["memory-multi-turn"] },
    { id: "mm-11", feature: "PromptSnapshot 的归属与身份", description: "三档快照（transform_context/provider_payload/provider_usage）可关联 request/turn/run；快照带请求归属（request.purpose/step/attempt）、参数（systemPromptHash 是整段 systemPrompt 的 hash：同一请求的三档必须一致，跨请求仍会随变量池、画像与瞬时块的内容变化而变（当前时间已移出 system prompt、改由尾随瞬时注记承载，不再是漂移源）—— 它只证明「同一次请求的三档没被换过」，不是配置指纹；payloadHash 与 requestParams 由 before_payload 从 Provider payload 采集，只落在 provider_payload 档、取不到就不写，不粘到同回合其它档）、计划与能力（plan/冻结的 capabilities.safetyMode 与逐请求累积的 toolDecisions）、槽代际（generation）、内核淘汰（budgetDrops）与换代身份（compaction.count、本分支最近一条压缩条目地址、摘要 hash）；一次性压缩请求以 one-shot:compaction 身份另立 payload+usage 两档条目，不写归属错误的主回合 payload（摘要正文只留 hash）；派生 rewrite 只保存 hash 与压缩条目地址；每条工具条目的 policyHash 取 toolPolicyHash(tool)，即策略指纹的 SHA-256：指纹含工具身份（id/source/sourceId）、策略版本、defaultDecision、effect/isolation/replay、resultProjection/historyCompaction、safetyLevel 与 actionCategory 共 12 项（原 `mode` 维度已随模式删除消失；策略版本已递增到 2，裁决语义变更前后写入的条目 hash 不同 —— 会话内 5 分钟的同参授权也随之不复用），这 12 项任一变即改变该工具在快照里的身份；投递输入的 agentMessages id 用其 deskpetEventId（无身份的用位置号回退），请求与输入的关联可按身份核对", why: "「这是哪次请求、带什么参数、第几代槽」必须能从快照回答：一次性请求不得写成归属错误的主回合快照", layer: "e2e", depth: "deep", scenarios: ["memory-snapshot-identity"] },
    // mm-11 原把「归属身份 + 保留/trace」合成一点（跨层混搭）；按层拆开：保留与 trace 侧为 mm-34（L3），归属与身份侧留在 mm-11（L4）。
    { id: "mm-34", feature: "PromptSnapshot 的保留与 trace", description: "快照保留顺序、hash 与 usage 区分（原始 Prompt 与密钥不落快照：systemBlocks 与 agentMessages 只存 hash），以及真实回合的 trace 完整性（provider_payload / provider_response / provider_usage 与 transform_context + provider_payload 双快照）", why: "上下文审计不能泄露原始 prompt、覆盖用户原文或把估算 token 当成实际 usage", layer: "integration", depth: "deep", scenarios: ["memory-prompt-snapshot"] },
    { id: "mm-13", feature: "工具成对观测", description: "工具调用与结果按 id 配对保留在会话条目，并被 runtime history 观测", why: "后续压缩和恢复需要完整 tool pair 基线", layer: "e2e", depth: "deep", scenarios: ["memory-tool-pair-baseline"] },
    { id: "mm-15", feature: "Plan checkpoint 恢复", description: "Plan 从会话条目 deskpet.plan_checkpoint 按 attempt 累计效果证据恢复：running/interrupted 步骤只要开始过非只读工具就进 unknown_side_effect，后续成功回执或只读事件不能抹掉证据；只读步骤回 pending。paused 计划里再次中断的步骤同样复核；同进程 resumePlan 先重新定档 interrupted 步骤，不跳过它们，也不重判已批准重跑的 running 步骤；明确 retry 才清除旧 attempt 的证据并只增一次 attempt，already_applied 则标 done。真实 resumePlan 遇未知效果直接拒绝、不发 Provider 请求；plan 的唯一持久形态是 schemaVersion 3（新增冻结 intent 与终态 completion，步骤记录可带 dependsOn 并随记录持久化、缺省不写），旧格式条目（含存量 1/2）按不可恢复跳过、不做迁移；completion 按盘上 done 步数在终态写 complete / partial / none，运行中不写。恢复执行经 readStepResults 从 deskpet.plan_step_result 条目回读前序结果（同 stepId 后写覆盖先写；形状不合条目跳过并留痕；读取 I/O 失败降级为无前序、不阻断恢复），与落盘 intent 一起注入后续步骤，且只有 stepId 小于当前步的结果进入交接；恢复后 dependsOn 指向已完成步骤的依赖视为满足，盘上没有成功结果的前序步骤（失败、被跳过或不在本次执行集合）让依赖后继按未满足跳过（判定与 skipped 归宿归 planner pl-06，本点只核对恢复读回的前序事实）。继续/丢弃由用户显式触发，未知副作用不自动重放，恢复动作可条目回读", why: "进程重启后不能重复执行没有完成凭证的外部操作；前序交接若在恢复时丢失，后续步骤会像第一次执行一样缺少已完成的上下文", layer: "integration", depth: "deep", scenarios: ["memory-plan-resume", "plan-recovery-effect-guard", "plan-resume-interrupted-step", "plan-resume-prior-from-disk"] },
    { id: "mm-16", feature: "上下文内核（纯预算）", description: "buildPromptBlocks 只做预算：窗口预算闭合（硬输入上限 + 输出预留 + 协议开销）、按层排序与拼接；核心块（静态人格/V1RTUAL/工具协议/工具 schema/动态运行时/会话摘要）放不进硬上限时显式 ContextBudgetError、绝不截块内文字，可选块整块淘汰并记入 budgetDrops；分配账目按层给出实际 requested/used（transcript 行保留但没有名义份额或借用字段，没有淘汰的层不写 dropped: 0）；完整静态前缀不随变量变化、工具 schema 完整计入输入预算；含会话正文的完整请求视图由托管钩子按同一硬输入上限核查（mm-22 的溢出恢复依赖它）", why: "Provider 输入需要可预测且可审计地限制在上下文窗口内，且不能静默丢失指令或未压缩历史", layer: "unit", depth: "deep", scenarios: ["memory-context-budget"] },
    { id: "mm-17", feature: "记忆投影形态与召回端口", description: "记忆块以 custom 消息投递（不是 system 消息）、不进 transcript、eligibleForMemory=false，判定函数只认专用 customType；MemoryProvider 可注入、取消、限时、裁剪并恢复，默认空实现不执行长期召回", why: "画像与长期事实必须留在派生数据一侧：一旦以 system 身份注入，它就成了指令，而召回内容还可能在下一轮被当成用户新事实重新提取", layer: "unit", depth: "deep", scenarios: ["memory-profile-rewrite"] },
    { id: "mm-18", feature: "消息条目单次写入", description: "一次真实回合后同一句话只有一条 pi 会话条目；后续回合不重复追加历史消息", why: "双写或历史重放会让重载出现重复消息与翻倍轮数", layer: "e2e", depth: "deep", scenarios: ["memory-single-message-write"] },
    { id: "mm-19", feature: "Harness 压缩与摘要内核", description: "手动/阈值压缩由 Harness 调度：宿主 before_compaction 生成结构化摘要并提交 compaction 条目，原始消息条目全部保留，contextEpoch 推进；摘要调用的 usage 落压缩条目并按 purpose 单列，不冒充主回合统计；摘要素材自身也走与请求视图同一套阶梯与投影（measureCompactionMaterial 是素材度量的唯一出口，级 0/1/2 与主请求共用 projectToolResultText 与同一份地址目录；两路同 level 除「工具循环软提示」这一视图独有尾行外逐字相同、素材级别 ≤ 视图级别，见 mm-27）：resultProjection=preserve 的工具结果正文逐字原样进入摘要请求 —— 只挡缩短/清空，不挡地址标注，同样带唯一前缀地址尾行；reference 的才被缩短并留下回读标记；素材超硬上限时按 planCompactionShards 串行分片（assistant 与其 toolResult 是不可分单元），第 N−1 片产出回填第 N 片 previousSummary，K 片 usage 合计后只提交一次（compaction 条目恒为 0 或 1 条）；「原文条目保留」同时覆盖折叠路径：压缩过的会话经生产折叠入口后，压缩前已有的条目 id 与 JSON 逐字不变、compaction 条目仍在、聊天视图正文序列不变", why: "摘要只能替换后续请求视图，不能删除会话真相源，也不能把压缩调度留在宿主第二套状态机里；一次性摘要的成本既不能混进主回合统计，也不能在总量里消失；素材超硬上限不能退化成「会话永久无法压缩」，分片必须是全量覆盖且只提交一次（部分覆盖或多次提交都会让历史视图悄悄分叉）", layer: "e2e", depth: "deep", scenarios: ["memory-compaction-checkpoint", "memory-summary-preserve-projection", "memory-compaction-shard-iterate", "memory-compaction-fold-integrity"] },
    { id: "mm-20", feature: "上下文窗口下限", description: "低于 65536 的窗口被拒绝：设置保存报错、运行期在模型解析处报错，合法窗口照常解析且不超过配置值", why: "窗口过小时压缩找不到可摘要范围，静默接受只会把预算问题推迟成运行期的另一种报错", layer: "integration", depth: "shallow", scenarios: ["memory-context-window-floor"] },
    { id: "mm-21", feature: "压缩阈值口径换算", description: "派生的 reserve/keepRecent 换算到 Harness 的计数口径：阈值落在本仓 normalInputTarget 上、先于宿主硬预算触发，保留窗口放得进消息空间，估算器偏差不越过硬预算余量，且保留窗口按**估算器最坏内容偏差**封顶（`⌊normalInputTarget / ESTIMATOR_WORST_CASE_BIAS⌋`）——跨尺子换算下纯非 ASCII 的保留段自身也放得进 normalInputTarget（`upstreamBias × keepRecentTokens ≤ normalInputTarget`），压缩切点才必然存在、压缩后请求必然缩小", why: "Harness 的 shouldCompact 在会话存在 provider usage 时按真实 usage 计，本仓估算同为目标真实 token 口径；估算器偏差一旦吃掉硬预算与正常输入目标的差额，硬预算就会先于压缩报错", layer: "integration", depth: "shallow", scenarios: ["memory-compaction-threshold-calibration"] },
    { id: "mm-22", feature: "硬预算超限的溢出恢复", description: "宿主 transform_context 核对出的硬预算超限经网关上报为 Provider 溢出响应，Harness 用宿主 before_compaction 摘要压缩后重试一次；超限请求不发给 Provider，压缩只改请求视图，原文条目始终保留。恢复用尽时按可解释的硬预算判定失败；上游因没有可安全摘要的范围 declined 时，失败分类保留上游文案，回复仍回落本回合的硬预算判定", why: "硬预算只是发送前的本地上限，直接终止回合会让 Harness 自带的一次性溢出恢复永远轮不到；恢复既不能改变会话真相源、不能把压缩挪到重试之后，也不能让用户丢掉可解释的预算判定", layer: "e2e", depth: "deep", scenarios: ["memory-budget-overflow-recovery"] },
    // mm-22 原把「恢复 + 分类」合成一点（跨层混搭）；按层拆开：分类侧为 mm-35（L3），恢复侧留在 mm-22（L4）。
    { id: "mm-35", feature: "硬预算拒绝的上报形状与失败分类", description: "本地硬预算拒绝以「上游认得出」的响应上报（length 停止 + 输出 0，命中 isRecoverableLength/isContextOverflow），普通投影错误不算溢出；失败分类只由「它是本地判定」决定，不随判定文案里估算数字的形态漂移（长数字串里的 5xx/401/429 片段不算状态码，真正的状态码仍命中对应分桶）——分类实现收敛在 src/services/error/failure-kind.ts 一处（生产回合结算与场景共用同一份正则表）", why: "本地拒绝先于请求发生，没有真实 provider 文案可命中上游溢出判据，上报形状是让一次性恢复轮得到的前提；分类不得把本地失败记成 Provider/认证/限流故障", layer: "integration", depth: "deep", scenarios: ["memory-budget-overflow-classification"] },
    { id: "mm-23", feature: "retain 保留守卫", description: "摘要范围覆盖声明 historyCompaction=retain 的工具调用配对时，宿主 before_compaction 内核 decline：不向模型发出摘要请求、不提交 compaction 条目、不推进换代身份，原文条目保持完整；注销 retain 声明后同一会话与同一载荷照常压缩。retain 是有意保留的能力（O-1 裁定 B）：生产工具目前全部声明 summarize，本覆盖点由测试场景驱动、字段不删", why: "宁可不压缩也不能把必须保留原文的调用配对静默摘要掉：覆盖边界一旦越过它，未覆盖历史就被模型输出的摘要顶替", layer: "e2e", depth: "deep", scenarios: ["memory-retain-guard"] },
    { id: "mm-26", feature: "估算器角色覆盖与偏差对账", description: "内容投影按角色表覆盖 compactionSummary/branchSummary/bashExecution/custom（摘要只计 summary 正文、excludeFromContext 的 bash 执行计 0），未知角色按整条估算并留痕；provider_usage 快照记录 tokenDrift（estimated/actual/ratio），actual 取**真实输入量** totalInputTokens(usage) = input + cacheRead + cacheWrite（2026-10-06 口径修正：只比 usage.input 会把缓存命中请求的偏差算大几十倍，定义与真机夹具见 mm-45），超 ESTIMATE_DRIFT_WARN_RATIO 只 warn 与 trace 带 driftRatio，不改变预算判定", why: "估算器系统性漏算某类消息会让硬预算与压缩触发点整体漂移，估算与真实 usage 的偏差必须可见才能定位", layer: "integration", depth: "deep", scenarios: ["memory-estimator-role-coverage"] },
    { id: "mm-27", feature: "L0 地址完整性", description: "工具结果的回读地址是条目 id 的唯一前缀（shortenAddresses 在当次 id 全集上取最短唯一，下界 MIN_ADDRESS_PREFIX=8；槽级缓存已发出的地址，仍唯一就复用、失效才重算 —— D-W2-8，故长度不是契约；读取端 resolveAddressRef 给 exact/unique/ambiguous/none 判别联合，完整条目 id 永远 exact 命中，前缀命中多条绝不任选）；地址无条件标注 —— 超阈值与否都带 `[回读地址 eventId=<前缀>，可用 read_session_event 分页读取]` 尾行，未缩短的结果同样带，preserve 的结果只挡缩短/清空、照带地址；无地址的结果不写假 eventId（缩短形态标「不可回读」占位串，未缩短形态不追加任何行）；无地址留痕按内容指纹（长度 + 首 NO_ADDRESS_WARN_KEY_CHARS=32 字符）分键去重、同键只报一次，集合有界（NO_ADDRESS_WARN_KEYS=64，满员按插入序 FIFO 淘汰最旧；淘汰语义由 test/unit/tool-execution/工具结果留痕上限.test.ts 直接断言 —— 同键去重、满员时最早键被淘汰、淘汰键可重新留痕，该单测无 caseId）；主请求与摘要素材共用同一份地址目录与投影实现，同一 level 下除「工具循环软提示」外逐字相同、素材级别 ≤ 视图级别（素材升档判据 hardInputLimit、视图 normalInputTarget）；该软提示是回合级运行时尾行，只由请求视图在投影后附加（三个投影档位都不丢）、随回合内存态消失，摘要素材按持久条目重建不带它，两路的投影函数、地址目录与级别判定仍同源", why: "回读地址是模型从缩短结果回到真相源的唯一通道，假地址会让模型读到「当前会话没有此工具结果」", layer: "e2e", depth: "deep", scenarios: ["memory-l0-address-integrity"] },
    { id: "mm-24", feature: "审计落盘闭环", description: "审计条目只入队、由唯一 flush 入口在 lane 空闲时写入；失败条目保留并重试一次；槽关闭前 flush 且残留非空记 error；transform_context/provider_payload/provider_usage 三档快照在一轮 production 回合里各至少一条且释放槽后集合不变", why: "证据链的组成项不能在槽生命周期结束时静默消失，否则「请求发过什么」这件事在重启后不可查", layer: "e2e", depth: "deep", scenarios: ["memory-snapshot-audit-closure"] },
    { id: "mm-25", feature: "摘要降级显式 decline", description: "宿主摘要内核失败时钩子返回 decline 而非抛出：/compact 报 failed 并在用户可见文案里给出原因；不提交 compaction 条目、不推进换代身份（readContextEpoch 与槽快照同为 0 —— decline 不是提交）；回合路径写 deskpet.compaction_declined 审计条目 —— 内核失败带 error 字段（原因文案；manual/overflow 触发的条目另带 decline.failure：错误码 + over_cap/oversized_unit 数字，经 describeCompactionFailure 映射），策略性拒绝（empty_material / retained_tool / gate_fits）在 manual/overflow 触发时同样落条目并带结构化 decline（kind/trigger/sessionId/关键数字），threshold 是每个检查点都会重试的内部优化、只留统一日志不落盘；decline 与 failure 语义分离（策略性拒绝不写 error、不翻用户文案），decline 记录用过即清；四个结局各自留一条统一日志（empty_material 此前完全静默）；失败路径不产生任何宿主之外的摘要正文 —— 助手正文序列逐字不变、provider 请求增量恰好等于内核摘要请求数（直接区分「钩子 decline」与「钩子抛错被上游回退通用英文摘要」两个世界：后者会多发一次请求并提交一条不可回滚的摘要）", why: "上游通用英文摘要一旦提交就成为后续所有回合唯一的历史视图且不可回滚，宁可不压缩也不落违反协议的历史；decline 也不能顺手推进请求视图的换代身份；策略性拒绝同样没有用户可见原因（上游 declined 终态不带 error），审计条目与统一日志是它唯一的留痕出口 —— 不写就无从区分「素材为空」「保留守卫」「闸门装得下」与「超上限失败」", layer: "e2e", depth: "deep", scenarios: ["memory-compaction-degrade-declines"] },
    { id: "mm-28", feature: "上下文换代身份沿分支", description: "context epoch 由 delivery.ts 的 readContextEpoch 沿 lane 分支回溯已提交 compaction 条目得出；槽快照、请求快照与设置页显示共用它；读失败不写 0；K 片分片压缩仍只提交一次 compaction 条目，换代身份因此每次压缩只推进一次（不按片计数）", why: "换代身份必须按分支算：会话级全量计数会把其它分支的压缩算进来，未知时写 0 会让快照谎称请求视图未换代", layer: "e2e", depth: "deep", scenarios: ["memory-context-epoch-branch"] },
    { id: "mm-29", feature: "动态提示与思考强度文案", description: "聊天动态提示由 composeDynamicPrompt + CHAT_THINKING_HINTS 唯一拼接：变量池正文 [+ 强度后缀]（强度取 CONFIG `aiConfig.thinkingEffort` —— 会话级覆盖机制已随 2026-10-06 用户裁决删除，消费点直读，唯一真相源是配置），**不含当前时间**；一次性调用不经过这条拼接，非推理模型 + low 档时的兜底提示是 ONE_SHOT_LOW_EFFORT_HINT，两者刻意不同。当前时间由 currentTimeNote 唯一生产（`[当前时间] YYYY-MM-DD HH:mm 周X`，26 字符、分钟精度），再经 createTurnNoteMessage 作为 **custom 尾随瞬时注记**逐请求附在请求视图**最末** —— 不出现在 buildPrompt 的任何块、systemPrompt 或 staticPrefix 里。落位理由是前缀缓存：缓存只在第一个差异处之前命中，而 system prompt 整体排在会话正文之前，每回合变化的内容留在那里会让整个会话正文每轮重新计费；附在消息数组末尾时差异点落在「本来就是新的」那一段，不额外损失缓存。注记带 eligibleForTranscript/eligibleForMemory = false，并被 isTransientInputMessage 判为瞬时输入（token 归 ephemeral 行，不虚增 transcript 行）", why: "文案散落三处时改一处就分叉，且没有任何断言拦它；system prompt 必须逐字节稳定，否则会话正文的前缀缓存每轮作废", layer: "integration", depth: "shallow", scenarios: ["memory-prompt-composition"] },
    { id: "mm-30", feature: "窗口下限错误的归因", description: "模型解析处报出的窗口下限错误区分「模型目录窗口与配置取小」：指出模型 id 与配置值并建议换模型；设置页校验文案不变", why: "把模型能力问题报成配置问题会让用户去改一个本来合法的值（无可修旋钮）", layer: "integration", depth: "shallow", scenarios: ["memory-context-window-message"] },
    { id: "mm-33", feature: "摘要素材分片与上限失败", description: "摘要素材按硬上限分片：规划器 planCompactionShards 把 assistant 与其 toolResult 串成**不可分单元**（工具批次原子性——绝不把一条 tool call 与其结果拆到不同片），贪心装箱到 COMPACTION_SLICE_RATIO = 0.8 的片预算，非法起点并前，两种 fatal 用可区分原因明确失败而不是尽力而为：`oversized_unit`（单条素材本身超硬上限，used = 单元成本 + overhead、limit = hardInputLimit、needed = ceil(used / sliceBudget)）与 `over_cap`（片数超 MAX_COMPACTION_SLICES = 8），抛 CompactionOverflowError（code = COMPACTION_MATERIAL_OVER_CAP，detail = { reason, needed, used, limit }）且**零 provider 请求、零提交**。**fatal 存在时 `ranges` 恒为空数组**（判片数必须先判 fatal）。摘要内核按片**串行**请求（不并行），第 N−1 片的产出回填为第 N 片的 previousSummary，K 片 usage 合计，最后**只提交一次**。素材度量由 measureCompactionMaterial 单点产出（overhead + Σcosts === used 是构造性恒等）。真实链路的 preserve 载荷分片迭代见 `memory-compaction-shard-iterate`（mm-19 名下）", why: "问题 B 的根因是「素材超硬上限即抛错 → decline → 上游放弃」，约 12 条满额工具结果即可触发且此后阈值/溢出//compact 全部同样失败（会话永久无法压缩的高危洞）。分片是唯一能同时满足「不丢内容」与「装得下」的改法；而工具批次若被拆开，摘要会看到半截工具对，那是静默的语义损坏", layer: "unit", depth: "deep", scenarios: ["memory-compaction-shard-plan"] },
    { id: "mm-32", feature: "手段阶梯与闸门", description: "工具结果压缩改为按**激进度**排的分级阶梯（级 0 不动 → 级 1 缩短 → 级 2 清空 → 级 3 摘要），规划器 planToolResultLadder 只认一个「装得下」判据：请求视图估算 ≤ contextBudget(window).normalInputTarget（运行期口径，不传 maxOutput），升到装得下就停、不做无谓升档。级 1 与级 2 共用同一个「单条上限」（校准时只调一个旋钮）；**级 2 的硬前提是必须有地址**——无地址的结果永远停在级 1（清空后捞不回来才是灾难），实测无地址 + 级 2 的输出与级 1 **逐字相等**。级 3 前是**闸门**（纯函数 ladderGate，与投影同一个 measure）：before_compaction 先跑级 1/2 的零成本阶梯，压完视图装得下就不花摘要调用（**一次摘要 LLM 都不花**）；压完仍装不下才走级 3；仅 reason === \"threshold\" 生效，manual/overflow 与缺 systemPrompt/buildGate 一律安全回退为照常摘要。**闸门自身的 decline 分支在当前 production 阈值路径上不可达** —— 实测由前置守卫「摘要范围为空」先拦截，场景钉住的是 0 次调用这个事实；不得据此宣称用户可见的「策略性不压缩」行为。", why: "零成本手段只有一档时，要么压缩失败（会话永久无法压缩）要么白花一次 LLM。本覆盖点是问题 C 的唯一出口，同时钉住「装得下」只有一个判据、级 2 只有一个硬前提，避免第二份判定链", layer: "e2e", depth: "deep", scenarios: ["memory-projection-ladder", "memory-ladder-gate"] },
    // mm-32 原把「阶梯/闸门 + 保护区」合成一点（跨层混搭）；按层拆开：保护区侧为 mm-36（L2），阶梯与闸门侧留在 mm-32（L4）。
    { id: "mm-36", feature: "工具结果阶梯的保护区", description: "**保护区**（LADDER_PROTECTION_TURNS = 3，轮口径取上游 findTurnStartIndex：user/bashExecution 开轮，toolResult/assistant/custom/compactionSummary 不开轮，不足 N 轮全保护）**只挡级 2 与级 3，不挡级 1**——级 1 是无损缩短，保护区内照做", why: "没有保护区的清空会把用户刚说的话也清掉；轮口径必须与上游 findTurnStartIndex 同源，否则保护边界整体错位", layer: "unit", depth: "deep", scenarios: ["memory-ladder-protection-zone"] },
    { id: "mm-39", feature: "记忆 revision 的进程内分发", description: "publishMemoryRevision / subscribeMemoryRevision 是 Node 领域侧的进程内总线（L3）：订阅者收到已提交的 revision（含 await 到全部消费者处置完成再返回的本地语义），退订后不再分发；跨窗口同步（旧壳 deskpet-memory-revision-changed/-applied）不属 Node 图 —— 单 Node 架构下所有提交都发生在本进程，订阅与发布都在本地完成", why: "revision 是「已提交」的通知值：丢弃它会让 runtime 对陈旧投影继续应答；退回事件回环则把纯 UI 的窗口协调重新塞进 Node 领域面", layer: "integration", depth: "shallow", scenarios: ["memory-revision-local-dispatch"] },
    { id: "mm-40", feature: "保留窗口随窗口长大", description: "保留窗口分两层。**源码预算值** `keepRecentTokens`：上限**不与压缩余量共用 `MAX_HEADROOM`** —— 先 `max(20_000, min(80_000, ⌊窗口 × 1/4⌋))` 得到本次上限，再与既有的 `⌊normalInputTarget × 40%⌋` 取小；小窗口仍被 20k 兜住（与拆封顶之前的旧口径逐字相同，不回退），大窗口才松开、1M 在 80_000 封顶；曲线随窗口单调不减。**交给 Harness 的生效值**再按估算器最坏内容偏差封顶：`min(预算值, ⌊normalInputTarget / ESTIMATOR_WORST_CASE_BIAS⌋)`（常量 = 4）—— 上游 findCutPoint 按 chars/4 计，保留窗口在上游口径下保住 `keepRecentTokens × 4` 个字符，纯非 ASCII 时就是 4 × keepRecentTokens 个本仓 token；不封顶会让保留段自身顶破 normalInputTarget（阈值压缩素材恒空却先撞硬预算、中文会话到窗口上限后无法再压缩；跨尺子不变量见 mm-21）。带偏差封顶后的生效数字：128k 窗口预算值 32_768 → 生效 23_016（封顶咬住）、200k 50_000 → 37_750（同）、1M 仍 80_000（封顶不触及）；压缩之后请求必然缩小", why: "两个量性质不同：压缩余量是**压缩调用自身的操作开销**（固定封顶是对的），保留窗口是**给用户的近期上下文**（该随空间涨）。共用封顶会让窗口越大越早、越狠地压掉历史——200k 与 1M 窗口下占窗口的比例越来越小；而跨尺子换算下保留段可被上游放大 4 倍，不另设偏差封顶会让中文会话压不动", layer: "unit", depth: "shallow", scenarios: ["memory-keep-recent-scaling"] },
    { id: "mm-41", feature: "策略性拒绝的留痕", description: "策略性 decline（`empty_material` / `retained_tool` / `gate_fits`）在 manual / overflow 触发时落 `deskpet.compaction_declined` 条目，带结构化 `decline`（kind、trigger、sessionId、关键数字如 messagesToSummarize / retainedMessages / tokensBefore / keepRecentTokens），并在统一日志里留一条可读原因；`threshold` 只在日志留痕、不落条目（它是每个检查点都会重试的内部优化，落盘会逐回合累积噪音）。用户可见文案不变：`declined` 仍映射 Card 的 `compactDeclined`，**不并进 `failed`**（条目 `error` 字段必须为空），也不并进 `nothing`", why: "拒绝不留痕时，用户与开发都无法回答「为什么没压」——实测一次 44 条会话的手动压缩被判 declined，会话与日志同时零痕迹，只能靠回放 journal 复算才查出是「素材全在保留窗口内」（6,686 token < 20,000）", layer: "integration", depth: "shallow", scenarios: ["memory-compaction-decline-audit"] },
    { id: "mm-42", feature: "压缩失败诊断的可判定性", description: "`describeCompactionFailure` 把摘要素材规划的两条 fatal（`over_cap` 片数超上限、`oversized_unit` 单元超硬限）描述成**可判定的错误码 + 全部数字**（需要片数/上限、单元成本/上限），普通错误与预算错误**不得冒充** overflow 形态", why: "「压不动」和「没得压」是两条完全不同的处置路径：前者要调上限或改分段，后者什么都不用做。描述层含糊会让用户和诊断都分不清该走哪条", layer: "unit", depth: "shallow", scenarios: ["memory-compaction-overflow-diagnostic"] },
    { id: "mm-43", feature: "记忆整理的前置查询（无新来源不开作业）", description: "dreaming 在创建 Review 作业前先查「水位之后还有没有待处理来源」（`memory_pending_source_count`，与 `memory_job_sources` 共用同一段水位判定 SQL，2026-10-06 起按来源类别分开查——用户事实与系统观察各自成作业，只有派生来源时照常开派生区作业）：该类没有 → 不开该类 Review 作业、不动预算/租约，以 empty 如实回报（手动入口走同一条前置查询——Review 的输入只有这些来源，空跑与跳过对用户是同一种结果，文案如实说明）；两区都没有新来源时不整段跳过，转入库内合并整理（`runMergeSweep`：先一次有界列举，无「同 origin 区内、同 scope、同 kind、≥2 条」分组时零写早退——不创建作业、不动预算、不调模型；有分组时只合并用户区，走模型产出合并候选（最多 3 组、单组最多吸收 4 条＝Rust `SUPERSEDES_MAX`＝protocol `maxItems`），Rust 发布事务复核被吸收条目（仍在库、同 scope/kind、未置顶、同来源类别）并把旧条目来源并入候选来源集合（来源并集在事务内强制、旧条目自己的来源一条不丢，墓碑复核按并集后集合），多目标逐个 supersede（旧行与版本链保留）；`supersedesIds` 只经 dreaming 发布路径接受、治理写入明确拒绝；冲突按 MEMORY_CONFLICT 如实失败）；有 → 照常创建 Review 作业；恢复既有作业（resumeJobId）不经前置查询，job 自带游标、水位为空也要能继续（恢复不分类别，水位按会话隔离、两区互不吞并）", why: "空闲命中即开作业会在没有任何新来源时白耗一次 job 创建与租约；而「水位之后有无来源」的判定必须与批内取数同源——另建一套水位口径会让两处静默漂移，跳过判断就会漏掉或虚报来源；两区混在一个作业里会让一区的积压吞掉另一区的批；无新来源时的库内合并也要有界（分组上限、零写早退），旧条目复核与来源并集必须在发布事务里强制，否则合并会丢来源或吞掉别的分区", layer: "integration", depth: "shallow", scenarios: ["dreaming-pending-gate-skip", "dreaming-pending-gate-proceed", "dreaming-pending-gate-manual", "dreaming-pending-gate-resume"] },
    { id: "mm-44", feature: "记忆整理的档位门禁与数值消费", description: "startDreaming/stopDreaming 向统一内部调度器注册/撤销作业，按 ai.memory.dreaming.tier 档位表取值（2026-10-06 固定钟点裁决：不再要求系统空闲）：off = 早退（不查 token 账、不自动开整理作业；手动入口 runDreamingSweep 不受档位影响）；三档决定固定钟点表（低 12/20、中 10/14/18/22、高 9/11/13/15/17/19——钟点后 15 分钟追赶窗口内到点即跑、先私有持久槽认领再开工；模块重载仍不重放同一失败槽，新的钟点才可重新认领、表外钟点与 23–9 静默时段不跑；判定纯函数与静默了解共用 proactive/schedule.ts）与最小间隔（240 / 60 / 30 分钟；钟点间隔已大于它，保留为防重兜底）。日 token 上限已按 2026-10-06 用户裁决撤除：当日 token 账烧过旧上限（低档 24000，已用 30000）后作业仍照开，调度层不再读 token 账，批次也不再被 token 账中止；token 的预留/结算照记（账照记、不作准入），档位表中的 dailyTokens 与 idleSeconds 字段整体删除。数值唯一来源是 proactive tiers 档位表，不是旧 flat 常量", why: "档位若不落到钟点/间隔两个消费点，配置选择形同虚设（off 仍自动跑、空闲要求回归、高档被旧间隔挡住）；而日 token 上限是会与功能相互踩的资源账（烧满即表现为整理莫名不工作），不再是准入条件，档位表若残留该字段会读起来像门禁", layer: "integration", depth: "shallow", scenarios: ["dreaming-tier-off", "dreaming-tier-medium-slots", "dreaming-tier-quiet-hours", "dreaming-tier-low-values", "dreaming-tier-high-slots", "dreaming-slot-restart-no-replay", "dreaming-claimed-slot-restart-no-replay"] },
    { id: "mm-45", feature: "估算偏差对账用真实输入量", description: "对账的 actual 取 `totalInputTokens(usage)` = `usage.input` + (`cacheRead` ?? 0) + (`cacheWrite` ?? 0)：`usage.input` 只是未命中缓存的一截，缓存命中记在 `cacheRead`、写入记在 `cacheWrite`，三者相加才是这次请求实际发出去的输入规模 —— 也正是 `estimateRequestTokens` 估算的对象。真机夹具（工具循环回合的一次 provider 回执）逐项钉死：input 387 / cacheRead 14208 / 估算 16679 ⇒ 单比 input ≈43×（曾经把偏差放大几十倍、越过 ESTIMATE_DRIFT_WARN_RATIO 刷告警），相加 14595 ⇒ 比值 ≈1.14×，落在阈值之下；cacheWrite 同样计入、缺省按 0。同一取数点同时服务落盘快照的两个字段：`deskpet.prompt_snapshot` 的 `actualInputTokens` 与 `tokenDrift.actual` 与之同源（主回合经 runtime.ts、一次性摘要经 model-gateway.ts 各自调用，口径一致）", why: "只比 usage.input 会在缓存生效时把偏差放大几十倍：告警刷屏成噪音、落盘对账记录失真，真实的小偏差反而被淹没；把口径收在 context/budget.ts 的唯一纯函数里，两条调用路径不会再分叉出第二份算法", layer: "unit", depth: "shallow", scenarios: ["memory-estimate-drift-total-input"] },
    { id: "mm-46", feature: "画像稳定结论的来源登记（系统观察准入）", description: "`collectBehaviorMemorySources` 把画像层 `sedimentConclusions` 的产出登记为 `derived_behavior` 来源：合成会话身份 `behavior`、条目 `conclusion:<slot>:<measurementVersion>`、sourceId/eventId 含计量版本与结论文本 hash（同结论幂等、新结论即新版本，seq 取登记时刻推进水位）；每条 `taint=derived`、`eligibleForMemory=true`、evidence 即结论文本（含判据）。非 reliable 档（unavailable/insufficient）返回空数组且不登记任何来源——原始观察不可能经这条链进入记忆", why: "准入闸门必须落在唯一的抽取出口上：门禁错位（例如在登记处再判一次画质）会让非 reliable 的数据漏进候选，或让可靠结论被静默丢弃", layer: "integration", depth: "deep", scenarios: ["derived-behavior-source-registration", "derived-behavior-gate-blocks-registration", "derived-behavior-new-source-version"] },
    { id: "mm-47", feature: "系统观察的整理（确定性 Review 与分区）", description: "dreaming 来源分两区、各自成作业（前置查询与批内取数按 origin 过滤）：用户区走模型 Review（prompt 里只有用户来源，派生来源不混池）；系统观察区走确定性 Review，两个子类的正文都原样沉淀、不经模型改写或演绎、不解析模型、不占 token 预算与预留（kind=fact、scope=user、pinned=false）——① 画像稳定结论（`conclusion:<槽位>:<计量版本>`，别名含 `behavior-slot:<槽位>` 标记）：同槽位已有旧条目时携带 `supersedesId` 覆盖（Rust 发布事务把旧条目置为 superseded 并失效主动引用）；② 静默了解观察摘要（`understanding:<证据与摘要身份 hash 前 16 位>`，别名含 `behavior-understanding:<hash16>` 与「静默了解」标记）：同 artifact 的相同输入幂等，缺证据摘要不得登记，在库了解条目以 12 条为上限，达上限后多出的新观察按最旧优先逐个携带 `supersedesId` 覆盖旧条目（一个候选覆盖一条、作业内不重复使用同一目标，目标用尽后不再产出）；清除静默了解时按 `understanding:` 前缀的同一 Rust 闭包（`forget_understanding`）失效了解沉淀（写墓碑、删条目/候选、推进遗忘代；画像结论不在范围）。同输入重跑候选指纹稳定", why: "观察结论若再交给模型演绎，等于让模型替观察下结论；两区若是同一批/同一 prompt，模型会把系统归纳当成用户陈述整理；没有槽位覆盖与有界窗口，几周内的结论漂移与重复观察会无界堆积成几十条过时「了解」", layer: "integration", depth: "deep", scenarios: ["derived-behavior-deterministic-review", "derived-behavior-supersede-chain", "derived-behavior-pool-separation"] },
    { id: "mm-48", feature: "系统观察的呈现标记（分区呈现）", description: "召回投影按条目的 origin 区分呈现：`derived_behavior` 条目的 provenance 位固定为「系统观察·可撤销的推断（非用户原话）」（`DERIVED_PROVENANCE_MARK`），用户事实仍是 `memory:<scope>:<sources>`；JSON证据数组区分kind及source，系统观察固定kind=observation且保留同一provenance标记，标记计入完整预算", why: "提示里不区分来源，模型会把系统归纳说成「你告诉过我」——这是用户可见的失实；标记必须在投影层逐行带上，不能只在文档里约定", layer: "integration", depth: "shallow", scenarios: ["derived-behavior-provenance-mark"] },
    { id: "mm-71", feature: "实体/方面拆解、事件级聚合与确定性最终选择分", description: "B2A：`deriveAspectSubqueries` 从查询形状生成 4–6 条去重 facet，命名实体优先、cue 语言跟随实体语言（英文语料不得收到中文检索词），单实体普通 lookup 不额外付费；活动/食物/书类问题额外补入独立的类别种子词（hiking/surfing、cake/icecream 等），不要求种子与实体同句，种子只是检索假设、语料无命中自然落空；facet 只保存在 `aspectQueries`，不混入模型 rewrite 输入，provider 在 rewrite 关闭或无 suppliedPlan 时也把它并入 base 查询，原问题始终 index 0。B2B：`conversationEventKey` 统一 user 入口与 assistant 的 entry/event 锚点，`fuseRankedListsScored` 保留既有 RRF 顺序并暴露分数；会话候选先按事件聚合再按事件数执行 limit，完整 user/reply 回合不会被边界拆开，也不会留下失去 user 锚的孤儿回复。最终选择分固定为检索排名 0.45 + 实体覆盖 0.25 + 角色匹配 0.12 + 记录/事件时间 0.10 + 邻近度 0.03 + 来源价值 0.05；实体覆盖可压过相邻一个检索位但压不过更远排名，记录时间优先取来源观测时间/validFrom，事件时间不冒充记录时间；同一 scorer 接入候选准入、adaptive rerank 窗口与 coverage 淘汰。", why: "cat1 的候选缺口集中在多实体/多方面问句，单靠原问题一个词面通道找不全；同一检索带内的候选只看排名无法区分实体命中，而按 entry 数执行上限会把完整回合截断或整组丢弃。身份、分数与上限若各留一份定义，召回、重排和补查会静默漂移。", layer: "unit", depth: "deep", scenarios: ["memory-aspect-subqueries", "memory-aspect-single-entity-skip", "memory-aspect-chinese-cues", "memory-aspect-cue-language", "memory-aspect-category-seeds", "memory-event-key-anchor", "memory-fusion-scored", "memory-recall-aspect-fanout", "memory-recall-selection-entity-order", "memory-selection-entity-tiebreak", "memory-selection-time-match", "memory-selection-source-value"] },
    { id: "mm-73", feature: "列项抽取与最终记忆块 enumerationItems", description: "列项问题在 reader 之外增加宿主侧专注于 `enumerationSourceIds` 的抽取：来源集合与最终列项证据共用最多 32 条上限，按每批 8 条逐批抽取并合并去重；每批 wire sourceId 只在批内有效并映射回真实 sourceId，项目必须逐字出现在该批实际发送的 snippet 中，拒绝改写、未知来源、超长项目和重复项；逐字命中后还要求项目至少有一个具体内容词：剥离原问题内容词、通用修饰词与类别词后仍须有 residue，`dairy-free desserts` / `favorite flavors` / `outdoor activities` 等类别或问句片段拒绝；两个以上具体词的口味组合可保留（例如 A and B flavors），提示也要求完整口味组合不要因末尾是 flavors 而丢弃；项目名保留限定词，短片段若被更长项目包含则丢弃短片段（`chocolate` / `chocolate cake` 让位于 `dairy-free chocolate cake with berries`）；去空格后相同的项目（`coconut milk ice cream` / `coconut milk icecream`）合并为一项；合并后最多 12 条。单批失败、超预算或非 stop 保留其他批次的有效项目，取消则丢弃迟到结果。结果放入 `guide.enumerationItems`，记忆块 JSON 输出 enumerationItems（wire sourceId），`answerSourceIds` 覆盖对应来源，主答必须全部列出；抽取失败或取消回退原证据，不伪造项目。", why: "弱 reader 可能只摘第一个会话；列项问题的完整性不能依赖 reader 的 note 数。抽取器若一次塞入过多来源，弱模型容易只摘前两项；若沿用小于最终证据的硬上限，后面的 item-bearing 回合（如 q0075 的 D3:4）根本不会进入抽取。逐字命中也不等于项目：类别问句片段会污染最终证据并让答案补全追加非项目，过短的项目词还会把完整甜点拆成原料/口味。分批、具体性、最长项目与变体去重共同把「看到全部来源」「只留具体项目」「保留完整项目名」拆成可验证的关。", layer: "integration", depth: "deep", scenarios: ["memory-reading-enumeration-extract", "memory-reading-enumeration-render", "memory-reading-enumeration-batches", "memory-reading-enumeration-partial-batch", "memory-reading-enumeration-concrete-item", "memory-reading-enumeration-specific-item", "memory-reading-enumeration-variant-dedupe"] },
    { id: "mm-74", feature: "列项答案缺失项判定与补全后缀", description: "主答可能只写 `enumerationItems` 的一部分；纯函数只追加最终正文中尚未出现的项目，保留主答原文。匹配按 NFKC/lowercase 的词序列连续匹配，长短语允许去空格回退（icecream/ice cream），短词不把 cake 命中 cheesecake，中文按去标点短语匹配；补全后缀跟随问题/项目语言（Also:/补充：），重复项目按来源顺序去重，空项目不产生补全。主答整体是短弃答句（无信息/无法确认）时，用已校验列项替换弃答，不追加 Also/补充；解释性回答仍走最小后缀。", why: "列项完整性不能继续依赖提示词自觉；补全只能补宿主逐字校验过的项目，不能误判短词、重复已写项目或改写主答，也不能让「无信息 + Also」自相矛盾。", layer: "unit", depth: "deep", scenarios: ["memory-answer-enumeration-append", "memory-answer-enumeration-no-duplicate", "memory-answer-enumeration-short-word", "memory-answer-enumeration-cjk", "memory-answer-enumeration-dedupe", "memory-answer-enumeration-replace-refusal", "memory-answer-enumeration-replace-refusal-cjk"] },
    { id: "mm-75", feature: "列项答案提交前补全与结算同源", description: "宿主在 afterResponse 完成 RUNTIME_DATA 剥离与拟人变换之后、条目提交之前做确定性补全；补全结果同时写回提交消息与回合状态，结算回复直接采用与 JSONL 条目同源的正文，避免 generateReply 从原始正文重解析时丢掉补全项；多泡回复只把后缀追加到最后一个可见段；trace 只登记 itemCount/appendedCount，不写用户项目正文。抽取失败、无列项、沉默回复或主答已含全部项目时不产生补全。", why: "补全若只改提交消息而不改结算回复，界面仍会显示漏项；若只改回复而不改条目，JSONL 与界面会分叉。", layer: "integration", depth: "deep", scenarios: ["memory-answer-completion-runtime"] },
    { id: "mm-72", feature: "同线程邻接补全与方面候选词假设", description: "B2C 根因补全：把已选中的会话强命中按会话分组，取命中序号的并集 ±2 回合、每个会话一次 `conversation_context` 扩读，单会话跨度上限 10 轮、最多 3 个会话、2k token；只读后用 JSONL 逐字校验，按完整 user/reply 回合准入，保持 seed 在前、不重复计数；`before`、记录时间窗与 revision/遗忘代变化边界沿用既有展开；事件时间题不做记录时间邻接扩读；显式 overview 与已校验的缺口引用走原有整会话/定向展开，不重复补全。rewrite 提示允许模型提出最多 4 个方面候选词作为检索假设（活动/食物/书/地点/物品名），但必须经 `conversation_term_check` 确认语料存在，语料外词整条拒绝；候选词不得被断言为事实。读者口径允许相邻原文直接、明确写出的同类项目作为自身依据，仍禁止仅凭相邻关系补造未写出的项目。列项问题由 `enumeration` evidenceNeed 驱动：reader 未穷举时，宿主按问题词/类别种子词筛出匹配会话，按会话排名保留完整回合，并在 32 条上限内按会话轮转（每个匹配会话先取一个命中回合，再轮回补入其余回合），避免单个早会话吃满预算或弱 reader 只摘第一个会话；匹配会话的全部完整回合都会进入候选，远邻项目不因不含问句词而被丢弃。", why: "q0075 缺的甜点是命中话题的相邻回合，q0035 缺的活动词与题面没有词面重叠；纯词面候选池无法覆盖上下文依赖和词汇差异，必须在检索与改写端补全，而不是在答案端猜。邻接扩读若无窗口/预算/事件时间/整回合边界，会把无关旁支和事件时间题一起污染；方面候选词若无语料校验，会变成模型编造事实。列项穷举若只靠 reader 提示，弱模型仍会只摘第一个会话，最终证据与 answerSourceIds 必须由宿主按匹配会话确定性补齐；按会话轮转还能避免单个早会话把 32 条预算耗尽。", layer: "unit", depth: "deep", scenarios: ["conversation-neighbor-window", "conversation-neighbor-span", "conversation-neighbor-budget", "conversation-neighbor-revision-fence", "memory-recall-neighbor-completion", "memory-recall-neighbor-general-skip", "memory-recall-neighbor-overview-skip", "memory-query-rewrite-aspect-hypothesis", "memory-query-plan-enumeration", "memory-reading-enumeration-evidence", "memory-reading-enumeration-session-rotation"] },
    { id: "mm-77", feature: "拒绝提醒不取消现实事项", description: "memory_change 的 cancel 与 correct→cancelled 在当前可信输入仅拒绝提醒时拒绝，不调用记忆写入；明确不去并取消事项时仍可提交", why: "提醒授权与现实事项状态不同，不能因模型选择取消动作就关闭 working 事项", layer: "integration", depth: "deep", scenarios: ["memory-reminder-refusal-not-cancellation"] },
    { id: "mm-78", feature: "时间语义贯通与有效期连续", description: "事实投影携带 observedAt/validFrom/validTo/expiresAt/eventAt（缺失字段不进入证据包），证据 JSON 保留记录时间、有效期间与事件时间；日精度事件锚输出本地日期，分钟精度按记录时区输出带偏移时刻，非法时区退回 UTC ISO 并留痕；管理详情分开显示记录时间、有效期间、发生时间、提醒时间、过期时间与事项状态，未记录/未限定/至今/未设置如实标注。纠正或系统观察 supersede 用同一个 now 关闭旧版本 validTo 并开启新 validFrom；合并取所有目标中最早的已知 validFrom，并在同一时刻关闭全部被吸收目标。更正后旧版本的用户原话来源、锚定转述与按有效区间判定为旧版本的助手引用退出会话召回，同值更新不触发；跨会话转述的引用溯源闭包由 mm-81 的真实 SQL 场景背书。", why: "召回 SQL 虽按有效期与过期时间过滤，但投影与证据包丢掉时间字段会让模型把事件时间当成记录时间、把旧值当成当前值；有效期断点或在纠正时重置为 now 会让偏好反转无法按时间解释，旧值仍可能被当作最新结论。", layer: "unit", depth: "deep", scenarios: ["memory-projection-temporal-fields", "memory-recall-temporal-fields"] },
    { id: "mm-79", feature: "助手引用溯源与遗忘闭包", description: "助手回复渲染非会话记忆事实或会话原文时，runtime 把本次实际渲染的 itemId 与 (sessionId, entryId) 写入 deskpet.memory_citations 自定义条目（关联 assistant 条目，两类各最多 64 个，控制面专用、不进入模型消息流）；重建会话索引只对可见助手条目的 chunk 0 登记 conversation_index_entry_refs 与 conversation_index_entry_quote_refs，建造侧按 (sessionId, entryId) 去重并丢弃空身份，宿主侧再拒绝重复、空身份或非 chunk 0 的引用，跨会话引用允许。词面检索、上下文分页、锚定助手与相邻助手读取统一排除引用了已不存在 itemId 的助手条目；引用过的会话原文被遗忘或所属记忆版本被内容更正后，该助手转述同样退出召回；用户自己的复述仍可召回；同一条目 id 恢复后该回复重新可召回；清除、替换、修剪索引时同步清理引用行。引用条目写入失败只留痕，不阻断回复。", why: "遗忘只删事实库时，由旧事实生成的助手转述仍会被原话召回带回，形成「忘了还提」的回响；引用溯源让遗忘与更正改变后续回忆行为，同时保留原始 JSONL 历史，也避免把用户后来的复述一起隐藏。", layer: "unit", depth: "deep", scenarios: ["conversation-index-citation-refs", "conversation-index-citation-visible-only", "conversation-index-quote-refs"] },
    { id: "mm-80", feature: "运行时引用溯源写入", description: "真实 agent loop 与 JSONL 落盘：带记忆召回的回合在助手条目提交后写入 deskpet.memory_citations；载荷只记录本请求实际渲染进提示词（预算保留）的事实条目 id 与会话原文 (sessionId, entryId)，记录真实 assistantEntryId 与 requestId；预算淘汰的原文、召回失败与召回为空都不写条目，失败只留痕不阻断回复。", why: "索引侧的引用闭包只有在运行期先如实登记「这次回复到底看过什么」才成立；把未渲染或未发生的来源写进溯源会让后续更正/遗忘错误隐藏无关回复。", layer: "integration", depth: "deep", scenarios: ["memory-citation-runtime-write", "memory-citation-runtime-rendered-only", "memory-citation-runtime-failure", "memory-citation-runtime-empty"] },
    { id: "mm-81", feature: "跨会话引用溯源的更正与遗忘闭包", description: "真实 SQLite：助手转述与来源原话分属不同会话，仅由 deskpet.memory_citations 的 conversationRefs 相连；来源事实被内容更正后该转述退出词面检索，真实 forget 写入的 block_extraction 墓碑同样隐藏转述，来源的同值置顶更新不隐藏；清除目标会话索引后由 citation 条目重建索引，闭包仍成立。", why: "跨会话转述没有同轮锚点，既有的 SUPERSEDED_SOURCE_EXISTS 与同轮抑制覆盖不到；只有真实 SQL 的 quote refs 闭包与索引重建才能证明无引用转述不会在更正或遗忘后继续回响。", layer: "e2e", depth: "deep", scenarios: ["memory-correction-recall-closure"] },
    { id: "mm-82", feature: "记忆整理的取消、失败与部分水位", description: "真实 dreaming 批次循环（memory 命令、来源收集与模型调用用替身）：取消发生在模型等待期间时，晚到的响应只结算已用 token，不解析候选、不写 staging、不发布，作业被回收并按 cancelled 收口；批次 checkpoint 之后取消同样不提交；第二批失败时第一批已推进的水位保留（coveredSourceIds 按批内来源），失败作业不提交并回收；单次作业最多 3 批 × 20 条，只对已处理来源推进水位，达到上限仍提交已处理候选，下一轮从剩余来源继续且不重读已推进部分。", why: "晚到的模型响应若继续写候选，用户已经取消的整理仍会改变记忆；失败回滚水位会让下一轮重复处理已入库来源，而越过未处理来源推进水位则会永久漏掉它们——取消、失败与批次上限三个窗口必须各自有可观测的收口。", layer: "integration", depth: "deep", scenarios: ["dreaming-cancel-late-result", "dreaming-cancel-after-checkpoint", "dreaming-failure-keeps-watermark", "dreaming-batch-cap-partial-watermark"] },
  ],
  // W0–W7 把本契约的场景迁出 L4 后按 L4 侧当前值重标定：门槛=当前 rules 声明值，
  // 只缩不放（数字由 checker 报错提供）；跨层完整性由 checkLayerCoverage 负责。
  rules: { minScenarios: 17, minDeepScenarios: 17, requireBoundary: true, requireErrorPath: true },
}
