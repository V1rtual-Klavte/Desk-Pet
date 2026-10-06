// 2026-10-05 本批复查与刷新：契约 sourceFiles 里仅 runtime.ts 变化（另一会话同批写入：
// 工具过程文案新增 emitToolStageTitlebar 改推顶栏）；te-08..te-29 逐点核对实现点仍在、
// 语义未变（工具执行、许可、回读与 MCP 路径不受影响）。本批刷新同时包含另一会话对
// runtime.ts 的改动；主会话只做了「coverage 描述与当前实现一致性」的核对（不是逐行行为
// 审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— runtime.ts（RUNTIME_DATA 协议缺失
// 检测与提醒接线）、reply/generator.ts（generateReply 新增 runtimeDataMissing 回传值；
// 解析/写入/落盘顺序与既有行为逐字未变，新增字段在工具链无消费者）。te-08..te-29 的工具执行、
// 许可、回读、Skill 与 MCP 路径逐点核对不受影响，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造：
// 「最近一次请求」展示统计只刷对话回合、真实 prompt 含缓存读写）。te-27 的 DebugBar 工具读数
// 口径是对话回合的「实际请求工具面」，上报路径未被本改动改写；te-08..te-29 逐点核对实现点
// 仍在、覆盖描述与当前实现一致。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与
// 当前实现一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志）与 harness-slot.ts（compaction_end 按
// manual/overflow 落 deskpet.compaction_declined 条目、threshold 只留日志）。te-17 的
// preserve/投影语义与摘要素材共用链路未被改写（本次只改拒绝留痕，不改投影实现）；te-08..te-29
// 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 复算补充（同一刷新轮）：复算时并发落进一处本批改动单之外的 context/budget.ts
// 变化（keepRecentTokens 上限改为随窗口长大；并发写入，不在本批改动单内）。按当前源码复算，
// sourceHash 一并覆盖它；te-08..te-29 无覆盖点描述 keepRecentTokens（te-13 的页预算走
// toolResultTokenBudget(window)，本次未改），逐点核对不受影响。
// 2026-10-05 频率档位收口波（analyze→generate）：te-22 描述订正 —— 窗口信息工具的总闸
// 已从 `ai.silentAccess.enabled` 改为 `ai.silentAccess.frequency`（off 即「未开启」，非 off
// 放行）；sourceFiles 补入 `crates/native-host/src/commands/mcp_credentials.rs`（te-30 凭据链
// 的 Rust 命令实现，此前不在任何契约的 hash 覆盖内）。te-30 的 caseId 登记与 te-08..te-29
// 逐点复核在本波完成；sourceHash 按当前源码复算。
// 2026-10-06 上下文窗口默认值批次（analyze→刷新）：sourceFiles 变化 ——
// src/services/context/budget.ts（2f32519：DEFAULT_CONTEXT_WINDOW 131_072→262_144，窗口语义
// 唯一定义点的值变化；函数与其余常量未动）。te-13 / te-17 的页预算与结果预算都按运行时窗口
// 参数化（transcriptPageTokens(window) / toolResultTokenBudget(window)，随窗口单调），不钉
// 默认值；te-08..te-29 无覆盖点描述默认窗口或 keepRecentTokens（已逐点核对），描述经核对
// 仍准确，未修订覆盖点。sourceFiles 无需增删（budget.ts 已在列）。本契约此前被 config 批次
// 留在 STALE，本批一并收口，sourceHash 按当前源码复算。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（子运行 provider 准入转发与 invisible sinks）。
// te-23 的子代理工具面剥离口径未变；te-13 回读链、te-17 投影与 MCP 路径不在改动面内、
// 实现点仍在，覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/context/budget.ts（新增 totalInputTokens）、
// src/services/engine/harness/{runtime,model-gateway}.ts（偏差对账 actual 改用真实输入量）。
// te-13/te-17 的页预算与投影、MCP 路径不在改动面内、实现点仍在，覆盖描述与当前实现一致，
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 工具循环治理批次（analyze→generate）：sourceFiles 变化 ——
// `src/services/engine/harness/tool-loop-guard.ts` 补入（新增的病理检测叶子：同参连击 /
// 连续失败阈值与中性文案；它此前不在任何契约的 hash 覆盖内），`runtime.ts`（beforeTool 计数
// 上限只对子运行生效 + 病理软/硬判据接线、afterTool 结果侧失败连击与 terminate、
// createTurnSpec 的 maxToolCalls 变为可选、applyLevels 增加软提示尾参）、
// `harness-slot.ts`（stoppedAtToolLimit → stoppedByToolGovernance 改名 + afterTool 返回
// 类型增 terminate、回合受理凭据）、`agent/sub-agent.ts`（子运行封顶参数改读
// ai.loop.subAgentRounds，数值 5 不变）。新增 te-31（unit）：循环软提示在三个投影档位
// 都不丢的通道（caseId 归本契约 —— 提示经 context/tool-output.ts 的投影出口附着，语义是
// 工具结果的请求投影；hard 终止与 guard 阈值本身的 caseId 归 agent-runtime 契约）。
// te-13 的持久化/回读口径与 te-17 的投影策略描述经核对未被本批改写（软提示是同一出口上的
// 可选尾行，不改阶梯判定），te-08..te-30 其余点逐点核对实现点仍在、覆盖描述与当前实现一致
// （描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-06 计划提议工具批次（analyze→generate）：新增 propose_plan（
// `src/services/tool/local-extra/plan.ts`；NORMAL / passthrough / external_side_effect +
// isolation:delegate / replay:never / resultProjection:preserve，超时预算按
// engine/plan/limits.ts 的确认上限 + 计划时限折算）—— 它是「需要用户确认的多步操作」的
// 模型入口，确认与执行复用既有计划机制（相位在 engine/plan/proposal.ts，caseId 归
// planner 契约的 pl-13）。te-23 的子代理工具面口径未变（delegate ⇒ runPiSubAgent 剥离点
// 与计划步骤 allowedTools 硬失败都覆盖它，fork/team 白名单本就不含）。新增 te-32 登记工具
// 入口的参数准入、确认未成立/取消时的如实归宿映射与系统提示里的计划提议指引；
// sourceFiles 补入该工具文件；te-08..te-31 逐点核对实现点仍在、覆盖描述与当前实现一致
// （描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-06 bash 超时档位/进程组回收批次（analyze→generate）：sourceFiles 变化 ——
// 新增 `src/services/tool/local/bash-timeout.ts`（零依赖叶子：bash 档位 300s 的唯一定义点、
// 模型向描述与 timeout 参数文案、`prepareArguments` 的生效值夹取）与
// `crates/native-host/src/commands/tool_exec/bash.rs`（Rust 实现点：同值兜底 300s、stdin 关死、
// 超时/取消/退出共用的进程组回收 kill_process_group）；`pi-tools.ts` 经 withBashToolPolicy
// 接入（timeout 参数说明同步覆盖上游的 no default timeout 口径）。新增 te-33（unit：夹取语义）与
// te-34（integration：注册口径 + 生效值以毫秒下传到 bash_exec）；te-18 的 why 修订过时数字
// （Rust 兜底 120s→300s），其覆盖描述（spawn 前取消立案、三态返回）逐点核对实现点仍在；
// te-10 / te-13 / te-16 / te-17 / te-31 / te-32 与路由、许可、投影、MCP 路径不在改动面内，
// 覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-06 契约刷新（第二轮验收 · analyze→generate）：按快层校验的层账落定 ——
// te-32 的两个 unit 层语义 caseId（plan-tool-prompt-guidance / plan-tool-prompt-absent，
// 由 test/unit/tool-execution/提议计划提示词.test.ts 携带）从 te-32（integration）拆出为
// 同层的 te-35（unit：buildPrompt 的「计划提议指引」只在工具面含 propose_plan 时注入）；
// te-32 保留 integration 层五点（取消/准入/Schema 拒绝/面板不可用/发射失败）。sourceFiles
// 补入 src/services/context/builder.ts（指引注入的唯一实现点，te-35 的来源；该文件同时被
// agent-runtime / memory / variable-pool 覆盖，属共享文件多契约在列的既有形态）。
// te-08..te-34 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；
// rules 不动（te-35 是 L2，不入 L4 计数）。sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

