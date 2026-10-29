// 2026-10-28 公开集本地缓存：固定 .data/<dataset>/raw 与 dataset 目录，临时输出仍允许显式指定；下载先核对来源和散列，命中复用且不联网，损坏/漂移拒绝覆盖。eval-13 补缓存与默认目录反例；本批不改宿主、驱动、判分或分数协议。
// 2026-10-27 公开通用评测：新增来源/Parquet/适配/导入定义点与 eval-13；Judge packet3 分离预置历史，运行根持久绑定。
// 2026-10-27 判分权威溯源修复：judging.mjs 新增 coding-agent 平台白名单（claude-code／codex／qoder），
// judge apply 拒绝 API 客户端回填；authority 判定还要求平台在册，历史 deepseek-api 判分不再算权威；
// report 的判分身份句按判分记录生成。eval-11 补 chat-judge-authority／chat-judge-authority-history。
// sourceHash 按当前源码复算。
// 2026-10-24 整理取消窗口批次（定向复核）：sourceFiles 中 agent/memory/dreaming.ts 仅在
// 模型返回与批次 checkpoint 之后重核取消信号；评测的 trace、计分、导出、判分与保留路径
// 未改，eval-01..09 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-24 记忆时间语义批次（定向复核）：sourceFiles 中 memory/provider.ts 仅把
// observedAt/validFrom/validTo/eventAt/expiresAt 透传到投影，评测的计分、导出、判分与保留
// 路径未改；eval-01..09 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-23 计划入口与执行许可批次：sourceFiles 中 test/host/standard-setup.ts（计划门禁注释
// 随显式入口收敛）与 host/dispatch.rs（bash_exec 许可认领参数）变化；trace、评测计分、导出、
// 判分与保留路径未改，eval-01..09 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-18 B2C：共享 sourceFiles 中 trace.ts 的 memory_recall_end 白名单新增 neighborEntries；
// 评测计分/导出/判分链行为面不变，eval-01..09 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-18 B2 记忆召回定向复核：共享 sourceFiles 中 agent/memory/provider.ts 变化 ——
// 方面子查询并入 base 检索、确定性选择分仅在无 rerank 裁决时排序；评测计分/导出/判分链
// 与 trace/保留/性能路径行为面不变，eval-01..09 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-18 定向复核：sourceFiles 中 test/e2e/native-main.ts 与 scripts/e2e-test.mjs 变化 ——
// bench CLI 新增 `--bench-per-category`（正整数校验后传入 planBenchCells / runMemoryBenchEvaluation，
// 并写入 manifest.bench.perCategory）；trace、评测、保留与性能路径不受影响，eval-01..09 未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-15 定向复核：trace checkFingerprints新增受控obligation枚举，其余本域行为不变；
// 来源与诊断断言归memory mm-68，跨域不复制覆盖；按实际定义点复核后刷新hash。
// 2026-10-14：trace新增同render的有限ID页，不记录正文；eval-02隐私白名单与既有隔离语义复核，分页完整性归memory/mm-68。
// 2026-10-13 judge 默认值更新（本批刷新，承上一条）：sourceFiles 中 test/e2e/native-main.ts（benchJudgeModel 兜底
// 字面量 deepseek-reasoner→deepseek-v4-pro）变化；判分链行为面不变（仅默认值），eval-01..09 逐点复核未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-13 记忆侧 token 优化（本批刷新）：sourceFiles 中 agent/memory/dreaming.ts（review/merge 一次性调用显式 thinkingEffort=low）变化；评测计分/导出/判分链行为面不变，eval-01..09 逐点复核未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-10 整理水位推进修复（本批刷新）：sourceFiles 中 host/dispatch.rs（memory_job_checkpoint 分派臂加可选 coveredSourceIds）、memory/store.rs（批内水位按每个覆盖会话推进）、agent/memory/dreaming.ts（按批内已处理来源传参）变化；评测、trace、保留与性能路径不受影响，eval-01..09 逐点复核未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-09 最终静态复核：新增会话引用仅输出白名单身份字段，评分卫星与原报告同组保留，既有证据边界保留；验收已执行（L2/L3 与 Rust 单测全绿），sourceHash 按当前源码在验收轮刷新。
// 2026-10-05 设置页 Card 增删改查 + 模版批次：本契约 sourceFiles 中仅
// `crates/native-host/src/host/dispatch.rs` 变化 —— 新增一条 `personality_file_delete`
// 分派臂（命令矩阵 128→129），e2e_trace / benchmark / 质量与性能脚本路径不受影响。
// eval-01..eval-09 逐点复核行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— 仅 runtime.ts（RUNTIME_DATA 协议缺失
// 检测与提醒接线）。eval-01..eval-09 的 trace / 评测 / 保留路径逐点核对不受影响（提醒状态与
// log.warn 不新增 trace 事件、不改请求归属与快照落盘），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// 不新增 trace 事件、不改 provider_usage 快照与请求归属，评测、保留与性能路径不受影响）。
// eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现一致。本批刷新同时包含另一会话的
// 改动；本轮只做 coverage 描述与当前实现一致性核对（非逐行行为审计），未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志）与 harness-slot.ts（compaction_end 按
// manual/overflow 落 deskpet.compaction_declined 条目、threshold 只留日志）。两者不新增 trace
// 事件、不改请求归属、快照与报告保留路径。eval-01..eval-09 逐点核对实现点仍在、覆盖描述与
// 当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— crates/native-host/src/host/dispatch.rs
// 新增一条 chat_delete_session_images 分派臂（命令矩阵 134→135），不新增 trace 事件、不改
// 请求归属、快照与报告保留路径。eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现一致，
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（子运行 provider 准入转发与 invisible sinks；trace
// 提交、请求归属与快照链路未动）。eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现
// 一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/{runtime,model-gateway}.ts（估算偏差对账 actual 改用
// totalInputTokens；trace 事件、provider_usage 快照字段名与请求归属未动，只改字段取值来源）。
// eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 回合治理与图片生命周期批次（analyze→刷新）：sourceFiles 变化 ——
// test/host/standard-setup.ts（场景间重置改走 harnessSlots.resetTurnAdmissionsForTest()：
// AI 生成锁由回合受理状态推导，旧 cooldown 模块与 setAIGenerating 入口随删除退场）、
// engine/harness/harness-slot.ts（受理计数与 isAIGenerating）、engine/harness/runtime.ts、
// agent/memory/dreaming.ts。评测、trace、保留与性能路径不在改动面内（重置入口只影响场景隔离，
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// crates/native-host/src/host/dispatch.rs、memory/store.rs、src/services/agent/memory/dreaming.ts
// （dreaming 日 token 上限不再作门禁：空闲调度与批内预留都不再按 token 账拒绝/中止，账照记；
// 预留命令去 dailyLimit）。评测、trace、保留与性能路径不在改动面内，本契约覆盖点未修订；
// 本批刷新同时包含工作树中其它并发改动的源文件（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 提问选择与去超时批次（本批刷新）：sourceFiles 变化 —— `test/host/standard-setup.ts`
//（新增提问通道复位 resetChoiceChannel：默认按取消结算，L4 宿主没有选择面板时不悬挂）与
// `harness-slot.ts` / `runtime.ts`（等待期回合墙钟可暂停，注释面）。各覆盖点逐条核对实现点
// 仍在、描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 超时后台化批次（本批刷新）：harness-slot.ts（tool_execution_end trace 增
//durationMs / detailPrefix）与 runtime/trace.ts（白名单增两字段）—— 观测面附加，评估链路
//的产出与判定未动。各覆盖点逐点核对一致；sourceHash 按当前源码复算。
// 2026-10-06 派生行为结论沉淀批次（本批刷新）：sourceFiles 变化 —— memory/{store,commands,
// provider,dreaming}.ts 与 protocol.{json,ts}（第二类准入来源 derived_behavior：整理来源分
// 两区、用户区批次的模型调用与 token 账口径未变、系统观察区不过模型；记忆条目 JSON 增必填
// origin 字段）与 dispatch.rs（两个记忆命令增可选 origin 参数）。评估/基准链路的消费面
//（dreaming 产出计数、memoryJobSources / memoryList 形状）按新增可选字段兼容；各覆盖点逐点
// 核对一致；sourceHash 按当前源码复算（同批含另会话在飞改动）。
// 2026-10-06 Card 按需加载批次（本批刷新）：sourceFiles 变化仅限 test/host/standard-setup.ts
// （bootstrapOnce 不再先全量加载 Card，直接 initRegistry —— 激活卡由 registry 按需加载）。
// eval-01..eval-09 的 trace / 评测 / 保留路径逐点核对不受影响（引导序列的卡步骤仍在、
// 只是加载范围变小），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 提示判据与计划报告批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（runPlanPhase 的 onStepNotice 收窄：工具名不存在
// 仍发聊天系统消息；未限定工具只写进度事件与统一日志）、
// src/services/agent/memory/dreaming.ts（REVIEW_SYSTEM_PROMPT 判据加强：新增「记忆种类与
// 范围」一条；请求句/当场需求不算偏好、测试与调试任务不记；空数组是常见且正确的输出 ——
// 2026-10-06 用户裁决）。两者都不新增 trace 事件、不改请求归属与快照落盘，评测、trace、
// 保留与性能路径不在改动面内；eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现一致
//（描述/来源核对，非逐行行为审计）。未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-06 最终波统一刷新（本批刷新）：sourceFiles 变化 ——
// src/services/agent/memory/dreaming.ts（了解观察摘要的确定性沉淀候选；无新来源时的库内
// 合并整理：两区都没有待处理来源时不再在调度路径直接终止，而是走一次有界列举/零写早退或
// 一次合并作业）与 crates/native-host/src/memory/store.rs（候选草稿可选 `supersedesIds` 的
// 发布事务复核、来源并集在事务内强制、`forget_understanding` 清除闭包）。评测、trace、
// 保留与性能路径不在改动面内：memoryList / memoryJobSources 的形状未变（候选新增字段为
// 可选），runDreamingSweep 的 outcome 状态取值集合未变（新路径只给既有状态）；
// eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点；
// sourceHash 按当前源码复算。
// 2026-10-06 抽屉 CONFIG 写批次（本批刷新）：sourceFiles 变化 —— test/host/standard-setup.ts
//（会话级安全覆盖的复位入口 resetSessionSafetyMode 随机制删除退场：安全模式钉位只剩配置轴，
// 场景内改动由 restoreConfigBaseline 在下一个 trial 无条件收回；bootstrapOnce 的 initCards
// 删除上批已记）、src/services/engine/harness/runtime.ts（三处思考强度消费点直读
// `aiConfig.thinkingEffort`）。评测、trace、保留与性能路径不在改动面内（重置入口只影响场景
// 隔离与裁决输入钉位）；eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现一致
//（描述/来源核对，非逐行行为审计）；sourceHash 按当前工作区源码复算。
// 2026-10-06 Windows CI 修复（本批刷新）：crates/native-host/src/paths/mod.rs 只在测试模块内
// 增目录符号链接助手（symlink_dir）并换用于中间目录场景 —— 产品路径裁决逻辑未动，评测与
// trace 路径不受影响；sourceHash 按当前源码复算。
// 2026-10-07 便携与安装目录数据根批次（本批刷新）：sourceFiles 变化 ——
// crates/native-host/src/paths/mod.rs（便携标记 `portable.txt` 判定 `portable_data_root`；
// Windows 生产数据根改 `<安装目录>/userdata`（`SIDE_DATA_DIR` / `side_data_root` /
// `installation_side_dir`）；`AppPaths::init` 注入 `DATA_ROOT`、安全允许根跟随真实数据根）。
// 评测、trace、保留与性能路径不在改动面内：E2E 数据根分支（`DESKPET_E2E_DATA_ROOT` →
// `test/.tmp/e2e-*` 容纳校验）与 `is_e2e()` 双闸未动，新函数只服务生产启动选根（main.rs）与
// `allowed_file_roots`（security.rs 归 safety 契约）；trace 落盘仍直接钉在 data_root 下、
// release 存储基准仍用 `DESKPET_MEMORY_PERF_ROOT` 独立根。eval-01..eval-09 逐点核对实现点仍在、
// 覆盖描述与当前实现一致（定点对照当前源码，非逐行行为审计）；未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-21 整理判重批次（本批刷新）：sourceFiles 中 agent/memory/dreaming.ts 的 Review
// 输入新增在库条目摘要并接受 supersedesIds（只影响整理产出，不改判分、导出、trace 或性能
// 路径）。eval-* 逐点核对照旧，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-25 W2 隔离运行验收（本批刷新）：sourceFiles 新增 W2 隔离运行器与 direct-seed 装载
// 路径（Rust sim_eval 选根、main 单实例归属与分派前互斥、Node run-context 所有权、chat-bridge
// 装载摘要、direct-seed-plan／direct-seed 产品入口装载、sim-eval-run 起停脚本、desk-pet-chat
// eval 入口）。本机已通过 W2 相关 L2、tsc/cargo check、Rust 单测与真实隔离起停（含非法路径、
// 跨进程单实例、E2E 互斥与停止后锁释放）；eval-01..09 未修订覆盖点，sourceHash 按当前源码复算。
// 本批只验收隔离起停与装载；固定时钟、聊天驱动、证据／评分与正式报告由后续 W3–W6 批次实现。
// 2026-10-25 W3 采集封存验收（本批刷新）：纯 trace 从 test/trace/evidence.ts 迁入
// src/services/sim/trace-chunk.ts（E2E 观察器同步 import，原文件删除）；新增 capture.ts 的
// 跨会话取证与 trace-recorder 的 trial 归属／有界分块；sim-eval-run 与 chat-bridge 增加采集
// 生命周期、封存与同源报告接线。验收轮已运行 W1/W2/W3 定向单测、tsc/cargo check、Rust 单测与
// 三次真实隔离 prepare/start/finish（不完整证据退出码 1），并修复 capture.ts attemptId 取尾段与
// trace-recorder CaptureState 缺 periodicFlushing 的类型错误。eval-01..09 未修订覆盖点，
// sourceHash 按当前源码复算。
// 2026-10-25 W4 判分包、独立 judge 与可选抽查验收（本批刷新）：sourceFiles 新增聊天评测测试侧
// 行为定义点（dataset／evidence／judging／report 与题型／类别表），sim-eval-run 增加 judge prepare／
// apply、review show／spotcheck 与 report 子命令，desk-pet-chat 同步 dataset／capture 入口；
// direct-seed-plan 的 fixture schema 版本随数据集升到 4（装载器只接受当前 fixture 格式）。
// 验收轮已运行 W4 快层、完整 unit、tsc／cargo check、Rust 单测与测试规则扫描，并修复判分包返回
// 结构的消费者取错字段（CLI 与快层测试把嵌套 packet.packetId 当顶层使用）。eval-01..09 未修订覆盖点：
// 聊天判分／抽查／同源报告的 coverage caseId 与固定时钟／聊天驱动由后续 W5／W6 批次补齐（eval-10–eval-12）。
// sourceHash 按当前源码复算。
// 2026-10-26 W5 请求/回执绑定与抽查换代（本批刷新）：新增
// src/services/sim/message-operation.ts（消息操作身份的零依赖校验），chat-bridge 在评测运行内
// 要求每条消息携带驱动 operation、按 requestId 复用输入身份，并只按 readRequestResponse
// 的 run 分支取证忙碌投递回复；engine/harness/delivery.ts 新增按 requestId 绑定回复的只读查询
// （首次 run 的 fromTipId=null 按会话开头处理）；sim-eval-run 校验回执原样回显试用／会话／代际，
// 抽查只统计当前判分的记录。eval-10／eval-11 增补对应覆盖点与场景。
// 2026-10-26 CE-07 检查点补强（本批刷新）：workflow.mjs 的 memory_extraction_end 改为在消息副作用
// 之前抓 jobs 基线，只把基线之外的新抽取作业算作本步触发；新作业须到达终态（completed／failed／
// cancelled）且 pendingSources／activeJobs 归零稳定后才满足，空闲 0/0 不再通过。chat-bridge 的
// memory_state 回执补 jobs 列表；用例把纠正与食物选择对齐抽槽并新增 food-processed 检查点。
// eval-10 补基线、新作业与取消三组反例；sourceHash 按当前源码复算。
// 2026-10-26 W5 闭环与 W6 Contract 覆盖（本批刷新）：新增固定时钟
// src/services/sim/clock.ts、chat-bridge 的 clock／memory_state 命令与运行器
// drive／compare／holdout／--repair-of 编排（test/sim/desk-pet-chat/workflow.mjs）；
// src/services/init.ts 在 sim-eval 引导早期安装 Node 域固定时钟（Rust 调度与 OS 时间戳不推进）。
// 新增 eval-10（工作流／授权／同条件对照）、eval-11（判分包／独立 judge／可选抽查）与
// eval-12（fake Provider 配合真实 loop 的闭环）；验收中发现授权凭据字段被形状校验抢先归类为
// schema.invalid，已改为先查凭据再校验形状。CE-01..20 映射与集中验收记录见执行契约 W6；
// 当前完成度与剩余项只看 docs/plans/active/未完成工作与已知缺口.md §12。
// 2026-10-26 gold 审批写入（本批刷新）：dataset.mjs 新增 writeApprovalRecords（先校验目标套件、
// 用例归属与目标文件再由 wx 写入，拒绝覆盖已有审批），desk-pet-chat.mjs 新增 dataset approve
// 子命令（只接受用户给出的真实会话来源，写后回读标签）。评测计分、导出、判分与保留路径未改，
// eval-01..12 未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-27 CE-08 手工触发（本批刷新）：新增 src/services/sim/manual-trigger.ts，把主动 tick 与
// 任务投递封装为组件入口（manualPath=sim-component），dataset 白名单登记 sim_proactive_tick／
// sim_task_deliver；chat-bridge 的 host 命令按注册表走手工入口，trace-context-map 支持按 sessionId
// 显式绑定，使 proactive 事件不再成为 orphan；sim-eval-run 对手工方法使用消息级超时，report 在
// 驱动包含手工触发时注明组件路径。eval-04 补会话绑定场景，eval-10 补手工触发场景，eval-11 补报告
// 说明场景；真实手工触发链路尚未在隔离宿主执行，验收状态只记 L2。sourceHash 按当前源码复算。
// 2026-10-27 多 trial 批量与 pass^k（本批刷新）：evidence.mjs 新增 trials.json 冻结计划
// （planTrialBatch 计划总数含已有 attempt，运行前冻结 trialIds，失败或不完整试次继续占位不替换），
// 并在建 attempt 时拒绝计划外 trialId 与重放；sim-eval-run 新增 batch 串行编排（子运行 id 由
// evaluationRunId 确定性派生、batch.json 记录槽位、drive 失败按中断封存后继续），start 时校验
// 计划绑定；新增 aggregate.mjs 按计划槽位聚合（critical pass^k、非 critical 只展示分布，
// 缺 trial／证据不完整／未判分／judge 身份不一致／无证据引用都保持 inconclusive）；report 先给
// 聚合矩阵再逐 attempt 展开。eval-10 补计划冻结、批量入口与多 trial 报告场景。sourceHash 按当前源码复算。
// 2026-10-27 W2 关停证据与故障救援（本批刷新）：宿主退出序列在 flush 之后写 run 根 exit.json
// （pid、exitedAt、Node flush 真实结果、interrupted／forcedKill），原子替换、无临时残片；
// sim-eval-run 的 stop 校验 exit.json 绑定本次宿主并核对 flush／强杀／中断，缺失或不干净都报问题，
// finish 把关停问题写进摘要与退出码；宿主没走完退出序列时新增 rescue：宿主仍活着拒绝，只把
// manifest.json.pending 按 interrupted 封存（缺对话、缺 trace 封口、缺 exit.json 进 issues，
// 结果保持 inconclusive），sealedAt 落盘后 repair 可继续。harness flushForShutdown 增加 sim 采集
// 关停（未走 finish 的 trace 先按中断封口）与调度器有界停止结果（未收敛作业进 flush detail）；
// eval-10 补 exit 记录／关停核对／救援与救援守卫场景，sourceFiles 增列 src/harness/main.ts。
// sourceHash 按当前源码复算。
// 2026-10-27 聊天交付基础设施（本批刷新）：dataset.mjs 新增 case deliverables（id／role／数据根内
// 相对路径／可选 maxBytes，需 tools 能力）、precondition.toolApproval=allow-once、artifact 窗口与
// delivery.artifact-exists／delivery.artifact-content rubric，消息步骤只允许 {{dataRoot}} 占位符；
// evidence.mjs 封存时把声明产物复制为只读证据并逐项记 delivered／missing／oversized／invalid
// （符号链接与越界路径拒绝采集，异常不改证据完整性）；workflow.mjs 发送前渲染占位符、allow-once
// 在消息在飞期间单槽确认一次并把确认记录写进进度（schema 2）；sim-eval-run 接线占位符、自动确认
// 与产物捕获；judging.mjs 判分包升为 schema 2（chat-judge@4），携带产物封存状态与受限内容
// （单文件 4 KiB、整包 16 KiB，超限截断、二进制／哈希不符／预算耗尽只留原因），新增
// deliverable:<id> 证据引用；report 在产物窗口按封存产物取证并列出交付状态。eval-10／eval-11
// 补声明、捕获、确认、判分包内容与报告场景。sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

