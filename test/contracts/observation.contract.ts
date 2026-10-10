// 2026-10-10 整理水位推进修复（本批刷新）：sourceFiles 中 host/dispatch.rs（memory_job_checkpoint 分派臂加可选 coveredSourceIds）与 agent/memory/ipc.ts（按批内已处理来源传参）变化；观察、画像与 presence 路径不受影响，ob-01..07 逐点复核未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-09 验收补充：顶栏 typing 所有权泄漏修复波及本契约 sourceFiles（runner/runtime/titlebar 的 defer 判据收口与旧代际清扫），逐点复核与本院行为面不相交，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-09 最终静态复核：稳定artifact与输入证据分离、去重和话题立场透传已复核，覆盖声明同步；验收已执行（L2/L3 与 Rust 单测全绿），sourceHash 按当前源码在验收轮刷新。
// 2026-10-05 设置页 Card 增删改查 + 模版批次：本契约 sourceFiles 中三处变化，均为新增 ——
// `src/services/native-ui/host-requests.ts` 加四条 Card 请求臂、`ui/settings/schema.rs`
// 的 AI 页「人格」节加 7 个 action.card* 动作字段（silentAccess 字段与既有动作未动）、
// `host/dispatch.rs` 加 `personality_file_delete` 分派臂；sourceFiles 里
// `src/services/config.ts` 的累积改动经核对，增删行未出现 silentAccess / observation /
// proactive 相关键。ob-01..ob-07 逐点复核行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— runtime.ts（RUNTIME_DATA 协议缺失
// 检测与提醒接线）、config.ts + ui/settings/schema.rs（设置面的当批改动；经核对 current
// 源码里 silentAccess 与观察/主动读取键、ob-* 相关字段未受影响）、
// crates/native-host/src/commands/mod.rs（仅命令域头注释里的设计契约路径改指 history 归档，
// observation_cmd / monitor_ctl 模块声明未动）。ob-01..ob-07 逐点核对实现点仍在、语义未变，
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// 观察调度、静默了解与主动读取链路不在改动面内）。ob-01..ob-07 逐点核对实现点仍在、覆盖
// 描述与当前实现一致。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与当前实现
// 一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志）与 runtime/types.ts（新增 CompactionDeclineRecord
// / CompactionTrigger / CompactionDeclineKind / CompactionOverflowDetail，压缩审计槽专属类型，
// 观察域的 snapshot / types 消费点不受影响）。ob-01..ob-07 逐点核对实现点仍在、覆盖描述与
// 当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 复算补充（同一刷新轮）：复算时并发落进一处本批改动单之外的 context/budget.ts
// 变化（keepRecentTokens 上限改为随窗口长大；并发写入，不在本批改动单内）。按当前源码复算，
// sourceHash 一并覆盖它；ob-01..ob-07 无覆盖点描述 keepRecentTokens，逐点核对不受影响。
// 2026-10-05 频率档位 W1（本批只做描述订正与登记，未跑 analyze→generate）：sourceFiles 变化 ——
// scheduler.ts（screenState=locked 的批次资格、锁定批跳过截图、决策提示改用最后一次窗口快照）、
// decide.ts（删除单批 ≤3 目标截断与提示词）、config.ts（删除 MAX_READ_TARGETS_PER_BATCH）、
// observation_cmd.rs / monitor/*（Rust 终裁与 screen_state 改名，锁屏可用）。ob-04 的 ≤3 口径
// 已按 Node 现状订正；ob-03 的 Rust 上限描述与全表 sourceHash 留待收口波统一 analyze→generate。
// 2026-10-05 频率档位 W4-B（本批只做描述订正与登记，未跑 analyze→generate）：sourceFiles 变化 ——
// scheduler.ts（决策输入补齐：本地时间 / Card 人设有界摘要 / 行为画像快照 / 话题权重 top-5 /
// 长期记忆核心画像，均只读、有界、运行时绑定；召回关闭重排，不新增模型调用）、decide.ts
// （新增 DECISION_MEMORY_TOKEN_BUDGET、boundedCardBrief、localTimeBrief 与提示词参考资料口径）。
// ob-04 描述补「决策输入」一句并登记三个新 caseId（由 test/integration/observation/
// 决策输入补齐.test.ts 与 test/unit/observation/决策解析与读取名额.test.ts 携带）；
// sourceHash 与其余逐点复核留待收口波统一 analyze→generate。
// 2026-10-05 频率档位收口波（analyze→generate）：ob-03 的 Rust 读取上限描述订正 —— W1 已删
// 大小/条目数值上限、保留路径边界（绝对路径 / canonical 解析 / home 内 / 数据根外 / 非凭据 /
// 非 home 系统目录），目录全量列名、文件整读。ob-04 拆点：决策输入三 caseId（observation-
// decision-inputs / -degrade / -memory-identity）载体是 L3（决策输入补齐.test.ts），归新增
// ob-08（integration）；上一段的「由…与决策解析与读取名额.test.ts 携带」据此更正 —— 该 L2
// 文件实际只携带 parse / read-quota / card-brief / local-time 四个。新增 ob-09（integration）
// 登记 静默了解档位参数消费.test.ts 的 4 个 caseId。ob-01..ob-07 其余点按当前源码复核未变；
// sourceHash 按当前源码复算。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— crates/native-host/Cargo.toml 与
// Cargo.lock（image 依赖新增 tiff feature：只为剪贴板粘贴转码开，聊天准入白名单（sniff）不变、
// 截图/观察链路不受影响；注释同步改写）、crates/native-host/src/host/dispatch.rs 新增一条
// chat_delete_session_images 分派臂（命令矩阵 134→135）。ob-01..ob-09 逐点核对实现点仍在、
// 覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（子运行 provider 准入转发与 invisible sinks；观察
// 决策、静默了解与话题链路未动）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现一致，
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/context/budget.ts（新增 totalInputTokens）、
// src/services/engine/harness/{runtime,model-gateway}.ts（偏差对账口径；观察决策与静默了解
// 链路未动）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-06 回合治理与图片生命周期批次（analyze→刷新）：sourceFiles 变化 ——
// observation/scheduler.ts（isAIGenerating 改从 engine/harness 取：AI 生成锁真相源随
// `src/services/cooldown.ts` 删除移居 harness 的回合受理状态，调度门禁语义不变）、
// config.ts（ai.lock 配置整节删除，调度器不读该键）、engine/harness/index.ts（barrel 透出
// isAIGenerating 与 HarnessTurnAdmission；ob-07 负向断言的四个缺席名复核仍无命中）、
// engine/harness/runtime.ts、agent/runner.ts 与 proactive/store.rs（受理计数落点与冷却快照；
// 观察决策、静默了解与话题链路未动）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现
// 一致（ob-09 的档位门禁与 ob-04 的读取名额/决策解析未受本批影响），未修订覆盖点，仅按当前
// 源码刷新 sourceHash。
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// src/services/agent/memory/ipc.ts（reserveMemoryDreamingBudget 去 dailyLimit、返回 void）与
// crates/native-host/src/host/dispatch.rs（对应分派臂同步）：dreaming 日 token 上限不再作门禁，
// 预留只记账。本契约覆盖点不在改动面内，未修订；本批刷新同时包含工作树中其它并发改动的
// 源文件（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 第二轮实测反馈批次（本批验收 analyze→generate）：sourceFiles 行为面变化 ——
// config.ts（回合墙钟 120s→600s、计划步骤 90s→300s：观察/静默了解链不读这两个键）、
// agent/memory/ipc.ts（dreaming 预留在命令层只记账：去 dailyLimit、返回 void）、
// proactive/store.rs 与 commands.rs（claim 与辅助预留撤 token 总量闸：辅助侧仍按请求
// dailyLimit 与档位天花板收紧次数，ob-09 的档位参数预留语义未变）、host/dispatch.rs（对应
// 分派臂同步）、ui/settings/schema.rs（dreaming 档位 help 文案去 token 预算措辞，非行为面）、
// engine/harness/index.ts（新增 readLastConversationPromptTokens 导出；ob-07 的负向缺席名
// 复核仍无命中）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，
// sourceHash 按当前工作区源码复算（同时含并行工作线在非本契约文件上的改动）。
// 2026-10-06 提问选择与去超时批次（本批刷新）：sourceFiles 变化仅限
// `src/services/engine/harness/runtime.ts` 的注释面（NON_CONFIRM_CONTEXT 去掉确认超时一支）。
// 各覆盖点逐条核对实现点仍在、描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 派生行为结论沉淀批次（本批刷新）：sourceFiles 变化 —— memory/ipc.ts（两个记忆
// 命令的可选 origin 参数与 MemoryOrigin 类型导出；派生来源的登记与整理按类别分池）与
// proactive/store.rs（清画像事务追加派生记忆失效）。了解层与话题链的读取、写入、降级与清除
// 水位语义未动；各覆盖点逐条核对实现点仍在、描述与当前实现一致；sourceHash 按当前源码复算
//（同批含另会话在飞改动）。
// 2026-10-06 记忆面板来源标签批次（本批刷新）：sourceFiles 变化仅限
// src/services/agent/memory/index.ts —— 导出面 barrel 转出 DERIVED_PROVENANCE_MARK（原生 UI
// 记忆面板复用召回投影的同一枚呈现标记，不新增跨窗口协调入口）。ob-07 的负向缺席名
// （initMemoryRevisionSync / requestProactiveControl / initObservationGovernance /
// stopObservationGovernance / initWindowListener）复核仍无命中（对应测试文件已实跑绿）；
// 其余 ob-* 逐点核对实现点仍在、描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 设置页列表面板删除批次（本批刷新）：sourceFiles 变化仅限
// `crates/native-host/src/ui/settings/schema.rs` 的注释面（Profile 资源管理 / 人格（Card）管理面
// 文档注释按当前实现改写：管理动作作用于当前激活项，设置页行级列表面板已删除；字段与文案未动）。
// ob-01..ob-09 逐点核对实现点仍在、描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 Card 按需加载批次（本批刷新）：sourceFiles 变化仅限
// `src/services/native-ui/host-requests.ts`（personality_cards 列表改现读 Card 目录；
// 观察链不消费该请求，静默了解读激活卡的路径不变 —— 激活卡仍常驻）。ob-01..ob-09 逐点
// 核对行为面未变，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 观察判据与计划报告批次（本批刷新）：sourceFiles 变化 ——
// src/services/observation/scheduler.ts（OBSERVATION_SYSTEM_PROMPT 尾句加强：没有稳妥观察、
// 没有新了解或没有值得更新的内容时返回空数组 —— 空数组是常见且正确的输出，不要为了「有产出」
// 硬写；2026-10-06 用户裁决）、src/services/observation/topics.ts（TOPIC_SYSTEM_PROMPT 加强：
// 整批都没有值得记的主题返回空 entries、不硬凑）、src/services/engine/harness/runtime.ts
// （runPlanPhase 的 onStepNotice 收窄：工具名不存在仍发聊天系统消息；未限定工具只写进度事件
// 与统一日志）。ob-01..ob-09 逐点核对：ob-04/ob-08/ob-09 的决策输入、读取名额与档位消费语义
// 未变（本批只改两个系统提示词的判据文案），ob-01/ob-02 的了解层与话题来源准入/失效链路未受
// 影响；runtime 的计划报告分支与观察链不相交。未修订覆盖点，sourceHash 按当前源码复算
//（同批含工作树中本改动单之外的并发改动：crates/native-host/Cargo.toml 为单实例守卫新增
// Win32_Storage_FileSystem feature，不在本契约覆盖点面内）。
// 2026-10-06 固定钟点批次（本批修订描述与 sourceFiles，sourceHash 与 caseId 登记留验收环节
// analyze→generate）：sourceFiles 增 `src/services/proactive/schedule.ts`（静默了解与记忆整理
// 共用的钟点判定纯函数，零依赖叶子）与 `src/services/proactive/protocol.json`（钟点表的真相源，
// scheduler 经 tiers 查表消费）。ob-09 按新语义改写：档位 = 每日钟点数（低 12/20、中 10/14/18/22、
// 高 9/11/13/15/17/19），到点即跑、不再要求系统空闲、去掉「AI 生成中 / 会话忙碌」排除；
// 每日批数 = 钟点表轮数（2/4/6）。ob-09 的 L3 用例已同步（钟点判定替换为可切换的桩），
// 到点/未到点/同钟点不重复/静默时段/三档表由新增 L2 用例
// `test/unit/observation/钟点调度判定.test.ts`（caseId `observation-scheduled-slot-table`，
// unit 层，本单未登记覆盖点）见证。ob-01..ob-08 不受影响。
// 2026-10-06 最终波统一刷新（analyze→generate 收口；上一条留待验收的 sourceHash 与 caseId
// 登记一并完成）：本批三支并行队伍落地 ——
// E（抗删 + 整机只读）：`src/services/observation/decide.ts` 决策提示词改「整机只读探查」
// （任意目录与文件可看、一律只读，点名 /Applications、/Library、/tmp 等系统位置；保留凭据/
// 密钥禁令）、`crates/native-host/src/commands/observation_cmd.rs` 宿主逐项重校验去掉
// 「主目录之内」与「非 home 系统目录」两条边界（保留绝对路径 / canonical 解析 / 数据根之外 /
// 非凭据路径；Rust 单测按整机范围改写）、`src/services/session/manager.ts`（不在本契约
// sourceFiles：删会话不再作废该会话产生的话题来源，行为面落在 ob-02）。
// D（定时化）：`src/services/observation/scheduler.ts`（批次资格改 `scheduledSlotDue(limits.hours…)`、
// idleForMs 不再参与——上一条已记）、`src/services/proactive/protocol.json` 与
// `src/services/proactive/schedule.ts`（上一条已记）、`crates/native-host/src/proactive/store.rs`
// （辅助预留的 observation 天花板 = 静默档钟点表轮数，静默档最高 12 → 6）、
// `crates/native-host/src/ui/settings/schema.rs`（两域档位 help 文案改「固定钟点每日 2/4/6 轮，
// 到点即跑」，非行为面）。
// F（dreaming 扩源 + clear 联动）：`src/services/observation/scheduler.ts` 的
// clearSilentUnderstandingOwned 在清了解数据文件前先调 `forgetUnderstandingDerivedMemory()`
// （记忆闭包按 `understanding:` 前缀圈定了解沉淀来源：先失效主动引用、写提取墓碑、删条目与
// 候选、推进遗忘代与 revision；画像结论不在其中；库里没有了解数据时零写；记忆侧失败如实
// 抛出）、`src/services/agent/memory/index.ts` 与 `ipc.ts`（闭包导出与 `forget_understanding`
// 治理动作）、`test/integration/observation/了解层与话题来源.test.ts`（替身挂住闭包调用）。
// 覆盖点逐点核对与修订：
// - ob-01 修订：clear 补「联动记忆闭包（forget_understanding）」一句（顺序、零写与失败口径）。
// - ob-02 修订并登记 caseId `session-delete-keeps-topics`（L3 载体
//   test/integration/session/会话删除与托管图片清理.test.ts）：删会话不再作废话题来源，
//   作废只来自显式治理路径（取消/清除/entry 失效）与自身 TTL。
// - ob-03 修订：读取边界措辞按 2026-10-06 用户裁决改「整机只读」（绝对路径、canonical 解析、
//   数据根之外、非凭据路径；不再限用户主目录、不再排除 home 系统目录）——该措辞实际在 ob-03，
//   不在 ob-04；ob-04 另行修订（决策提示词范围 + 其 caseId，见下）。
// - ob-04 修订并登记 caseId `observation-decision-whole-machine-scope`（L2 载体
//   test/unit/observation/决策解析与读取名额.test.ts 的决策提示词范围用例；全仓清点本波新
//   caseId 时与上述两个一并补齐）：决策提示词改整机只读口径。
// - ob-09 核对通过（钟点表 / 追赶窗口 / 同钟点去重 / 静默时段 / 防重间隔 / 每日轮数 = 钟点表
//   轮数均与 scheduler.ts、schedule.ts、tiers 的现实现一致），未修订；`observation-scheduled-
//   slot-table` 是 L2 载体，跨层对账按「声明层 = 载体层」判定（ob-09 是 integration 层不能收
//   unit 载体），按先例（pr-17 拆同层单元点）新增 ob-10 登记，语义即 ob-09 的钟点判定面。
// - ob-05..ob-08 逐点核对实现点仍在、描述与当前实现一致，未修订。
// sourceHash 按当前工作区源码复算（本波 E/D/F 三个源文件集与上一条留待的收口一并计入）。
// 2026-10-06 收尾修复（本批刷新）：sourceFiles 变化 —— src/services/agent/memory/index.ts 的
// forgetUnderstandingDerivedMemory 对「此宿主没有记忆后端」（UnsupportedInNodeError，L3 Node
// 适配层）按既有 standard-setup 口径跳过并留痕；清静默了解的联动闭包在无后端环境不再崩
// （画像采集落盘用例双红修复）。未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-06 抽屉 CONFIG 写批次（本批刷新）：sourceFiles 行为面变化 —— src/services/config.ts
//（`safetyConfig.mode` getter 增读取期收拢：非法值回落 `tell_me`；会话级安全覆盖机制删除后
// 配置是唯一真相源 —— 观察决策、静默了解与话题链不消费该键）、src/services/agent/runner.ts
//（繁忙投递意图的显式选择整链删除：resolveDeliveryIntent(text) 只留 slash→nextRun 与 CONFIG
// `ai.conversation.defaultDelivery`；观察链不读投递意图）、
// src/services/engine/harness/runtime.ts（三处思考强度消费点直读 `aiConfig.thinkingEffort`）、
// src/services/native-ui/host-requests.ts（抽屉三个下拉改与设置页同键的 CONFIG 写并新增一条
// chat_set_default_delivery 请求臂；三项键保存后重推一次会话投影 —— 抽屉/设置面消费，观察
// 链不消费；personality_cards 改 listCardMetas 上批已记）。
// ob-04 描述订正：读取名额的旧常量名 MAX_READS_PER_HOUR 已不存在 —— 上限由静默了解档位表
// 提供（silentTierLimits(tier).maxReadsPerHour ＝ 4/8/12），窗口 READ_WINDOW_MS ＝ 1 小时，
// 判定与扣减是 decide.ts 的纯函数 readSlotsAvailable。
// ob-01..ob-10 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；
// 其中 ob-03 的 Rust 边界（绝对路径/canonical/数据根之外/非凭据，无 home 限制）、ob-04 的
// 名额与解析退化、ob-05 的 64 条滚动记账与审计裁剪、ob-09/ob-10 的钟点资格与两区档位表
// 按当前源码逐项复核。sourceHash 按当前工作区源码复算。
// 2026-10-06 写队列合并修复（本批刷新）：src/services/config.ts 的 `queueConfigSave` 微任务
// 补 `saveQueued` 复检 —— `flushConfig()` 接管排队保存（先清标志再原子写）后那条微任务必须
// 退场，否则同一份内容被重复写盘；纯 setOverride（无 flush）路径不变。观察链覆盖点行为面
// 不受影响（观察到的是配置现值，非写盘次数）；sourceHash 按当前源码复算。
// 2026-10-08 v0.20.5 发布后全量复算（本批刷新）：上一条声明的 sourceHash 复算失配，逐字节
// 对账 —— 自 cebb2b5 起被改过的 sourceFiles 共 8 个，其中 aacbabb「抽屉三控件与设置页同键写
// CONFIG」批次的 5 个（src/services/config.ts、agent/runner.ts、engine/harness/runtime.ts、
// ui/settings/schema.rs、native-ui/host-requests.ts）当前内容已计入上一条声明的 hash（上批
// 刷新时的工作树已含该批改动；在案注释与该批 diff 逐条核对一致：三键唯一真相源回 CONFIG，
// 观察决策、静默了解与话题链不消费它们 —— 观察决策经 completePiText 不传 thinkingEffort）。
// 相对声明 hash 的新增变化仅三处：crates/native-host/src/paths/security.rs（ef45e60：
// allowed_file_roots 补入应用自身数据根候选，供通用文件能力边界在数据根落到 $HOME 之外时
// 不再 PATH_ESCAPE；ob-03 的读取终裁不经过它 —— observation_cmd.rs 的 read_one_target 仍以
// paths.data_root 直接判「数据根之外」，语义未动）、crates/native-host/Cargo.toml（0571a79 /
// 9236888：Windows 构建期 embed-resource 嵌 exe 图标与 Win32_Graphics_Dwm feature 去主窗
// 系统边框）与 Cargo.lock（同一批构建依赖新增与 0.20.0–0.20.5 发版的 native-host 版本号位）：
// 三处均不在观察行为面内。ob-01..ob-10 逐条按当前源码复核实现点仍在、描述与当前实现一致
// （ob-03 整机只读边界与 CANCELLED 终裁、ob-04 名额 4/8/12 与 fail-closed 解析、ob-05 的
// 64 条滚动记账、ob-09/ob-10 的钟点表与 15 分钟追赶窗口逐项对照），未修订覆盖点，仅按当前
// 源码刷新 sourceHash。
// 2026-10-08 同批收口（用户裁定）：① **`Cargo.lock` 移出 sourceFiles** —— 它含 native-host
// 版本号行、发版即变，本契约因此自 v0.20.0 起连续五代挂着（0.20.0–0.20.5 每个 release 提交
// 都改 Cargo.lock，而 release 提交不刷契约）。版本号对观察行为零意义；依赖增删的告警由
// `crates/native-host/Cargo.toml` 与 CI 构建承担，那份保留（它用 `version.workspace = true`，
// 发版不改它）。② **ob-04 描述收紧**：原文「字段非法、相对路径、重复路径一律退化为空清单」
// 比实现严 —— 实现是逐条跳过、重复路径保留首现，只有没有任何合法目标时结果才为空（与 L2
// 用例的实际断言一致）。①动了 sourceFiles ⇒ sourceHash 按当前源码复算。
// 2026-10-08 定向复核（本批刷新；按 README「机械变更的定向复核」口径）：
// 相对上一版声明值的唯一改动面 = `crates/native-host/Cargo.toml`，来自**更新取字节的系统
// 代理批次**（`update/proxy.rs`）——macOS 段增 `system-configuration` 与 `core-foundation`，
// Windows 段给 `windows-sys` 增 `Win32_Networking_WinHttp` feature。三项证据：
// ① 具体 diff：manifest 的两处 target 依赖段各增行，无版本重排、无 feature 移除；
//    `build.rs` 与 `[profile.*]` 未动（本文件所在仓库根 `Cargo.toml` 不在 sourceFiles）。
// ② 受影响 coverage / caseId：**无**。三个新依赖只被 `update/proxy.rs` 消费（构造
//    `ureq::Proxy` 与取 CFDictionary / WinHTTP 结构体），观察链一个符号都不碰 ——
//    `observation_cmd.rs` 的读取终裁、决策解析、`monitor/*` 均未改，ob-01..ob-10 的
//    实现点与描述不变，无 caseId 需要迁移。
// ③ 同文件其余内容为何不在改动面：本次只增依赖行与 feature 名，不改变既有依赖的解析结果
//    （新增包无版本冲突、不经 feature unification 影响既有 crate）。
// 对照已核实：把 `crates/native-host/Cargo.toml` 换回上一版（git HEAD）复算，恰好等于上一版
// 声明的 sourceHash —— 即本契约上一轮审查已覆盖当时工作树里的其它并发改动，本次增量只此一项。
// 2026-10-08 定向复核（本批刷新）：sourceFiles 变化 = `src/services/observation/scheduler.ts`。
// 本批在该文件只动**留痕**，不改批次资格与产出：① 批次资格函数改成「返回第一道没过关名」，
// 把关名 + 门禁快照（窗口 / 屏幕 / 观察龄 / 上次尝试）交回调用方留痕 —— 过去每道关都直接
// `return false` 不留痕，实机无法判断是本小时「没到点」还是「被挡住」（2026-10-08 用户报
// 「静默了解一批都没跑过」，正是卡在这里）；② `observeBatch` 的两处静默早退补同样留痕
//（它们走不到 `markAuxiliaryAttemptAt`，是「批批判开跑却不落盘、每分钟重来」的入口）。
// ob-01..ob-10 的实现点与描述均不变，无 caseId 迁移。
// 附注（不在 sourceFiles，但确实改变行为时机）：同批把 `crates/native-host/src/monitor/thread.rs`
// 的观察线程改为**启动即首采** —— 原实现首轮判不出 generation 变化就直接睡到下一个平台事件，
// 于是「应用启动到用户第一次切窗口」之间窗口观察恒为空，静默了解第 5 关（要求有当前窗口观察）
// 整轮不过；15 分钟追赶窗下启动落在后半段就必然错过（实测就绪时间 ~2 分钟 → 0.5 秒）。
// 本契约 watched 的是 `monitor/mod.rs`，故 hash 不含该文件。
// 2026-10-09 observation evidence sync: coverage/sourceFiles include verified artifact identity,
// topic enums/deduplication, and the shared memory reconciliation gates. sourceHash was refreshed at acceptance (2026-10-09).
import type { ModuleContract } from "../host/types"