// 2026-10-06 实测反馈收口（本批刷新）：sourceFiles 变化仅限 context/builder.ts 的计划提议指引
// 补一句「单个动作需要确认时直接执行（危险动作由确认面板向用户确认），不要用文字先征求同意」——
// 注入条件（工具面含提议工具）与注入通道未变，属同一行为的文案增补；各覆盖点逐条复核与当前实现
// 一致，未修订覆盖点，按当前源码刷新 sourceHash。
export const toolExecutionContract: ModuleContract = {
  module: "tool-execution",
  sourceFiles: [
    "src/services/engine/harness/runtime.ts",
    "src/services/engine/harness/harness-slot.ts",
    // 2026-10-06 工具循环治理批次补入：病理检测（同参连击 / 连续失败的软硬阈值与中性文案）
    // 的唯一定义点；te-31 的软提示内容与 te-16/te-17 之外的循环治理行为都从它产出。
    "src/services/engine/harness/tool-loop-guard.ts",
    "src/services/tool/router.ts",
    "src/services/tool/activation.ts",
    "src/services/tool/enable-tools.ts",
    "src/services/tool/policy.ts",
    "src/services/tool/execution-permit.ts",
    "src/services/tool/session-transcript.ts",
    "src/services/context/budget.ts",
    "src/services/context/tool-output.ts",
    // 2026-10-06 契约刷新（第二轮验收）补入：te-35 的实现点（buildPrompt 的系统提示装配 ——
    // 计划提议指引按工具面是否含 propose_plan 注入）。
    "src/services/context/builder.ts",
    "src/services/tool/registry.ts",
    "src/services/tool/types.ts",
    // 2026-10-06 计划提议工具批次补入：propose_plan 的参数准入与归宿映射（te-32）。
    "src/services/tool/local-extra/plan.ts",
    "src/services/tool/local/pi-tools.ts",
    // 2026-10-06 bash 超时批次补入：bash 档位、模型向文案与生效值夹取的唯一定义点（te-33/te-34）。
    "src/services/tool/local/bash-timeout.ts",
    "src/services/tool/local/system.ts",
    "src/services/tool/local/window.ts",
    "src/services/images/processor.ts",
    "src/services/tool/pi/harness-adapter.ts",
    "src/services/tool/pi/harness-tool-adapter.ts",
    "src/services/tool/pi/native-execution-env.ts",
    "src/services/tool/mcp/manager.ts",
    "src/services/tool/mcp/client.ts",
    "src/services/tool/mcp/transport.ts",
    "src/services/tool/mcp/http-headers.ts",
    "src/services/safety/checker.ts",
    "src/services/reply/generator.ts",
    "src/services/engine/harness/net-guard.ts",
    "src/services/engine/harness/model-gateway.ts",
    "src/services/engine/slash/commands/skill.ts",
    "src/services/skill/store.ts",
    "src/services/skill/loader.ts",
    "src/services/agent/sub-agent.ts",
    "src/services/window/index.ts",
    "src/services/window/listener.ts",
    "src/services/window/monitor.ts",
    "crates/native-host/src/commands/skill_cmd.rs",
    "crates/native-host/src/commands/tool_permit.rs",
    "crates/native-host/src/commands/tool_exec/mod.rs",
    // 2026-10-06 bash 超时批次补入：Rust 侧实现点（同值兜底 300s、stdin 关死、进程组回收）——
    // 此前只有聚合模块 mod.rs 在列，改 bash.rs 不判 STALE；te-34 的 Rust 行为断言从这里产出。
    "crates/native-host/src/commands/tool_exec/bash.rs",
    // 2026-10-05 自带 MCP 批次补入：te-30 的凭据链在 Rust 侧的命令实现（空值拒绝、
    // 按服务器取名单、status 不返回值；业务规则在 memory/store.rs），不补则改它不判 STALE。
    "crates/native-host/src/commands/mcp_credentials.rs",
  ],
  sourceHash: "4997775eed4e6c2156e6c37d5312c2eab20635fa8c73d4d3bbef640b1a946b72",
  coverage: [
    { id: "te-13", feature: "工具结果持久化与回读", description: "生产工具配对作为会话条目持久化，完整工具文本保留（L0 只改请求视图；Router 不做内联截断，旧 L1 截断已删），read_session_event 按条目 id 或其**最短唯一前缀**分页回读（前缀不唯一时返回明确错误、绝不任选；完整 id 恒可读），页大小由 `transcriptPageTokens(window)`（= `toolResultTokenBudget(window)`，与 L0 单条结果同一份额）的 **token 口径**限定并随窗口单调（旧的固定字符页宽常量已删除），单页正文由 `sliceByTokenBudget` 切出、`estimateContextTokens(正文) <= pageTokens` 恒成立，`offset` 仍是字符下标；读取限定当前 session（reader 是槽上的 readToolResult，工具只认地址引用）；超上限边界上条目仍为全文、请求视图带真地址（前缀形态）、bash 截断带 spill 回读路径（实际生效上限由 Rust 回传）。MCP 结果与内置工具走同一条回读链，**一次性截断已删**（旧 MAX_MCP_RESULT_CHARS 的「正文里如实标记不保留全文、不写假 eventId」前提随决策 11 反转）：全文原样落会话条目，缩短只由 L0 投影按 details.deskpetEntryId 完成，模型随后用 read_session_event 取回 —— 因此超过旧 50,000 字符的结果仍可回读。无地址的条目（取不到 `details.deskpetEntryId`）不写假 eventId：未缩短形态不追加任何行、缩短形态在占位串里如实说明「中间段不可恢复」，留痕按内容指纹键（`noAddressWarnKey` = `长度:首 NO_ADDRESS_WARN_KEY_CHARS=32 字符`）去重、同键只报一次，键集合有界（`NO_ADDRESS_WARN_KEYS=64`，满员按插入序 FIFO 淘汰最旧键）—— 指纹分键与去重由 memory 的 mm-27 场景断言，有界淘汰未由场景断言。唯一的物理上限在条目写盘链上（native-execution-env 的 MAX_TOOL_FILE_BYTES，5 MB）：超过时写盘如实失败，**不做静默截断**（§8.8 的裁定，边界本身未由本点场景断言，见 harness-storage 的 hs-02）", why: "短请求不能以丢失工具证据为代价；删掉截断后「大结果仍能取回」正是这条链唯一的可观测结论", layer: "e2e", depth: "deep", scenarios: ["tool-transcript-recovery", "tool-archive-beyond-inline-limit", "tool-mcp-large-result-readback"] },
    { id: "te-08", feature: "真 LLM 多工具调用", description: "真实 LLM 对话中先后调用多个工具。场景点名的 system_info 已按决策 13 改写为「运行环境」：五行输出（操作系统、架构、CPU 核心数、内存「已用 / 总 (百分比)，可用」、bash 默认工作目录），其中三个内存口径来自 Rust system_info（新增 memAvailable 字段，used 与 available 是各自独立的计数口径、不是互补关系），bash 默认 cwd 由 TS 侧 NativeExecutionEnv.defaultCwd() 提供而不是 Rust 返回值，因此不重复永不变的信息（旧实现里的「永不变」条目已删）。注：场景只断言工具调用成功与非空回复、不绑字段名，所以这五行的字段级形状未由本点断言（Rust 侧 SystemInfoResult 由单测覆盖）", why: "端到端工具链验证", layer: "e2e", depth: "deep", scenarios: ["tool-system-info"] },
    { id: "te-09", feature: "Provider 网络边界", description: "Provider 固定用户配置的 origin，拒绝 host/scheme/port 漂移并禁止重定向携带认证；显式 localhost/provider 可用，响应按流限额", why: "避免网络策略绕过和内存失控", layer: "integration", depth: "shallow", scenarios: ["tool-provider-network-boundary"] },
    { id: "te-10", feature: "工具超时判定", description: "超时与取消的判定顺序唯一：定时器置位记 timeout、外部 signal 记 cancelled，不靠错误文案；一次调用只有一条审计（operationId 属于本次调用，探针自己返回的 cancelled 不改写超时这条账）", why: "超时与取消不得互换：判定靠文案匹配时，超时探针按取消收场会被记成取消", layer: "e2e", depth: "shallow", scenarios: ["tool-timeout-outcome-single"] },
    // te-10 原把「取消 + 超时」合成一点（跨层混搭）；按层拆开：取消侧为 te-26（L3），超时侧留在 te-10（L4）。
    { id: "te-26", feature: "工具取消错误码", description: "已取消的工具调用不进入 handler 且返回稳定错误码 cancelled", why: "取消必须可观测且不可产生副作用：已 abort 的调用不得触达 handler", layer: "integration", depth: "shallow", scenarios: ["tool-cancelled"] },
    { id: "te-11", feature: "Skill 披露块与预算截断", description: "技能合法性与清单来源都是 Pi 的 loadSkills（name 可缺省取父目录名，与父目录不一致只产生 diagnostic 告警、不阻止加载），披露块由 Pi 的 formatSkillsForSystemPrompt 生成（只含 name/description/location），外面套 8 KB 字符预算：超限时**丢整条**（不截断单条，否则模型拿到半条指令）并把「保留几条、丢弃几条」log.warn 出来 —— 旧实现的静默丢弃与「catalog 只保留有界元数据」的前提都已反转，技能正文随 Skill.content 一并进清单缓存。清单取 store 的生效快照（enabled 过滤后；disable-model-invocation 由 Pi 自己排除），getSkillsPromptBlock 本身零 I/O，调用方必须在冻结 run snapshot 前先 await syncSkillCatalog()。附注：invocationPolicy / capabilityTags / 按模式筛选三个旧机制已全链删除（生产零消费者），正文**不做请求投影**（决策 4，token 成本登记在 §8.4）", why: "披露块是模型发现技能的唯一入口，预算超限必须是可见的容量决策而不是静默丢能力", layer: "unit", depth: "deep", scenarios: ["tool-skill-metadata-progressive"] },
    { id: "te-12", feature: "Skill 清单刷新（指纹驱动）", description: "syncSkillCatalog() 是唯一的刷新入口，每次调用恰好一次 Rust skill_catalog_fingerprint IPC：指纹未变直接复用缓存（稳态 1 IPC/回合），变了才重新 loadSkills —— **没有 TTL、不需要重启**，磁盘一改下一个回合就生效（旧实现按 TTL 与模式变化失效）。保存（upsertSkill）、删除（deleteSkill）、逐项开关（setSkillEnabled）、Profile 重种子与每回合的能力准备全部汇到这一个入口，不存在第二条刷新路径；指纹记的是加载前读到的值，加载期间磁盘再变只会多一次重载。失败语义：指纹核对失败或重载失败都保留上一份清单并记录 getSkillCatalogError()（不用空清单顶替，此时任何技能名在 lane 边界上都会表现成 UnknownSkill），任何一次成功核对（命中缓存的早退与重载都算）都清空该错误；truncated 时告警说明指纹只覆盖已扫描部分；并发调用复用同一个 in-flight 结果。删除坐标是 skills 根内的域内相对路径（Pi 递归遍历、根级 .md 也算技能、name 可与目录名不一致，按 name 索引会删错对象）。注：「每次调用恰好一次 Rust 指纹 IPC（稳态 1 IPC/回合）」与「并发调用复用同一个 in-flight 结果」都是真实行为，但本点场景既无计数 IPC 往返的 hook、也无法制造在飞窗口，这两条未由场景断言", why: "缓存失效只能由磁盘状态驱动；「保留旧快照 + 错误可读」是「索引不可用」与「真的没有技能」的唯一区分依据", layer: "unit", depth: "shallow", scenarios: ["tool-skill-catalog-invalidation"] },
    { id: "te-14", feature: "MCP 配置字段保留", description: "编辑自定义 MCP 服务器的常规字段（args/env）时保留 includeTools/excludeTools，避免工具暴露范围静默扩大；暴露范围只由每服务器 enabled 与这两个过滤字段决定（总闸 tools.mcp.enabled 已随决策 8 删除，单开一个服务器不再需要先开总闸）", why: "过滤规则是能力边界，设置页只编辑 args/env 不能抹掉源配置", layer: "integration", depth: "shallow", scenarios: ["tool-mcp-config-preserve"] },
    { id: "te-15", feature: "工具策略门禁", description: "defineTool 与注册入口对完整策略统一校验并冻结：缺 policy、shared_read 搭配非只读效果、未知策略版本、非法权限意见都报错（并发语义只由 isolation/effect 表达，execution.mode 与 permission.check 已无实现），被拒绝的声明不进入注册表；注册表按对象身份入库不克隆，getToolByName 返回同一份冻结定义；执行函数不在 ToolDef 公开字段里（经 defineTool 进入模块内 WeakMap），未经 defineTool 构造的定义在注册时被拒。TOOL_POLICY_VERSION 现为 2：安全等级到裁决结果的映射语义变了（SAFE/NORMAL 一律放行、不再按模式区分），旧版本的声明在同一入口以「策略版本不支持」被拒。策略身份 toolPolicyFingerprint 的字段里**没有 mode**（旧的 tool.mode 维度已删），其变化按 §8.5 让全部工具的 policyHash 失效。注：同一次校验里的风险声明校验（safetyLevel 必须四级之一，守的是未经类型检查的适配器与 as 断言）与「版本 1 声明被拒」均由本点场景断言：前者用表外等级（SUPER_DANGER）与拒绝原因匹配，后者以「策略版本不支持」的原因匹配 —— 场景不满足于「抛了错」，拒绝原因也一并断言（防「因为别的原因失败」也算通过）", why: "缺策略必须视为注册错误，不能缺省成可并行、可重放或某个默认权限；执行体只能来自唯一构造入口", layer: "integration", depth: "deep", scenarios: ["tool-policy-registration-gate", "tool-define-only-construction"] },
    { id: "te-16", feature: "纯读并行、效果互斥与借用者生命周期", description: "shared_read 按 Rust 应用级许可的有界共享额度并发（两个只读真的重叠），共享读上限由 `ai.loop.maxParallelTools` 下发（范围 1–8：上限 1 只放一个读、提高上限唤醒排队读、越界下发被拒绝且不改变生效值、降低上限不撤销在飞许可），exclusive_effect 与进行中的读写互斥：等待发生在许可队列（queued 可观测）、独占期间开不出新读、读不插队到排队中的独占之前、取消排队中的独占会重新放行后面的读、执行结束才释放额度且没有泄漏；借用者身份 = 窗口 + 页面实例，新实例上线按「旧借用者已经不存在」一次性回收其额度与排队项（回收数量可观测），同一借用者重复上线是空操作，在飞的独占效果不被回收放开；释放与取消同样绑定借用者：其它窗口/页面即使拿到 requestId 也不能释放在飞额度或取消他人的排队项；释放是一条 IPC，失败时额度会留在所有者手里（后续独占效果一直排队而工具结果看起来成功），因此释放失败的 requestId 入队补偿、在下一次 run 开始前重放归还（requestId 是确定量，Rust 对未知 id 返回 Ok，重放幂等），借用者的上线声明失败同样记欠账并在同一时点重试", why: "并行不能牺牲互斥：写类与其他执行必须串行，等待可取消且不让读饿死写，额度必须归还干净，上限变更不能留下越界或未生效的额度语义；页面重新加载（热重载）不再让借出的额度永久卡住后续工具，而回收不能靠时间放开仍在运行的效果；释放失败只留一行日志同样会把额度永久卡死后续独占效果", layer: "e2e", depth: "deep", scenarios: ["tool-execution-permit", "tool-permit-release-compensation"] },
    { id: "te-17", feature: "策略驱动的请求投影", description: "工具结果正文由 resultProjection 决定请求投影，会话条目存档在两种策略下都保持全文（缩短/清空只改视图）。`preserve` 是**禁止二次处理**：请求视图与摘要素材都不缩短、不清空（分页/有界由源工具自己负责），`preservedToolNames()` 把命中工具整体挡在阶梯候选集之外；但**地址标注照旧**——尾行仍是同一份模板（D-W2-5 的 2026-09-27 裁定：preserve 只挡升档处理，不挡地址标注），写入类回执（pi-write / pi-edit / app / clipboard_write）由此也有可捞的回读地址。`reference` 的结果由 L0 阶梯处理：超 `toolResultTokenBudget(window)` 的进候选，级 1 头尾切片缩短，级 1 之后视图仍超 `normalInputTarget` 时升到级 2 清空（清空以有地址为硬前提，无地址永远停在级 1），两级都带同一模板的地址尾行。两种策略下地址都是本条目的最短唯一前缀（完整 id 恒可读）", why: "分页读取不能被反复压缩，缩短只能改请求视图而不能改存档；preserve 的写入回执被摘要吃掉后同样需要可捞的地址", layer: "e2e", depth: "deep", scenarios: ["tool-result-projection"] },
    // 2026-10-06 工具循环治理批次新增 te-31（unit）：软提示的投影通道。caseId 归本契约的
    // 依据 = 它测的是 context/tool-output.ts 投影出口上的可选尾行（工具结果请求投影语义），
    // 与 te-13/te-17 同一模块面；同批的 guard 阈值（tool-loop-guard-*）与 hard 终止
    // （调用门 block+terminate / after_tool terminate）由 agent-runtime 契约登记。
    { id: "te-31", feature: "工具循环软提示的投影通道", description: "病理检测（同参连击或连续失败到软阈值）的中性提示经 `context/tool-output.ts` 的投影出口附到工具结果正文：`annotateToolResultText` / `projectToolResultText` 增可选尾参，省略时正文逐字不变（负对照）；三个投影档位 —— 未缩短（级 1、未超预算，经同一 annotate 出口）、级 1 缩短（头尾切片 + 缩短标记）、级 2 清空（有地址）—— 提示都不丢，且每条结果上只出现一次。提示是回合级内存态、只活在请求视图（不落盘、不进会话条目），文案是中性系统提示不是角色台词。注：「同一 toolResult 多 text 块只拼在最后一个 text 块上」的接线由 agent-runtime 的 `tool-loop-notice-multi-block-once`（L3）断言，不在本点（纯函数三档直测）范围内", why: "循环病态的提示与模型自己的调用病理同源，不能因正文被缩短或清空而消失——否则预算缓解措施会把「别原地打转」的唯一可见信号挤掉", layer: "unit", depth: "deep", scenarios: ["tool-output-notice-unshortened", "tool-output-notice-shortened", "tool-output-notice-cleared"] },
    { id: "te-18", feature: "bash 取消与 spawn 的竞态", description: "取消在子进程 spawn 之前到达不再静默丢失：登记先于 spawn（登记之前先过安全基线与 execution_id 校验 —— bash_exec 已无 policy/scope/whitelist 入参，调用方没有可传弱的旋钮），命中槽的取消立案后由 spawn 后的回填点立即终止（返回稳定码 CANCELLED，或非零退出），未命中的取消返回 false 并留 debug 记录而不是静默成功；被取消的运行收口远早于命令自然时长与兜底超时（正对照证明同形态命令不加取消会跑完并留下探针）、不留重定向产物，也不把额度留在占用态（shared/exclusive/queued 全回空闲）；「取消正好落在登记与 spawn 之间」的微秒级窗口无法从 JS 侧确定性复现，由 Rust 单测直接钉住（`bash_cancel_lands_before_spawn` / `bash_cancel_unknown_id_returns_false` / `bash_cancel_latches_slot_without_child`）；本机 macOS 只验证 unix 分支（`cmd /C` 选择与 Windows 的进程终止行为依赖 Windows CI）", why: "取消丢失会让子进程独自跑到兜底超时（现行档位见 te-33/te-34）：独占额度不归还、后续工具全部排队，而调用方以为已经停止", layer: "e2e", depth: "deep", scenarios: ["tool-cancel-before-spawn"] },
    { id: "te-19", feature: "/skill 显式调用", description: "命令层 skillCommand 只判定「这次调用能不能启动」，并把准入意图交给运行入口，四条终态互相可辨：空参数（说清用法，不把它当「技能不存在」）、未知名、正文为空、被 enabled: false 关闭（被关闭与不存在是两回事，前者用户自己能打开，报「不存在」会把人引向错误的方向）；技能目录索引不可用时返回中性故障句（summarizeError 脱敏摘要，不套 Card 终态句，也不把读取失败说成技能不存在）。参数按第一处空白切分：前段是技能名、余下是附加指示（可为空）。命中时出参是 {name, additionalInstructions?}（字段与 Harness 的技能准入规格同名同形），由 preprocessor 转成 {handled:false, skillAdmission} —— 不是被当成已完成的命令回复；落盘与驱动在运行入口（runtime 的 admitInput({kind:'skill'}) 让 Pi 在 accept 内按技能文件构造并提交那条 role:'user' 正文，含技能文件的绝对路径与附加指示，宿主不写第二条正文，命令层不写会话条目），正文不做请求投影（§8.4 登记成本）。注：忙碌期的处置（并发拒绝，不谎称已启动、也不把字面 /skill … 投进 lane）在 agent/runner.ts，不在本契约 sourceFiles", why: "显式调用必须与「未识别文本」区分开，否则命令行会被当普通聊天投递；四态结论与索引故障各自可辨是用户在设置页之外唯一的诊断入口", layer: "e2e", depth: "deep", scenarios: ["tool-skill-explicit-invocation"] },
    { id: "te-20", feature: "每技能 enabled 开关", description: "frontmatter enabled 是我们自有的字段，只认布尔 false 为关闭（缺省、字符串、数字等其它取值都算开启 —— 缺省开启是「目录里有就生效」的延续，删掉 tools.skill.enabled 总闸后技能不再需要显式启用）。生效清单只由 store 的 listEnabledSkills() 过滤，两个消费点共用同一份：披露块与 Pi 的 setResources({skills})，所以被关闭的技能既不进模型视野、也不能被 /skill 启动（命令层报「已关闭」而不是「不存在」）。写开关走 applyEnabledFlag：只改或补 enabled 一行、其余字节原样保留（Pi 的 Skill 只有解析后的 content 与 filePath，没有原始 frontmatter 文本，从它重建会丢未声明字段与注释），找不到可用 frontmatter 块时返回 null 且不落盘；写入经 file_write_atomic 原子替换，随后经指纹入口重载立即生效。读取侧读不到原文时按缺省值（启用）处理并留 warn 痕", why: "删掉总开关后逐项开关是技能唯一的控制面，且必须同时管住披露与显式调用两条路径，否则「关掉的技能还能被启动」", layer: "unit", depth: "deep", scenarios: ["tool-skill-enabled-toggle"] },
    { id: "te-21", feature: "read 图片处理", description: "createReadTool 接 {imageProcessor: readImageProcessor, autoResizeImages: true}：长边超过 MAX_IMAGE_EDGE(1568) 的图等比缩放到长边 ≤1568（只缩不放；resize 为假或本来没超时 scale 为 1、尺寸不变），BMP 不论尺寸都转 PNG，小图且非 BMP 原样直传 —— 阈值、BMP 判定与缩放规则全仓只有这一份实现（Pi 自己不缩放，autoResizeImages 只是它转交处理的开关）。任何处理失败都**回退原图**（解码失败 / 画布不可用 / 2d 上下文不可用 / 编码失败 / 画布未报告实际编码类型），这条路径有意不返回 {ok:false}：Pi 拿到失败只输出一段文本、图片 part 完全消失，用户与模型都会以为这张图不存在；只有连 base64 都编不出来才如实 {ok:false}。成功时带 hints（[BMP 已转为 image/png]、[已缩放 WxH → WxH]）；实际 mime 以 Blob 类型为准（画布不支持请求的编码时会自行产出 PNG，写死请求类型会造出标签与字节不符的图）。注：BMP 在回退路径上按原 mime 直插，完全绕过 1568 约束，是已登记的 WebView 兼容风险。注（可验证性边界）：E2E Scene runner 是 Node 进程，没有 `createImageBitmap`/`OffscreenCanvas`（docs/current/tool-system.md 已登记「当前对图片一律回退原图」）—— 缩放与 BMP 转换当前没有可执行入口；场景把「位图能力不存在」断言成前置，只覆盖回退侧（原字节、原 mime、无提示、{ok:true}），宿主接入真实解码/编码后该前置会失败并提示重写", why: "旧实现在超限或不支持格式时静默省略图片，模型与用户都以为图不存在；「失败也交出原图」是这条覆盖点的核心断言", layer: "e2e", depth: "deep", scenarios: ["tool-read-image-resize"] },
    { id: "te-22", feature: "窗口信息工具", description: "window_info 是 SAFE / os.info 的只读工具（不新增 ActionCategory），只读 window/listener.ts 缓存的最近一次 window-changed 快照，不自己挂监听、不建第二份缓存。三态都返回 success: true 的如实文本：silentAccess.frequency=off → 「未开启」；非 off 档但尚未收到事件 → 「尚未收到窗口变化事件」；有快照 → 三行（窗口标题 / 窗口内容 / 观测时间，空值写「(空)」），观测时间由宿主在收到 payload 时打点（Rust 线上载荷只有 {title, content, is_pet_visible}、不带时间）并格式化为本地时区的分钟精度。缓存写在 off 早退之后，所以关闭监控期间不会写出「有效」的窗口状态；关闭期间旧快照保留但工具入口先查配置，不会把过期 payload 当成当前窗口。注：window/monitor.ts 的停留计时与冷却/暂停（主动搭话触发）不在本点范围；Live 宿主不挂 listener（§8.10），场景只有「未开启」与「未观测到」两侧可断言", why: "新工具不能编造窗口信息，「未开启」与「没有事件」必须各自可辨；缓存与 gate 的顺序决定关闭监控时会不会泄露过期状态", layer: "e2e", depth: "shallow", scenarios: ["tool-window-info-states"] },
    { id: "te-23", feature: "子代理工具面（不派生）", description: "runPiSubAgent 是决策 16「子代理不派生」的剥离点：在 input.tools 上按工具自己声明的 policy.execution.isolation !== 'delegate' 过滤，派生型工具（现为 agent_spawn 与 propose_plan）不下放到子代理，计划步骤与 fork/team 各自传什么都过这一道。判定读策略字段而不是写死名字（写死会把工具身份抄成第二个定义点，也漏掉将来的派生型工具），各调用点不维护第二份名单 —— 同一谓词只在计划步骤的调用点再被读一次（planner.ts 解析 step.allowedTools，把派生型工具判成 missing_tools 硬失败而不是静默剔除），那是准入判定，不是第二份名单。子代理自身的工具面不变：agent/sub-agent.ts 用固定白名单（pi-read + local-system-info + pi-bash）从全部已注册工具里收窄。运行期还有第二道边界：调用只从冻结的工具表里解析，表外的名字一律不执行、只得到一条「不可用」回执；报回的文案按解析层分两种（宿主 beforeTool 按 toolsByName 判，是「工具 <名> 不可用」；Pi 内核的 prepareToolCall 更靠前，子运行的工具面在进 Pi 之前就收窄了，所以子代理硬调 agent_spawn 时是它先挡下，文案是上游的 `Tool \"<名>\" is unavailable`），因此子代理即使吐出 agent_spawn 也不会执行 —— 判定读行为事实（没有执行 + 报告不可用），不绑某一层的中英文案", why: "子代理再派生子代理会让工具面与额度失去上界；剥离必须发生在唯一入口，否则每个调用点都是一份会漂移的白名单", layer: "integration", depth: "deep", scenarios: ["tool-subagent-tool-surface"] },
    { id: "te-24", feature: "MCP 每服务器开关", description: "MCP 的控制面只有每服务器的 enabled（缺省即启用，只有显式 false 才算关闭），总闸 tools.mcp.enabled 已随决策 8 删除：「MCP 是否生效」与「本轮该借用哪些服务器」共用同一份 enabledMcpServerNames()（computeMcpEnabled() 只是它的派生值：至少一个服务器启用），能力准备按它逐个借用、全关时无人可借也就不连接任何服务器。随包默认 `tools.mcp.servers` 只含出厂自带、`enabled: false` 的 github 远程条目（开箱不连接；其余内置清单已整体退役），「零启用 = 不连接」仍是这条出厂口径唯一的可观测结论。本点覆盖运行期口径与注册结果；开关的读取定义点在 config.ts 的类型化 getter（按配置同步清单维护）", why: "「零启用 = 不连接」是出厂口径唯一的可观测结论；enabled 缺省即启用只适用于显式配置的服务器条目", layer: "integration", depth: "shallow", scenarios: ["tool-mcp-server-toggle"] },
    { id: "te-25", feature: "地址前缀唯一性解析", description: "工具结果地址是最短唯一前缀：`shortenAddresses(ids)` 只吃 id 字符串集合（去重、排序，取与相邻 id 的最长公共前缀 +1），不读 seq / 行号 / 输入顺序，下界 `MIN_ADDRESS_PREFIX`(8) 与读取端共用同一语义且是**闭区间**（恰达下界且唯一即受理，短于下界一律不参与前缀匹配）。读取端 `resolveAddressRef` 四态互斥：`exact`（给的正是全集里的完整 id，**优先于前缀扫描**，永远有效）/ `unique` / `ambiguous`（返回全部候选，**绝不任选**）/ `none`。槽上的地址目录 `addressRefs()` 只是纯函数的缓存（D-W2-8）：已发出的前缀仍唯一就沿用、失效才重算，因此缓存值恒等于当次 id 全集上的纯函数结果，旧条目继续占位到不再是全集成员为止。工具侧 `createTranscriptTool` 的 reader 就是 `slot.readToolResult`：歧义映射成 `errorCode: \"ambiguous\"` + 中性诊断文案（带候选），未命中/低于下界映射成 `not_found`，两条路径都不带正文。折叠不敏感：地址的输入里只有 id，而折叠只删已 delete key 的行、不改 id/seq —— 本点只证明「前缀计算对折叠不敏感」这一半，折叠实施后的整链断言（折叠前后发出的地址逐字相同、仍唯一命中同一条结果）由 harness-storage 的 hs-08 场景 `harness-session-log-fold-address` 承接。注：歧义文案的候选截断（最多列 3 条 + 「等 N 条」收口）需要 4 条以上同前缀候选，真实会话造不出，由 T2.04 的直接探针举证，本点场景不做该断言；本点由场景 `地址前缀解析.scene.ts` 覆盖（caseId `tool-address-prefix-resolution`）", why: "前缀一旦任选或过短，模型手里的地址就会读回另一条结果或偶然命中 —— 歧义必须是可见的中性错误而不是随便挑一条；地址又是跨请求反复发给模型的身份，它必须只由 id 集合决定（对折叠、重开、输入顺序都不敏感），否则同一条结果在折叠前后会换地址", layer: "e2e", depth: "deep", scenarios: ["tool-address-prefix-resolution"] },
    { id: "te-27", feature: "工具按回合激活与渐进披露", description: "对话回合默认只激活基础工具（MCP 工具默认不在激活面；唯一判定 defaultActiveToolNames，主对话回合经 lane.setActiveTools 收窄；未激活的已注册工具不进请求 schema）；模型经 enable_tools 取用后在同一回合后续请求生效（Pi 原生 addedToolNames，工具批次落盘时并入激活集）、跨 run 不保留；子代理/计划步骤不收窄（省略 activeToolNames 即全量）；DebugBar 工具读数取实际请求工具面。恢复续跑把中断 running 的工具名并回激活集", why: "MCP 工具 schema 单服务器即可占数千 token，默认面必须收窄，而取用必须可观测、可回退且不跨 run 泄漏", layer: "integration", depth: "deep", scenarios: ["tool-conditional-activation"] },
    { id: "te-28", feature: "工具按需取用（enable_tools）", description: "enable_tools 的默认激活判定（非 MCP 全激活、MCP 默认不激活）、names 精确置名与唯一后缀命中（模型常给 MCP 原始名）、后缀命中多条列候选不任选、空参清单只列未激活工具且启用后移出、query 按名称/描述命中并启用；启用效果经 addedToolNames 声明",
      why: "取用入口是渐进披露的唯一模型通道，取名歧义不能任选、启用效果必须显式声明而不能只改回执文案", layer: "integration", depth: "shallow", scenarios: ["tool-enable-tools"] },
    { id: "te-29", feature: "MCP stdio 真 IPC 端到端", description: "自定义 stdio 服务器（脚本假 server，夹具由场景写出）经生产借用链在真宿主上完成 spawn → initialize 握手 → tools/list 发现 → enable_tools 取用 → tools/call → 结果落条目：工具名只可能来自现场发现（`mcp_probe_echo_probe`），>64KiB 的结果行经 `mcp_read` 整行字符串的既有 blob 物化后与会话条目逐字一致，夹具混入 stdout 的非 JSON 调试行被跳过而不断流", why: "TS↔Rust 参数键接线与巨型行回传此前只有 Rust 单测与记录型假桥覆盖，缺真 IPC 的执行级证据（旧登记的执行级空白）；换 pi-mcp 协议栈后这条链是唯一没被假件替换过的接缝", layer: "e2e", depth: "deep", scenarios: ["tool-mcp-real-ipc-bridge"] },
    // 2026-10-05：自带 MCP 批次新增 te-30（出厂条目 + 连接期凭据注入，L3）。
    { id: "te-30", feature: "MCP 出厂 github 条目与连接期凭据注入", description: "随包 CONFIG.yaml 的 `tools.mcp.servers` 自带 github 远程条目（`https://api.githubcopilot.com/mcp/`，`enabled: false` 开箱不连接；`X-MCP-Readonly: true` 与 `X-MCP-Toolsets: context,repos,issues,pull_requests` 限定只读工具面），经既有 toServerConfig 读法解析为 http 服务器、`${GITHUB_TOKEN}` 引用保留到连接期才展开；默认关闭 = 不在 `enabledMcpServerNames()` 名单里。http 服务器 headers 模板里的 `${VAR}` 在连接前解析：来源优先级 = 本条目 env（最高）→ 应用自有存储（宿主 `mcp_credential_*`，值不写 CONFIG）。env 未命中的名字逐个经 `mcp_credential_get` 取回并入本次展开的临时表（不写回 server.env、不跨连接缓存）；两个来源都取不到时保持变量缺失、由 expandHeaders 抛出点名变量的错误 —— 连接失败如实报出，不静默降级为匿名请求。存储表在记忆库（mcp_credentials），空值拒绝与「状态只回变量名不回值」由 Rust 单测覆盖", why: "凭据不落 CONFIG 后，连接期展开必须有一个明确的来源优先级；任一来源的缺失都不许被悄悄跳过（带着半张 headers 去连第三方端点会以匿名或错误身份发请求），而出厂条目必须开箱不连接（轻量口径不因自带项破例）", layer: "integration", depth: "shallow", scenarios: ["tool-mcp-credential-precedence", "tool-mcp-factory-github-entry"] },
    // 2026-10-06 计划提议工具批次新增 te-32（integration）：模型入口的参数准入与「确认没
    // 成立」的如实归宿（执行相位的契约锚点在 planner 的 pl-13，本点不重复登记那两个 caseId）。
    { id: "te-32", feature: "计划提议工具的参数准入与归宿映射", description: "propose_plan 的参数准入发生在开面板之前：steps 非空、每步至少给出 description 或 title、allowedTools 给了就必须全部可解析且不是派生型工具（isolation=delegate）、步骤数不超过 ai.plan.maxSteps（超出拒绝、不静默截断）；拒绝理由点名到步。被拒绝的提议不开计划确认面板、不落计划记录、不产出进度事件；Schema 层拒绝（steps 空数组）同样不到达面板（工具调用得到错误结果、无确认请求）。确认未成立时工具结果必须如实：用户取消 → 「用户取消了计划确认，未执行任何步骤」，计划记录失败、步骤全 skipped、面板收起 cancelled；面板上报不可用（ui_unavailable 回执）与确认事件发射失败（emit_failed）→ 结果如实说明未执行、计划 interrupted、步骤保持 pending、面板收起；理由文案与 plan-confirmation 的取消原因同源（planConfirmDeclineText），不谎报 [计划执行结果]。系统提示侧的计划提议指引不属本点 —— 只在工具面含 propose_plan 时注入的中性指引（正反两侧）按层拆出为 te-35（unit）", why: "「确认没成立」与「执行过」必须在模型拿到的结果上可分辨，否则模型会把一次不存在的执行转述给用户；准入拒绝必须在开面板之前——否则用户要为一次注定失败的提议点一次面板，而计划记录/进度事件若在拒绝路径上出现，恢复面板会列出从未发生的计划", layer: "integration", depth: "shallow", scenarios: ["plan-tool-user-cancel", "plan-tool-admission-rejects", "plan-tool-schema-reject", "plan-tool-panel-unavailable", "plan-tool-emit-failed"] },
    // 2026-10-06 bash 超时批次新增 te-33（unit）：档位语义钉在零依赖叶子上（L2 可直测）。
    { id: "te-33", feature: "bash 超时夹取语义（默认 = 上限 = 300 秒）", description: "bash 工具的执行窗口固定为默认 = 上限 = 300 秒（`tool/local/bash-timeout.ts` 的 BASH_TOOL_TIMEOUT_MS 是唯一档位定义点）：`clampBashTimeoutArguments` 是模型参数 → 生效超时的唯一夹取点 —— 缺省（undefined / null）补 300（Rust 因此收到显式生效值，不依赖自己的兜底）；有限正数（含数字字符串，按 pi 的数值归一）取 `min(请求值, 300)`；非法值（0 / 负数 / 非数字）原样留下、交 pi 的 validateTimeout 与 schema 校验如实拒绝，不静默替换成默认；只碰 timeout 一个字段，其余参数原样透传。Rust 侧 `DEFAULT_BASH_TIMEOUT_MS` 与 TS 档位同值（由 Rust 单测 `default_bash_timeout_matches_tool_band` 钉本侧字面值；跨语言一致性由 te-34 的下传值与它共同约束）", why: "档位是跨层对齐的锚：缺省注入或上限失效都会让模型不传值时吃 Rust 兜底/被放大执行，重现「5 分钟档被隐藏天花板掐死」的旧故障；把非法值替换成默认则会吞掉模型的参数错误，让错误参数静默执行", layer: "unit", depth: "deep", scenarios: ["tool-bash-timeout-clamp", "tool-bash-timeout-invalid"] },
    { id: "te-34", feature: "bash 生效超时的跨层下传与模型可见口径", description: "注册到生产表的 pi-bash 暴露档位口径并把生效值下传 Rust：`policy.execution.timeoutMs = 300000`（router 的请求视图超时）；工具描述与 `timeout` 参数说明都写明默认/上限 300 秒（覆盖上游「no default timeout」的过时口径 —— 工具描述里的数字必须与实现一致，模型据此决策）；`prepareArguments` 缺省补 300、合法下调原样（45→45）、越界夹取（600→300）。下传：`NativeExecutionEnv.exec` 把秒换算成毫秒交给 `bash_exec`（300→300000；不经 pi-bash 的直调仍传 null，由 Rust 同值兜底接管——旧链路模型不传即 null、Rust 吃自己的 120s 兜底，是 5 分钟档失效的直接原因）。Rust 侧同批实现（bash.rs）：`DEFAULT_BASH_TIMEOUT_MS = 300_000`、spawn 时 `Stdio::null()` 关死 stdin（交互式命令立即 EOF 失败）、命令自成进程组（`process_group(0)`）且超时/取消/宿主退出三处共用 `kill_process_group`（Unix `killpg` 整组回收孙进程、Windows `taskkill /T /F`）——这些行为由 Rust 单测钉住（`bash_timeout_kills_descendants` / `bash_cancel_kills_descendants` / `bash_kill_all_kills_descendants` / `bash_descendant_probe_control_writes_sentinel` / `bash_spawn_creates_own_process_group` / `bash_command_stdin_is_closed` / `default_bash_timeout_matches_tool_band`），Windows 分支本机不可编译、未实机验证（靠 CI）", why: "旧故障的形状正是「生效值只在 Node 侧成立」：策略 300s 挂在 router，但模型不传值时 Rust 吃 120s 兜底、超时只杀直接子进程留下孤儿弹窗。声明、夹取、下传、组回收四段都必须真的接在生产路径上", layer: "integration", depth: "shallow", scenarios: ["tool-bash-timeout-tier", "tool-bash-timeout-registration", "tool-bash-timeout-downlink"] },
    // 2026-10-06 契约刷新（第二轮验收）：te-32 的「提示指引」语义按层拆出为 te-35 ——
    // 两个 caseId 由 test/unit/tool-execution/提议计划提示词.test.ts 携带（unit 层），
    // 留在 te-32（integration）会触发快层校验的层 MISSING / ORPHAN（同层无人认领）。
    { id: "te-35", feature: "计划提议指引随工具面注入系统提示", description: "`buildPrompt` 的工具协议段只在工具面**真的含** propose_plan 时追加中性指引：需要用户确认的多步操作先调用 propose_plan 请求确认、不要用 osascript 或 GUI 弹窗命令等待用户（在场判定读 `@/services/tool` 的 PROPOSE_PLAN_TOOL 常量，不在提示装配处另写一份工具名字符串）；窄工具集 / 子运行（工具面不含该工具）不注入 —— 不该被告知一个不在场的工具。指引是中性系统说明、不是角色台词（与 Card 文案分离，测试用「不含波浪线」一侧钉住）。注：工具自身的参数准入与「确认未成立」的归宿映射在 te-32；工具描述里同源口径的「不要用 GUI 弹窗等待用户」不在本点重复断言", why: "指引的两种坏法都不报错：漏注入会让模型继续用 GUI 弹窗等用户（弹窗被工具超时打断、留下孤儿窗口，2026-10-06 用户实测路径）；无条件注入则让子运行与窄工具集收到一个不在场的工具指令 —— 只有「在场才注入、不在场不注入」两侧都钉住才算接对", layer: "unit", depth: "shallow", scenarios: ["plan-tool-prompt-guidance", "plan-tool-prompt-absent"] },
  ],
  // W0–W7 把本契约迁出 L4 的场景按 L4 侧当前值重标定：门槛=当前 rules 声明值
  // （te-08/10/13/16/17/18/19/21/22/25 留在 L4），只缩不放（数字由 checker 报错提供）；
  // 跨层完整性由 checkLayerCoverage 负责。
  // 2026-10-05：MCP 子系统改造 W2 新增 te-29（L4 deep），门槛 13/11 → 14/12。
  rules: { minScenarios: 14, minDeepScenarios: 12, requireBoundary: true, requireErrorPath: true },
}