// 2026-10-10 记忆断点修复定向核对：本域既有消费者与分派语义未变；新增受控会话读取及请求内guide由memory契约持有，生成协议仅增命令/规范排版。
export const evaluationContract: ModuleContract = {
  module: "evaluation",
  sourceFiles: ["test/sim/desk-pet-chat/external/parquet.mjs", "test/sim/desk-pet-chat/external/index.mjs", "test/sim/desk-pet-chat/external/batch-one.mjs", "test/sim/desk-pet-chat/external/batch-two.mjs", "test/sim/desk-pet-chat/external/prepare.mjs", "test/sim/desk-pet-chat/external/catalog.json", "test/host/standard-setup.ts", "vite.config.ts", "src/services/engine/runtime/trace.ts", "src/services/agent/memory/reading-errors.ts", "src/services/agent/memory/provider.ts", "src/services/agent/memory/dreaming.ts", "crates/native-host/src/e2e_trace.rs", "crates/native-host/src/memory/benchmark.rs", "crates/native-host/src/memory/store.rs", "crates/native-host/src/paths/mod.rs", "crates/native-host/src/host/dispatch.rs", "test/host/trace-observer.ts", "src/services/sim/trace-chunk.ts", "src/services/sim/trace-recorder.ts", "src/services/sim/capture.ts", "scripts/report-retention.mjs", "scripts/trace-evidence.mjs", "scripts/contract-layers.mjs", "scripts/e2e-test.mjs", "scripts/check-contract-hashes.mjs", "test/memory-quality/dataset.mjs", "test/memory-quality/index.mjs", "test/memory-quality/live-adapter.ts", "scripts/memory-quality-review.mjs", "scripts/memory-performance.mjs", "src/services/sim/eval-models.ts", "src/services/sim/eval-overrides.ts", "src/services/sim/run-context.ts", "src/services/sim/clock.ts", "src/services/sim/chat-bridge.ts", "src/services/sim/manual-trigger.ts", "src/services/sim/message-operation.ts", "src/services/sim/direct-seed-plan.ts", "src/services/sim/direct-seed.ts", "src/services/init.ts", "src/harness/main.ts", "crates/native-host/src/paths/sim_eval.rs", "crates/native-host/src/main.rs", "scripts/sim-eval-run.mjs", "scripts/desk-pet-chat.mjs", "test/sim/desk-pet-chat/dataset.mjs", "test/sim/desk-pet-chat/evidence.mjs", "test/sim/desk-pet-chat/aggregate.mjs", "test/sim/desk-pet-chat/judging.mjs", "test/sim/desk-pet-chat/report.mjs", "test/sim/desk-pet-chat/workflow.mjs", "test/sim/desk-pet-chat/categories.json", "test/sim/desk-pet-chat/question-types.json", "test/eval-models.json", "test/e2e/memory-performance.ts", "test/host/performance.ts", "test/e2e/native-main.ts", "test/e2e/scene-runner.ts", "test/sim/desk-pet-chat/external/assets.mjs", "test/sim/desk-pet-chat/external/beam-install.mjs", "test/sim/desk-pet-chat/external/connect.mjs", "test/sim/desk-pet-chat/external/environment-turn.mjs", "test/sim/desk-pet-chat/external/gaia-download.py", "test/sim/desk-pet-chat/external/gaia-install.mjs", "test/sim/desk-pet-chat/external/install.mjs", "test/sim/desk-pet-chat/external/lhtb.mjs", "test/sim/desk-pet-chat/external/lhtb_harbor_agent.py", "test/sim/desk-pet-chat/external/lhtb_image.py", "test/sim/desk-pet-chat/external/lhtb_install.py", "test/sim/desk-pet-chat/external/lhtb_mcp_server.py", "test/sim/desk-pet-chat/external/lhtb_run.py", "test/sim/desk-pet-chat/external/memoryarena-connect.mjs", "test/sim/desk-pet-chat/external/memoryarena.mjs", "test/sim/desk-pet-chat/external/memoryarena_bridge.py", "test/sim/desk-pet-chat/external/memoryarena-environment-lock.json", "test/sim/desk-pet-chat/external/memoryarena_lifecycle.py", "test/sim/desk-pet-chat/external/native-smoke.mjs"],
  // 2026-10-27 交付基础设施批次：评测口径随数据集、封存、驱动与判分包同步更新；按当前源码复算。
  // 2026-10-28 外部评测安装/连接批次：五数据集装全、安装验收按完整文件集与收据收敛、
  // MemoryArena 五 config 环境门禁、LHTB 忽略运行期字节码缓存与 run-id 相位预算；sourceHash 按当前源码复算。
  // 2026-10-28 MultiChallenge 试跑阻塞修复：外部静态用例把目标回合排在固定时钟之后（模拟时钟只前进
  // 不回退，步骤时间起步即过期会让驱动在第一个步骤阻塞），驱动时钟守卫补出「步骤时间已过去」的原因；
  // sourceHash 按当前源码复算。
  sourceHash: "b006ccb949fdada95669290026254e1dbaf0e45521950d488040aba901c68d76",
  coverage: [
    {"id": "eval-13", "feature": "公开通用评测的来源、适配与隔离导入", "description": "GAIA 仅接有答案的授权本地 dev/validation 文本题，MultiChallenge 保留此前角色并只执行最后用户请求（判分问题留在 oracle），BEAM 保留完整固定历史与上游参考判据；MemoryArena travel 和 LHTB 的环境依赖不拆平，缺实际环境/附件/verifier 时显式阻塞。固定 commit、本地输入哈希、上游身份与适配口径随 source 绑定，生成目录默认保存在适配器 .data/<dataset>/dataset，显式测试临时输出仍限 test/.tmp/external-eval；下载默认保存在 .data/<dataset>/raw，已有缓存校验固定 SHA/来源收据后复用且不联网，损坏或来源不符拒绝覆盖；生成套件拒绝覆盖/符号链接，导入保持银标。参考答案不能进入 driver，判分包单列预置历史 fixtureContext 与允许引用，数据漂移拒绝按旧证据判分。安装验收按完整文件集与收据收敛判定，不再只信自报清单；缓存与收据只读复用，冲突拒绝覆盖。MemoryArena 五个 config 共用统一运行入口，run 前按 verify 的 per-config 环境就绪度拒绝未满足项，bundled_shopping 走 run-owned 回环预热。LHTB 源码校验忽略 Harbor 运行期派生的字节码缓存，入口 run-id 限 3–39 字符为相位后缀留位。", "why": "公开集接入必须保留题意、角色、判据与依赖，防止把裁判问题当用户请求、把元数据当可执行任务或把预置历史当实际产出", "layer": "unit", "depth": "deep", "scenarios": ["external-parquet-read-bounded-prefix", "external-parquet-preflight-bounds", "external-parquet-local-only", "external-download-pinned-hash", "external-download-source-gate", "external-download-integrity-gate", "external-download-redirect-gate", "external-download-trusted-redirect", "external-import-fixed-history", "external-import-clock-slack", "external-import-provenance-pin", "external-import-registered-vocabulary", "external-import-duplicate-output", "external-import-scratch-boundary", "external-import-runner-persistence", "external-import-readiness-gate", "external-import-oracle-binding", "external-import-judge-packet", "external-batch-two-beam-roles-oracle", "external-batch-two-beam-role-validation", "external-batch-two-lhtb-task-contract", "external-batch-two-lhtb-verifier-gate", "external-batch-two-catalog-pinning", "external-batch-two-prepare-local-provenance", "external-batch-two-prepare-expanded-limit", "external-batch-one-gaia-local-only", "external-batch-one-gaia-gated-split", "external-batch-one-multichallenge-history", "external-batch-one-memoryarena-dependencies", "external-batch-one-memoryarena-shape", "external-download-persistent-default", "external-download-cache-integrity", "external-download-cache-provenance", "external-import-persistent-default", "beam-10m-malformed-plan", "beam-10m-numeric-plan-order", "beam-install-multichallenge-pin", "beam-install-pinned-full-manifest", "beam-install-python-literal", "beam-install-response-byte-bound", "beam-install-resume-range", "beam-install-stream-integrity", "beam-install-stream-one-row-at-a-time", "beam-install-stream-symlink-boundary", "environment-case-ordered-oracle-isolation", "environment-mcp-timeout-isolated-config", "external-assets-pin-stage-and-path-guard", "external-cli-verify-exit-status", "external-connect-case-fixture-consistency", "external-connect-complete-file-set", "external-connect-mc266-shared-fixture", "external-connect-path-and-symlink-guard", "external-connect-receipt-and-approval-protection", "external-connect-selected-case-skips-other-fixture", "external-connect-source-verification-gate", "external-connect-suite-manifest-consistency", "external-inspect-all-requires-every-install", "external-inspect-error-incomplete", "external-inspect-lhtb-ready-field", "external-inspect-memoryarena-verified-field", "external-inspect-static-verification", "external-lhtb-agent-cancel-kill-bound", "external-lhtb-agent-cancel-reaps-child", "external-lhtb-broker-disconnect-byte-bounds", "external-lhtb-dockerfile-image-is-on-demand", "external-lhtb-exception-exit-zero", "external-lhtb-interrupted-install-reuse", "external-lhtb-invalid-verifier", "external-lhtb-job-retention-poll-bounds", "external-lhtb-list-separates-task-families", "external-lhtb-malformed-result", "external-lhtb-missing-result", "external-lhtb-plan-checks-exact-local-image", "external-lhtb-plan-requires-explicit-bounded-work", "external-lhtb-plan-requires-official-verifier", "external-lhtb-receipt-cannot-prove-install", "external-lhtb-run-id-phase-budget", "external-lhtb-runner-identity-verification", "external-lhtb-valid-zero-reward", "external-lhtb-windows-unsupported", "external-lhtb-wrong-task-identity", "external-lhtb-wrong-trial-identity", "external-memoryarena-hash-reuse", "external-memoryarena-index-receipt-binding", "external-memoryarena-jdk-resolution", "external-memoryarena-lock-recovery", "external-memoryarena-lock-tamper", "external-memoryarena-process-bounds", "external-memoryarena-readiness-per-config", "external-memoryarena-readiness-readonly", "external-memoryarena-run-config-gate", "external-memoryarena-sandbox-owned-cleanup", "external-memoryarena-shopping-loopback-adapter", "external-memoryarena-shopping-node-wrapper", "external-memoryarena-shopping-owned-service-lifetime", "external-memoryarena-shopping-prewarm-order", "external-memoryarena-shopping-reset-finally", "external-memoryarena-shopping-signal-cleanup", "external-memoryarena-source-archive-tamper", "external-runtime-environment-step-binding", "external-runtime-initial-environment-gate", "external-runtime-literal-braces", "external-runtime-run-id-boundary", "external-runtime-unknown-placeholder", "gaia-install-hidden-test-gate", "gaia-install-pinned-source", "gaia-install-readiness-gate", "public-install-cache-readonly", "public-install-cache-receipt-conflict", "public-install-cache-receipt-convergence", "public-install-cache-repair-requires-integrity", "public-install-download-receipt-convergence", "public-install-receipt-atomic-failure", "public-install-receipt-temp-symlink-boundary", "public-install-sidecar-regular-files", "public-install-sidecar-symlink-boundary", "public-install-verify-canonical-paths", "public-install-verify-content-tampering", "public-install-verify-full-set-not-self-reported", "public-install-verify-manifest-pins", "public-install-verify-missing-shards", "public-install-verify-not-installed", "public-install-verify-readonly-cache", "public-install-verify-regular-files", "public-install-verify-source-receipts", "public-install-verify-symlink-boundary"]},
    {"id": "eval-14", "feature": "LHTB 隔离终端 MCP 桥接", "description": "终端工具经隔离 broker 提供 MCP 会话：初始化声明 desk-pet-lhtb-terminal 且只注册 terminal_exec／terminal_poll／terminal_cancel，未注册工具拒绝；命令以独立 job 立即返回，poll 保留结果与令牌边界；超过 64 KiB 的 ASCII 与 UTF-8 输出完整透传，超界 broker 帧显式失败而非断线假成功；poll 等待期间不阻塞 ping 通知，取消请求只断开对应 broker 并终止自有 job；显式 cancel 与 stdin 关闭都清理自有 job 连接。用例只替换 OS 传输原语，字节上限、broker 调用与 MCP 循环保持真实，不启动 Harbor 容器。", "why": "隔离工具通道必须证明 sandbox 执行只经 broker、失败可见且不残留连接，防止把断线或超界响应演成执行成功", "layer": "integration", "depth": "deep", "scenarios": ["external-lhtb-mcp-broker-roundtrip", "external-lhtb-mcp-seventy-kib", "external-lhtb-mcp-utf-eight", "external-lhtb-mcp-reject-oversize", "external-lhtb-mcp-async-poll-cancel", "external-lhtb-mcp-session-cleanup"]},
    {"id": "eval-01", "feature": "生产 trace 提交线路", "description": "真实 sendMessage 经过 Rust IPC：输入、host/Pi关联、Provider span、首文本生成与 JSONL assistant entry commit 一致；消息结束不冒充提交或UI首显", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "e2e", "depth": "deep", "scenarios": ["trace-production-commit"]},
    {"id": "eval-02", "feature": "惰性与隔离观测", "description": "无订阅者不计算payload；listener异常隔离、event冻结、spread context共享单调序号；阅读状态/合法来源ID及固定错误计数（含缺失/非法语义核对表）可见，核对条件只登记有界哈希、状态与引用数，核对条件正文/引文/查询和任意错误键被过滤；正文与工具参数结果不进入允许字段，主动/行为事件只保留结构字段（应用身份、标题与任务正文被白名单挡下）", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-lazy-off", "trace-listener-isolation", "trace-sequence-redaction", "trace-preview", "trace-scope-candidates", "trace-memory-rendered-schema", "trace-memory-reading-schema", "trace-proactive-behavior-schema"]},
    {"id": "eval-03", "feature": "提交与记忆准入证据", "description": "真实 loop 和 JSONL 条目支持 commit 身份；注入自定义MemoryProvider，在真正Provider请求内核对预算淘汰结果和 rendered sourceIds", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "integration", "depth": "deep", "scenarios": ["trace-entry-commit", "trace-memory-rendered"]},
    {"id": "eval-04", "feature": "来源与有界缓冲", "description": "迟到事件保持最初trial归属；未知任务为orphan；有界映射淘汰；显式会话绑定让无runId／requestId的事件按sessionId归到当前trial，未绑定会话仍为orphan；缓冲数/字节上限、序号缺口、drop及待ACK精确重试可见；单块字节预算切分（前缀出块、剩余留存、单条超预算独占一块、drop随批首块带走并清零）", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-context-origin", "trace-bounded-ack", "trace-context-bound", "trace-context-session", "trace-chunk-byte-split", "trace-chunk-oversize-event", "trace-chunk-empty-boundary", "trace-chunk-drop-carry"]},
    {"id": "eval-05", "feature": "用户理想与独立审阅门禁", "description": "用户任意文本理想稿不自动生成；缺审阅pending；哈希、完整性、边界、全部trial及orphan引用核验；失配/drop/半行/完整终态后追加不能通过；静默trial可用真实边界引用", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-review-pending", "trace-review-stale", "trace-review-hash-bound"]},
    {"id": "eval-06", "feature": "成组证据保留", "description": "保留单元是组：同一场的 json/html 与审阅/评分卫星连带（字节计入、孤儿卫星清除）、trace bundle 含 .pending 残片整组淘汰、performance 池同口径；最近3场且总200MiB且最新一组恒留；caseid/flaky产物保留", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-bundle-retention", "report-retention-group-key", "report-retention-newest-three", "report-retention-newest-kept-over-budget", "report-retention-satellite-share-fate", "report-retention-json-html-pair", "report-retention-scored-satellite-pair", "report-retention-unmanaged-kept", "report-retention-orphan-sweep"]},
    {"id": "eval-07", "feature": "质量评测集与指标", "description": "80题5capability和来源/scope/时间标注验证；无记忆的候选指标不可冒充0；未独立评分的answer/extraction为未知；配对成本与按case聚合的收益区间", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["mq-dataset-80-balanced", "mq-dataset-required-gold", "mq-score-no-memory-null"]},
    {"id": "eval-08", "feature": "质量配对与审阅约束", "description": "三trial五策略+独立提取；cell矩阵完整、fresh generation与fixture指纹守卫；提交失败/中断失败；模型输出失败保留且不终止其他对照，三次连续基础设施失败中止；gold双人审计、独立校准judge盲审绑定整份采集，缺/旧审阅及定向样本不能批准完整质量", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["mq-runner-paired-gate", "mq-model-output-failure", "mq-review-bound-gate"]},
    {"id": "eval-09", "feature": "性能统计", "description": "nearest-rank P95保留长尾；缺样本或非法耗时为null；release 存储与 debug IPC 两类证据范围不混算（真实 UI 渲染延迟不在本口径内：Live 宿主没有聊天窗，不冒充 UI 证据）", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["performance-tail", "performance-missing"]},
    {"id": "eval-10", "feature": "聊天评测授权、驱动与同条件对照", "description": "授权文件校验用例范围、用途、隔离数据、模型与预算（trials>0、repairs≥0），留出布尔必须等于用途，拒绝重复项与任何凭据字段；请求模型必须在授权范围内，修复序号从 1 开始且不超过授权次数。固定时钟按整小时偏移生成 Etc/GMT∓N，clock.json 的时区与基准偏移一致；驱动包只含 userRole 与 driver 步骤，检查点只接受登记等待类型。驱动进度可往返读取，已完成、已阻塞与有 in-flight 的进度拒绝续跑；按步骤推进时钟、建会话、发消息并等待检查点，消息／分钟／已知 token 预算在下一步副作用前到界阻塞，未知用量记 unknown 不记零。每条消息步骤生成唯一 operationId 并携带 caseId／stepId；评测宿主要在 trial 已开始、会话与宿主代际一致且同一身份不重放时才接收消息，回执必须原样回显 operation（含 trialId／sessionId／generation）且 requestId 与 operationId 同源，错组或缺身份直接阻塞、不把回复记到本步；忙碌投递的回复按 requestId 在会话 run 分支内取证，不回退到最后一条助手消息。`memory_extraction_end` 在消息副作用前抓作业基线，只认基线之外的新抽取作业到达终态（completed／failed／cancelled）且 pendingSources／activeJobs 归零稳定，空闲水位不算结束。驱动完成才判 completed，其余显式 interrupted；同条件比较核对固定字段与目标漂移，留出使用记录包含在途与待审。手工触发只接受 sim_proactive_tick／sim_task_deliver：主动 tick 只收取本次调用产生的 proactive 事件，任务投递要求创建与交付完成；回执必须带 manualPath=sim-component，缺路径标记或交付未完成直接阻塞。多 trial 计划在运行前冻结 trialIds、预算与授权指纹，计划总数含已有 attempt；起步时拒绝计划外 trialId 与重放，失败或不完整的试次继续占位、不被替换；batch 串行编排子运行（子运行 id 由评价组确定性派生），drive 失败按中断封存后继续，其余槽位保持未封存占位，不自动判分。宿主退出后在运行根留下 exit.json（pid、Node flush 真实结果、中断／强杀）；stop 只认绑定本次宿主且 flush 完成、非强杀非中断的记录，缺失或不干净都报问题并计入 finish 摘要与退出码；宿主没走完退出序列时 rescue 只把已落盘的草稿按 interrupted 封存（宿主仍活着或 attempt 已封存都拒绝），缺对话、缺 trace 封口、缺 exit.json 写进 issues，结果保持 inconclusive，不冒充完成。交付类用例的声明只含 id／role／数据根内相对路径与可选字节上限，需 tools 能力；artifact 窗口只接受交付 rubric，exists 不带词表、content 至少给包含或不包含之一，交付路径不进入驱动包也不改变 driverHash。`{{dataRoot}}` 是唯一消息占位符，驱动包保留原样、发送时渲染。声明 allow-once 时驱动在消息在飞期间轮询单槽确认并只允许一次，确认记录随进度持久化，未声明时不轮询确认通道。封存在数据根内按声明复制产物为只读证据并记录 delivered／missing／oversized／invalid，符号链接与越界路径拒绝采集；逐项异常不改变证据完整性，由交付规则判失败。新运行的合成 CONFIG 默认关闭拟人化（分泡会改写句数与长度观感），需要测拟人化链路时显式打开；修复 attempt 沿用原运行开关，不能单方面改变对照条件。", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["chat-run-authorization", "chat-driver-progress-resume", "chat-driver-steps", "chat-driver-clock-monotonic", "chat-driver-operation", "chat-driver-budget", "chat-driver-memory-baseline", "chat-driver-memory-new-job", "chat-driver-memory-cancelled", "chat-driver-manual-triggers", "chat-manual-trigger", "chat-manual-trigger-task", "chat-manual-trigger-registry", "chat-run-conditions", "chat-run-humanizer-default", "chat-run-holdout", "chat-trial-plan", "chat-trial-plan-ids", "chat-trial-plan-frozen", "chat-trial-plan-tamper", "chat-trial-plan-evidence", "chat-batch-command", "chat-run-exit-record", "chat-run-exit-flush", "chat-run-rescue", "chat-run-rescue-guard", "chat-deliverables-schema", "chat-deliverables-binding", "chat-deliverables-validation", "chat-deliverables-window", "chat-tool-approval", "chat-driver-placeholder", "chat-deliverables-format", "chat-deliverables-capture", "chat-deliverables-missing", "chat-deliverables-symlink", "chat-deliverables-none", "chat-driver-render", "chat-driver-confirm", "chat-driver-confirm-skip", "chat-confirm-progress"]},
    {"id": "eval-11", "feature": "聊天判分包、独立 judge 裁决与可选抽查", "description": "判分包只在证据完整、执行完成、数据集绑定未漂移且驱动无 oracle 泄漏时冻结，规则覆盖全部探针，只引用允许的证据，不携带标签或历史判分；未封存、trace 不完整、执行失败或驱动泄露评测内部信息都拒绝。裁决必须覆盖全部规则且无重复未知项，judge 平台／模型／prompt 版本完整并与被测模型异构，证据引用不得越界；judge.platform 只接受 coding-agent 执行平台白名单（claude-code／codex／qoder），API 客户端回填直接拒绝；历史判分即使 authority 字段写着 coding-agent-judge，平台不在白名单时也不算权威，报告身份句按判分记录生成。判分记录绑定 packet 哈希与规则计数，任一 fail 判失败、存在非 pass 保持 inconclusive、无记录不产生通过。用户抽查只接受真实用户与当前 grade，追加 reviews；一致或不一致都不改变自动判分、不进入聚合。抽查只统计绑定最新判分的记录：重新判分后旧抽查仍是历史证据，但不进入新判分的覆盖与一致性统计。四层报告从同一证据重建结论，证据不完整、未封存或数据集漂移不显示通过；驱动包含手工触发时报告注明组件入口，不冒充自然受理、调度或实际 UI 显示。多 trial 聚合按冻结计划对齐槽位：critical 规则须全部 trial 通过（pass^k），任一 fail 即 fail；缺 trial、证据不完整、执行未完成、未判分、judge 身份不一致或 pass/fail 无证据引用都保持 inconclusive；非 critical 规则只展示分布，不参与总判定；修复 attempt 不占计划名额。判分包按声明的交付产物携带封存状态与受限内容：单文件与整包各有字节预算，超限截断、二进制、哈希不符或预算耗尽只保留原因；缺失或无效状态照实呈现，产物规则以包内状态与内容为准，deliverable:<id> 是可引用的证据（引用摘录记录状态与内容），缺失产物仍可冻结判分包并由裁决判失败。", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["chat-judge-packet-freeze", "chat-judge-verdict-validation", "chat-judge-authority", "chat-judge-authority-history", "chat-judge-aggregation", "chat-spotcheck-nonblocking", "chat-spotcheck-regrade", "chat-report-same-source", "chat-report-manual-trigger", "chat-trial-aggregate", "chat-report-multi-trial", "chat-judge-deliverable-content", "chat-judge-deliverable-bounds", "chat-judge-deliverable-missing", "chat-report-deliverables"]},
    {"id": "eval-12", "feature": "聊天评测闭环组合流程", "description": "fake Provider 配合真实 initChat／sendMessage／会话 JSONL 与 trace 采集跑通一次闭环：固定时钟只推进 Node 域时间，两轮消息经真实 loop 落盘；驱动在消息步骤后崩溃，从同一进度续跑且不重放已完成步骤；host 新建会话后跨会话采集把驱动与 fixture 来源分开，对话、状态与产物写入 attempt 并通过封存核验；数据集漂移拒绝冻结判分包，驱动文本不泄露 oracle 后冻结判分包；未判分时汇总为 inconclusive、标签保持 silver/pending、抽查显式未抽查，报告从同一证据生成且不产生 grades。Rust 调度与 OS 时间戳不随固定时钟推进。", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "integration", "depth": "deep", "scenarios": ["w5-loop-smoke"]},
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: false },
}