// 2026-10-10 记忆断点修复定向核对：本域既有消费者与分派语义未变；新增受控会话读取及请求内guide由memory契约持有，生成协议仅增命令/规范排版。
export const observationContract: ModuleContract = {
  module: "observation",
  sourceFiles: [
    "src/services/observation/index.ts",
    "src/services/observation/types.ts",
    "src/services/observation/store.ts",
    "src/services/observation/topics.ts",
    "src/services/observation/scheduler.ts",
    "src/services/observation/evidence.ts",
    "src/services/observation/ownership.ts",
    "src/services/observation/decide.ts",
    "src/services/observation/config.ts",
    "src/services/config.ts",
    "src/services/proactive/config.ts",
    // 2026-10-06 固定钟点批次补入：ob-09 的钟点判定与档位表消费直接依赖这两个文件
    //（schedule.ts = 判定纯函数，零依赖叶子；protocol.json = 钟点表真相源，经 tiers 查表）。
    "src/services/proactive/schedule.ts",
    "src/services/proactive/protocol.json",
    "src/services/behavior/collector.ts",
    "src/services/window/listener.ts",
    "src/services/window/monitor.ts",
    "src/services/window/index.ts",
    // ob-07 断言的领域 barrel 面：主动 / 记忆两个 barrel 与上面的 observation / window
    // 属同一次「UI 协调移出领域面」裁定（W11b），其导出面的变化要重新审查该负向断言。
    "src/services/proactive/index.ts",
    "src/services/agent/memory/index.ts",
    "src/services/agent/memory/evidence.ts",
    "src/services/agent/memory/sources.ts",
    // ob-02 depends on the runner's committed-user ingress hook; the observation topic module
    // owns the evidence policy, while the generic user-turn lifecycle belongs to agent-runtime.
    "src/services/context/budget.ts",
    "src/services/images/budget.ts",
    "src/services/images/limits.json",
    "src/services/engine/runtime/snapshot.ts",
    "src/services/engine/harness/index.ts",
    "src/services/engine/runtime/types.ts",
    "src/services/agent/runner.ts",
    "src/services/agent/memory/ipc.ts",
    "src/services/proactive/content/pool.ts",
    "src/services/proactive/auxiliary-budget.ts",
    "crates/native-host/src/proactive/schema.rs",
    "crates/native-host/src/proactive/store.rs",
    "crates/native-host/src/proactive/commands.rs",
    "crates/native-host/src/commands/observation_cmd.rs",
    "crates/native-host/src/commands/mod.rs",
    "crates/native-host/src/host/dispatch.rs",
    "crates/native-host/src/error.rs",
    "crates/native-host/src/paths/security.rs",
    "crates/native-host/src/monitor/mod.rs",
    "crates/native-host/Cargo.toml",
    // `Cargo.lock` 于 2026-10-08 移出 sourceFiles：它含 native-host 版本号行、发版即变，
    // 每次发版都会把本契约打过期（0.20.0–0.20.5 连续五代）。依赖增删由上面那份
    // `crates/native-host/Cargo.toml` 与 CI 构建承担告警，版本号行对观察行为零意义。
    // 原 `src/App.vue`（跨窗口观察治理生命周期；按 silentAccess 应用 setMonitorEnabled）随 WebView
    // 删壳退役：观察订阅与总闸应用已由 window/monitor.ts 的 initWindowObservation 接回（两者都在列）；
    // 跨窗口治理形态在单 Node 架构下取消，本地应用即真相源（见 observation/ownership.ts）。
    "crates/native-host/src/ui/settings/schema.rs",
    "src/services/native-ui/host-requests.ts",
    "test/integration/observation/了解层与话题来源.test.ts",
    "test/unit/observation/证据身份稳定.test.ts",
    "test/e2e/scenes/observation/静默访问关闭边界.scene.ts",
  ],
  sourceHash: "8ea431499d09defdb5bb722e7ea7f6d74a4380f8ca853b2560cb36240a06e4ca",
  coverage: [
    {
      id: "ob-01",
      feature: "了解层来源、TTL、关闭与清除水位",
      description: "了解层只返回未过期截图/文件/窗口摘要；record绑定稳定artifact `evidenceId` 与输入版本 `evidenceHash`，后者不增加独立来源数。file/dir以路径作稳定身份，window/screenshot以appId作稳定域，title不参与身份；窗口快照文本或截图图像本身变化时只产生新输入hash，同artifact重复采样不增独立来源数。coverage记录数与independent source count分开，至少3个独立artifact才ready。缺hash旧记录可展示，但不提升ready、不进入prompt或derived-memory登记；Store先持久化closure pending，recall/derived registration前经memory reconciliation撤销旧understanding来源，闭包成功才ack，失败保留待办。关闭许可不向请求暴露观察；clear等待在途任务与入队写完成、撤掉摘要/标签，并持久化topic source watermark，提交前产生的老用户entry即使被普通回合补扫也不能回灌；clear 还联动记忆闭包（forget_understanding）：先按 `understanding:` 前缀失效了解沉淀的记忆（失效主动引用、写提取墓碑、删条目/候选、推进遗忘代——与清画像共用同一 Rust 闭包，画像结论不在范围，库里没有了解数据时零写），再清了解数据文件，记忆侧失败如实抛出。Node集成只证明现有文件IPC/RAM语义，不假冒Rust截图和文件路径裁决。",
      why: "观察来源是可撤销派生资料，不能在关闭时进入模型，也不能在清除后被迟到任务或忙碌收件箱扫描复活。",
      layer: "integration",
      depth: "deep",
      scenarios: ["observation-understanding-ttl-clear", "observation-evidence-source-dedupe"],
    },
    {
      id: "ob-02",
      feature: "话题画像的可信用户来源与失效",
      description: "只接受已提交origin=user、taint=trusted_user且eligibleForMemory的用户entry；单次辅助调用输出有限category/sensitivity/stance枚举并严格校验，敏感或unknown标签不进入可用选材；中立、负面、引用、假设、否定等stance留在证据，不转换成喜欢。weight表示参与度而非偏好；同一source内规范化topic与重复模型条目只保留一次、不乘权重。至少2个独立用户source后才公开参与占比；标签source证据最多512条且自然保留90日；取消/清除/entry失效阻止旧标签回写；删除会话不再作废该会话产生的话题来源（2026-10-06 用户裁决）：证据独立存活到自身TTL自然过期，作废入口只留显式治理路径。",
      why: "单次提及与话题参与不等于偏好，工具/外部内容不具备用户来源资格；敏感标签与立场不能被统计权重伪装为用户喜好。",
      layer: "integration",
      depth: "deep",
      scenarios: ["observation-topic-trust-cancel", "observation-topic-revoked-before-provider", "observation-topic-large-batch-progress", "observation-topic-decode-evidence", "observation-topic-source-dedupe", "session-delete-keeps-topics"],
    },
    {
      id: "ob-03",
      feature: "Rust观察命令的许可终裁",
      description: "静默访问关闭时，真实Rust注册的截图与目标读取命令（observation_read_targets）返回CANCELLED，系统窗口观察显示disabled；前端关闭只能阻止调度，最终权限由原生MonitorState裁决。读取目标由 AI 决策（decide.ts）、宿主逐项重校验（绝对路径、canonical 解析、数据根之外、非凭据路径等路径边界——整机只读，不再限用户主目录、不再排除 home 系统目录；W1 起删除大小/条目数值上限——目录全量列名、文件整读），单项失败只记 skipped 不中断整批。",
      why: "前端状态或漏接的后台任务不能绕过用户关闭许可，原生边界必须阻止截图和文件读取。",
      layer: "e2e",
      depth: "deep",
      scenarios: ["observation-native-disabled-boundary"],
    },
    {
      id: "ob-04",
      feature: "静默了解的目标决策与读取名额",
      description: "读什么由 AI 决策：决策调用输出 {targets:[{path,kind,why}]}（绝对路径），解析器逐条跳过坏目标（围栏 JSON、非数组、字段非法、相对路径），重复路径保留首现，只有没有任何合法目标时结果才为空清单（本批只截图、不报错崩批）；单批目标数不设硬上限（W1 起删除 ≤3 截断；单批读取量以剩余每小时名额为界），每小时读取名额（上限取静默了解档位表的 `silentTierLimits(tier).maxReadsPerHour`＝4/8/12，窗口 `READ_WINDOW_MS` 一小时；判定/扣减是纯函数 `readSlotsAvailable`，2026-10-06 订正：旧常量名 MAX_READS_PER_HOUR 已不存在）在批次开始前扣减，超限即跳过决策与读取。决策输入的基础块在同层按界断言：Card 人设有界摘要（名字/描述/角色设定截断）与带时区的可读本地时间；完整输入矩阵与降级由 ob-08（L3）覆盖；决策提示词的范围口径按 2026-10-06 用户裁决改整机只读（放开系统/应用配置目录，保留凭据/密钥禁令与只读语义）。",
      why: "用户已撤销「指定目录」配置，读目标改由模型判断；决策输出是不可信输入，解析必须 fail-closed 且不能把坏 JSON 变成崩溃或乱读；输入块只读有界才能既把决定权交给模型，又不让每条链各自造证据或撑爆请求预算。",
      layer: "unit",
      depth: "shallow",
      scenarios: ["observation-decision-parse", "observation-read-quota", "observation-decision-card-brief", "observation-decision-local-time", "observation-decision-whole-machine-scope"],
    },
    {
      id: "ob-05",
      feature: "读取记账与了解层审计",
      description: "每发一个读取目标记 1 次并持久到 understanding.json 的滚动时间戳（上限 64 条、加载时滚出窗口外、清除了解域一并清空）；了解记录的 targets 审计字段随 record 落盘并裁剪到有界长度，旧记录缺 targets 仍可读取。",
      why: "每小时上限与「她读了什么」的可回看性都必须跨重启成立，否则上限形同虚设、用户无法审计 AI 读了哪些路径。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["observation-read-accounting", "observation-audit-targets"],
    },
    {
      id: "ob-06",
      feature: "了解层旧档兼容读取",
      description: "加载store时逐条容错保留有效dir与targets审计；缺证据身份/内容hash的旧记录只可展示，独立来源数为0且不ready、不进prompt或memory沉淀；加载前持久化旧了解来源memory closure待办，闭包成功才ack，失败保留重试。非法类型/坏记账不会让整档读取失败。",
      why: "了解层是增量落盘的历史文件，单条坏数据不能让静默了解整体不可用。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["observation-legacy-store-compat"],
    },
    {
      id: "ob-07",
      feature: "UI 协调移出领域面（跨域边界）",
      description: "旧壳的跨窗口协调入口不再出现在领域 barrel 面：agent/memory 无 initMemoryRevisionSync、proactive 无 requestProactiveControl、observation 无 initObservationGovernance / stopObservationGovernance、window 无 initWindowListener；领域侧保留可用的本地路径（记忆 revision 的进程内分发不依赖任何 UI 通道，单 Node 架构下所有提交都发生在本进程）。窗口与观察治理入口退役是本点的主体，主动 / 记忆两个 barrel 面是同一次裁定的断言面（已登记进 sourceFiles）",
      why: "入口留在领域面，删壳后的窗口协调会被重新接线进 Node 图（造出第二真相源）；负向边界没有门禁就会被后续的「补兼容」悄悄加回来",
      layer: "integration",
      depth: "shallow",
      scenarios: ["ui-coordination-outside-domain-barrels"],
    },
    {
      id: "ob-08",
      feature: "静默了解决策输入补齐与降级（L3）",
      description: "决策输入在 W4-B 补齐为只读有界块并经 L3 端到端断言：本地时间（时刻+时区）、Card 人设有界摘要（名字/描述/角色设定截断）、行为画像快照（质量状态+active-only就近6钟点分钟）、话题参与占比top-5（至少2独立source；weight不代表喜欢，携带中立/负面/引用/假设等stance）、长期记忆核心画像（召回端口空 query、token 上限 256、关闭重排、身份取运行时会话与激活 Card；条数与单条字符都有界）；原窗口快照与最近 8 条已验证了解摘要保留。画像不可靠/话题为空/无 Card/无记忆时各块如实降级（null / [] / 质量状态原样）而批次照跑；无活跃会话时不发起记忆召回、不造身份。",
      why: "输入块只读有界才能既把决定权交给模型，又不让每条链各自造证据或撑爆请求预算；降级必须如实（不可靠带状态、无身份不造身份）而不是静默补块或抛错。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["observation-decision-inputs", "observation-decision-inputs-degrade", "observation-decision-memory-identity"],
    },
    {
      id: "ob-09",
      feature: "静默了解档位参数消费（off/低/中/高）",
      description: "静默了解调度按 ai.silentAccess.frequency 档位取全部参数：off = 调度器不启动、不预留批次、话题入口不开启（可信来源被丢弃、批次零模型调用）；三档决定固定钟点表（低 12/20、中 10/14/18/22、高 9/11/13/15/17/19——钟点后 15 分钟追赶窗口内到点即跑、同一钟点只跑一轮、表外与 23–9 静默时段不跑；判定纯函数在 proactive/schedule.ts）与防重间隔（2h / 30min / 15min——16 分钟前尝试在高档放行、中档被挡）、每日批数 = 钟点表轮数 / 每小时读取名额（2/4/6 与 4/8/12）——数值唯一来源是 proactive tiers 档位表，批次经 budget.reserve 以档位轮数预留；低档每小时读取名额占满时跳过决策调用、只做整理（一批 = 决策+整理两次辅助调用，名额耗尽时只剩一次）。批次资格不再要求系统空闲，也不含「AI 生成中 / 会话忙碌」排除（2026-10-06 用户裁决：允许用户使用电脑时后台了解）。",
      why: "档位是静默了解唯一的总闸与频率来源，任何一处仍读旧常量都会让档位选择无声失效（off 仍开批、中档按旧批数、低档按旧间隔、空闲要求回归）。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["silent-tier-off", "silent-tier-medium-limits", "silent-tier-low-read-quota", "silent-tier-gap"],
    },
    {
      id: "ob-10",
      feature: "固定钟点判定（纯函数，两链共用）",
      description: "静默了解与记忆整理共用的到点判定 `scheduledSlotDue(hours, now, lastAttemptAt)`：本地时刻必须落在某个钟点 H 的 [H:00, H:00+15 分钟) 追赶窗口内（表外钟点不触发；23–9 静默时段不在任何档位的表内，天然排除），且该钟点本轮未尝试过（lastAttemptAt 早于钟点起点；未来时间戳按已跑处理，失败向保守侧收拢）；同一钟点只跑一轮。钟点表两域同表（低 12/20、中 10/14/18/22、高 9/11/13/15/17/19），每日轮数上限 = 表长（2/4/6）。",
      why: "钟点判定是两链共享的触发口径，两侧调度器的用例都把判定替换为桩：判定本体（追赶窗口、同钟点去重、静默时段、两域同表）只有在纯函数上被逐项钉住，否则两链会在错误时刻跑或不跑，而各自的调度用例全绿。",
      layer: "unit",
      depth: "shallow",
      scenarios: ["observation-scheduled-slot-table"],
    },
    {
      id: "ob-11",
      feature: "窗口 artifact 身份与内容版本分离",
      description: "window/screenshot 的 evidenceId 按稳定 appId 分组，不含可变 title；窗口快照文本或截图图像由 evidenceHash 标记输入版本，因此同一 app 的标题微变不会作为独立来源抬高了解质量，实际输入变化仍能产生新版本身份",
      why: "标题属于窗口内容且会随保存状态/页面变化；把它放进 artifact 身份会将同一窗口误计为多个独立来源",
      layer: "unit",
      depth: "shallow",
      scenarios: ["observation-window-artifact-stable"],
    },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
