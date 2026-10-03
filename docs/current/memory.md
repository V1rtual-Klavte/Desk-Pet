# 当前记忆与会话基础

长期记忆由 Rust 侧 SQLite（`数据根/memory/memory.sqlite3`）承载，经 `MemoryProvider` 只读端口进入 Runtime。召回是「本地检索 + 可关闭的 adaptive 重排」两段：本地结果先算出来并随时可用，重排失败、超时或被取消都退回同一份本地顺序。召回文本按 `estimateContextTokens` 裁剪并在超配时显式标记（不用「4 字符 = 1 token」的通吃常数）。Card 变量与用户长期事实分别管理。

## 记忆的五层与两条链路

| 层 | 承载 |
|---|---|
| 真相层 | `sessions/` 的 JSONL 会话正文，永久保留、不迁移、不替代 |
| 记忆层 | Rust SQLite：已接受条目 + 来源 + 治理记录 + 可重建的 FTS5 索引 |
| 投影层 | `memory/exports/` 下的只读 Markdown；模型不能直接写 |
| 作业层 | dreaming（Light → Review → 自动 Publish），离线整理只在事务提交前短暂保留候选 |
| 端口层 | `MemoryProvider` 是唯一召回入口，连核心画像也走它 |

记忆语义分四类：核心画像（用户确认并置顶的称呼与稳定偏好）、事实/偏好、经历、短期事项（带有效期，到期自动退出召回）。`kind = fact | preference | episode | working`，`scope = user | card | session`。

**准入判据是「谁说的」**：只有 `origin=user` + `taint=trusted_user` + `eligibleForMemory=true` 的已提交条目能成为候选。助手台词、工具结果、压缩摘要、主动搭话与缺来源标记的历史条目一律出局 —— 它们都可能又长又具体，但没有一条能证明是用户本人说的。投递时刻冻结的 `cardId` 随来源落盘，事后不从「当前正在显示的 Card」反推。

**检索链路**：同一库版本下先过滤 scope、状态、有效期与遗忘 → 本地合并 FTS5 trigram、主题/别名与**短词 LIKE 回退**（FTS命中集合只计算一次，按条目id与版本精确关联） → 顺序为「本地候选 → 可选重排 → 按预算取全文」。FTS5 trigram 的 `MATCH` 不匹配少于三个 Unicode 字符的查询（「咖啡」这类两字词在它下面恒零命中），所以两字中文查询靠短词回退兜住。重排只接收 id 与一行摘要，只能返回候选白名单内的 id；未知 id、坏 JSON、散文一律判无效并回退本地顺序。

**请求落位**：核心画像与动态召回合成一个记忆块，作为**尾随 custom 消息**贴在请求视图末尾（不是 system prompt）：记忆每回合都可能变，留在 system prompt 里会把前缀缓存断在会话正文上游。记忆块带 `eligibleForMemory=false`，因此召回内容不会被下一轮整理当成用户新事实重新提取。额度先按「当前视图已用量」算出真实可用量，再逐条按预算追加；空间不足只丢可选记忆并记录 `budgetDrops`，不截断块内文字。

## 记忆库的治理不变量

- **一次写入一个事务**：条目/版本、来源关联、FTS 与 revision 一起提交，失败全回滚，不对 UI 报成功。
- **operation_id 幂等**：提交结果未知时先查这条操作记录，绝不盲重放。
- **基准版本**：写入与发布都带 `baseRevision`，不匹配返回 `MEMORY_CONFLICT`，由调用方重新读取后再决定；不静默覆盖。
- **候选隔离**：Review 的产物先落为 `prepared`，不进 FTS、不进召回；作业完成时由 `memory_dreaming_commit` 复核来源、版本、hash、遗忘代并在单事务内将候选变成 `accepted`、生成的记忆条目写为 `active`。用户面板不提供人工发布门，只做提交后的查看、纠正与遗忘。
- **遗忘闭包**：遗忘写 `memory_tombstones`（稳定事件身份 session+entry+content_hash），同时清正文、FTS 与候选，并递增 `forget_epoch`。之后**索引重建、旧水位补扫、旧批次发布都不会让内容复活**；抑制匹配的是稳定身份而不是可重建的行号。
- **范围隔离**：`card` 范围的记忆绑定 Card id（外观 Profile 切换不改变归属）；跨 scope 不隐式 supersede。
- **删除范围分开讲**：「记住/忘记」只清应用管理的记忆与它的回灌资格；原始聊天正文、已导出的文件和外部备份各自有独立的删除入口，界面必须分别说明。当前会话正文里仍然存在的被忘内容无法追回，不能宣称模型已经完全不知道。

## 显式写入与整理

模型写入只经 `memory_change` 工具（`local_mutation` / `exclusive_effect` / `replay: never`，继续由 PermissionKernel 终裁）：工具只接受本轮已提交可信用户事件，宿主绑定来源、目标版本与库版本后直接提交；不存在另起的人工发布确认 UI。只读查询走 `memory_query`（`shared_read`，结果 `preserve`）。

自然语言显式写入不等待下一轮 dreaming；成功的判据是 Rust 返回的已提交 revision，而不是模型说「记住了」。本回合写过记忆时，**下一次请求前会重新召回一次** —— 用户刚纠正的事实要在同一回合的下一次请求里生效。

dreaming 分三阶段：Light 固定输入范围（来源登记 + 水位）、Review 产出带证据引用的 `prepared` 候选、Publish 在复核来源/版本/抑制后单事务提交。每批来源数与正文长度有界，单条过大整条跳过交给用户挑选片段，不做静默截断；模型来源 id 必须落在本批内，否则整条丢弃。单次 Review 的模型输出上限由 `ai.memory.dreaming.reviewMaxTokens` 配置（默认 1200）——reasoning 模型的 thinking 也计入该预算，用推理模型时应调大，否则批次会以「输出达到长度上限」如实失败。运行入口支持手动整理；显式开启 `idle` 后，启动的空闲调度器按空闲阈值、最小间隔和每日模型预算触发 Review，并在作业完成时自动 Publish。每日用量写入 Rust 作业账本，重启后沿用同一自然日的已用量与租约状态。

## 当前文件职责

| 文件 | 当前用途 |
|---|---|
| V1RTUAL.md | 用户手写系统指令（人工入口，不是记忆数据） |
| memory.sqlite3 | 已接受记忆、来源与治理决定的真相源（Rust 管理） |
| exports/ | 只读 Markdown 投影，不可回写 |
| backups/ | 一致性备份（走 SQLite 备份接口，不复制写入中的主文件） |

旧的 MEMORY.md / User.md / Outside.md / Project.md 注册表**不再创建、不再读取**：记忆主路径已换成 SQLite。磁盘上的旧文件保持原样，由用户自行决定是否清理；没有隐式回退到旧文件的路径。

## 会话真相源

聊天正文以数据根 `sessions/` 的 JSONL 为真相源（JsonlSessionRepo，每会话一个文件，commit 事务写入；写入以追加为主）。已删除 key 的写入行由折叠回收（纯删除式重写：只删每个 key 最后一次 `list/delete` / `value/delete` 之前的 `list/append` / `value/set` 写入行，不重编号、不重写保留行、不改逻辑状态；原子替换 + 折叠前后状态 hash 校验，不一致就放弃折叠、保留原文件；`storageVersion` 不匹配则跳过）；折叠只改变文件的物理行数，不改变会话正文的真相源地位。折叠的触发时机：`releasePiSession` 句柄关闭之后（主路径）+ `open` 前按需（兜底，仅当文件超过 `FOLD_POLICY.minFileBytes`）；三阈值 `minFileBytes` 512 KiB / `minReclaimBytes` 128 KiB / `minReclaimRatio` 0.15（三者 AND）。`sessions/index.json` 只保存可丢弃 UI 状态。会话扫描失败会置 `sessionHistoryError` 且不自动建新会话——「读不到」不被伪装成「没有会话」，也不拿空列表覆盖已持久化的标签。条目保存稳定 entryId/seq；工具调用/结果、usage 行与来源标记都落在条目与 usage 记录里——来源按条目形态分字段：用户输入（含空闲发送）在消息上带 `deskpetEventId`（`<requestId>:user` 身份）与 `deskpetSource`（`InputSourceMark`：origin/querySource/priority/taint/eligibleForMemory；`eligibleForMemory=true` 只给用户本人的可信输入），恢复续跑投递的「继续」用 recovery 标记；工具结果在 `details.origin/taint/isError`（工具来源的 taint 记为 `untrusted_external`）；主动消息在 `details.*`（requestId/rawText/normalizedText/querySource/priority/taint/visibleToUser/eligibleForTranscript/eligibleForMemory）且 `eligibleForMemory=false`。没有这两个字段的历史条目按「没有身份 / 没有标记」处理，不猜来源。两类 `deskpet.*` 要分清：**message 条目**（`role:"custom"` 的 AgentMessage，如主动搭话 `deskpet.active_message`——它是正文条目，会进 `buildSessionContext`）与 **custom 条目**（`appendCustomEntry` 写入的控制信息，如 `deskpet.prompt_snapshot`、`deskpet.system_message`、`deskpet.plan_checkpoint`——`sessionEntryToContextMessages` 对 `type:"custom"` 返回空，只有注册了 `entryProjectors` 才会投影）。**不要把主动搭话改成 custom 条目**：宿主不注册 projector，改过去会被静默丢弃。custom 条目里，`deskpet.prompt_rewrite` 记录一次提示词派生的输入/输出 hash 与派生来源（压缩摘要写 `compaction_summary`，附压缩条目地址），只留 hash 不落派生正文，也不进模型消息流；`deskpet.compaction_continuation` 记录「压缩续跑在没有宿主回合的情况下已被结算」这一异常收口，`deskpet.compaction_declined` 记录宿主摘要内核失败导致的压缩降级（含 status/reason/error），`deskpet.recall_failed` 记录 MemoryProvider 召回抛错后按空召回继续的降级（含 requestId/error/at），两者都供审计追溯；计划证据条目 `deskpet.plan_step_result`、`deskpet.plan_recovery_failed` 与 `deskpet.plan_write_failed` 已登记，均为宿主自定义条目，不进模型消息流，因此不受 `resultProjection`（请求层缩短）与 `historyCompaction`（压缩保留策略）约束）。宿主不提供 `toProviderMessages` 与 `entryProjectors`，走上游默认投影（`convertToLlm` 把 `custom` 投影为 user，`deskpetEventId` 不泄漏）——这是有意的边界，不是缺口；要改条目类型或投影语义必须同时改契约与场景。`resources.skills` 已由宿主下发（装配 lane 时用启用清单调 `setResources`）：它只服务 Pi 的技能准入（`/skill`）与披露来源，不写会话条目，也不把技能正文投影进请求。旧 Markdown 会话格式及其解析代码已删除，旧数据可弃。主动上下文不成为用户事实。

用户 ingress 先落盘再投递（lane 持久 inbox）；工具调用落盘后才执行；结果落盘后才允许下一次 Provider 请求。切换会话、旧代际回调和后台回复都绑定原 session。

## 压缩提交与恢复

压缩由 Harness 调度（阈值 / 手动 `/compact`→`lane.compact()` / 一次性溢出恢复），`/compact` 绑定调用时的会话与运行。宿主硬预算超限同属这条恢复：`transform_context` 的判定由 model-gateway 作为 Provider 响应上报（length 停止、输出 0，命中上游 `isRecoverableLength`），Harness 压缩后带 `overflowRecoveryUsed` 重试一次；超限请求不发给 Provider，判定按当次请求视图重算（网关取走即清空），恢复用尽时按这条判定失败；上游因没有可安全摘要的范围 declined 时，失败分类保留上游文案，回复仍回落这条判定。失败分类（`TurnFailure.kind`）除 `admission` 外只能从失败文案派生（Harness 把运行失败降维成一条 message）；`admission` 由调用点写入（回合准入拒绝、lane 结构操作在飞），分类函数不返回它。状态码按独立数字匹配，判定文案里的估算 token 数不会把本地预算失败变成 Provider/认证/限流故障；目前只有 Live Test 的 `expectFailure` 与报告按 `kind` 分流。结构化摘要在 `before_compaction` 钩子内生成——复用 [compactor.ts](../../src/services/engine/compactor.ts) 的摘要内核，经 model-gateway `completePiText` 发送——以 `CompactResult`（summary + retainedTail）返回，由 Harness 单事务提交为 compaction 条目；提交成功前不报告完成，摘要失败或无可覆盖时 decline/报错：宿主摘要内核失败走显式 decline（钩子内 catch 后返回 decline，不把上游通用英文摘要落进历史）+ 可见失败（`/compact` 报当前 Card 的 `commands.compactFailed` 并附上技术原因、`compactActiveSession` 返回 `failed`）+ 一条 `deskpet.compaction_declined` 审计条目（`{status, reason, error, endedAt}`），切分回合的 turn-prefix 另段摘要。摘要素材的 L0 投影与主请求同口径（同一个 `projectToolResultText`，回读地址同样只认 `details.deskpetEntryId`）：`resultProjection=preserve` 的工具结果完整进入摘要请求，只有 `reference` 的会被缩短并留下回读标记；没有回读地址的结果不写假 eventId，改标「该结果的原始条目没有回读地址，中间段不可恢复」；存档条目不受两者影响。压缩调用不计为正常聊天回复，其 usage 落会话 totals 但不进主回合统计；摘要调用的用量按 purpose 单列到用量统计的 `compaction` 分项，与主回合分项相加得到总消耗。`historyCompaction=retain` 维持保留（不删）：生产工具全部声明 `summarize`，`retain` 在生产路径无消费者，是按声明保留原文配对的能力预留，由 `memory-retain-guard` 场景驱动。

压缩设置（reserve/keepRecent）由 `contextBudget()` 推导并按模型窗口同步，不套用 Pi 默认值（默认窗口下会退化为每个检查点都压缩）；推导值还要经 `toHarnessEstimateTokens()` 换算到 Harness 的计数口径。Harness 的 `shouldCompact` 比的是它自己的 `estimateContextTokens`：有 provider usage 时前缀按真实 usage 计，本仓预算同为目标真实 token 口径，因此换算因子**恒为 1**（`toHarnessEstimateTokens()` 现为恒等函数，不要再按 `chars/4` 反推因子）；纯中文且无 usage 时上游仍按 `chars/4` 计数，两边相差约 4 倍（该差异由 `provider_usage` 快照的 `tokenDrift` 留痕，见下）。

上下文估算按字符类别分列：ASCII 约 4 字符 1 token、非 ASCII 每 UTF-16 单元约 1 token，**刻意不留余量**——余量已由 `compactionHeadroom` 承担，估算偏差 k 一旦超过 `hardInputLimit` 与 `normalInputTarget` 的比值（该比值随窗口增大逼近 1），硬预算就会先于压缩报错，压缩永远轮不到触发。调整估算常数前先跑 `memory-compaction-threshold-calibration` 场景。

消息估算走唯一的内容投影（`projectMessageContent`，token 估算与快照 `contentHash` 共用）：按角色表覆盖 `compactionSummary` / `branchSummary` / `bashExecution` / `custom`（摘要只计 `summary` 正文、`excludeFromContext` 的 bash 执行计 0，与上游 `convertToLlm` 一致），未知角色按整条消息估算并去重留痕，绝不退化成空串；`usage`、时间戳、模型名与持久化元数据一律不计费。`provider_usage` 阶段的 PromptSnapshot 带 `tokenDrift`（`estimated`/`actual`/`ratio`）：估算与实际 usage 的比值超过 `ESTIMATE_DRIFT_WARN_RATIO`（1.15）时只 `log.warn` 并在 trace 的 `provider_usage` 事件里带出 `driftRatio`，不改变预算判定。

保留窗口只覆盖消息本体、按上游 chars/4 估算，静态提示词占比过大时会出现无可覆盖范围并 decline，因此窗口有下限：默认 `DEFAULT_CONTEXT_WINDOW` 128k、最低 `MIN_CONTEXT_WINDOW` 64k，低于下限时[设置页](../../src/components/settings/SettingsPanel.vue)拒绝保存、运行期在模型解析处报错，不静默跑在坏预算上；模型解析处的下限错误会指出模型 id 与配置窗口取小的关系（该值来自模型目录的已知窗口与配置取小），引导用户换窗口更大的模型，而不是去改一个本来合法的配置值。上下文 epoch 在快照中等于**本会话 lane 分支上**已提交的 compaction 条目数，唯一定义点是 `engine/harness/delivery.ts` 的 `readContextEpoch`（槽快照、请求快照与设置页显示共用它），读不到时快照不写该字段（未知不等于 0）。

原始条目始终保留，压缩只改变请求视图；折叠不是删除历史（只回收已删除 key 的写入行，entry/usage 行一个不动），损坏或无效边界不能授权删除历史。摘要是派生历史数据，不能变成系统指令、权限许可、Card 状态或长期事实。

## 预算与工具大结果

预算由 [context/budget.ts](../../src/services/context/budget.ts) 统一，估算会计入标准化消息和完整工具 schema，不把估算值当成 Provider usage；主请求与一次性文本请求共享输出预留。正常目标在硬输入上限下留 `min(20,000, 16% 窗口)` 余量（极小窗口另有限制）；保留原文尾部和摘要输出各有独立上限。设置中的窗口还受已知模型上限约束。

请求层顺序为 static → dynamic → profile → memory → transcript → ephemeral，稳定静态前缀先放。预算桶比例是 static 12%、tools 8%、dynamic 10%、memory 15%、ephemeral 5%（**transcript 不再有份额** —— 请求视图由 Harness 从已提交条目重建、内核看不到消息 —— 只保留审计行而 `assigned` 按 0 计，因此合计不再是 100%）；profile 计入 dynamic，schema/Skill 清单计入 tools。它们是可借用空闲容量的软配额，不是按百分比强行截字；设置页调整总窗口，比例由预算模块定义。

- L0：请求内缩短大工具结果（保留头尾和 eventId），阈值由 `contextBudget().normalInputTarget × L0_TOOL_RESULT_SHARE`（10%）推导，判定与裁剪都用 token 口径（中文 ≈1 token/字符，头尾各半按 token 切），随窗口单调。**无条件带地址**：不论是否超阈值，每条工具结果在请求视图里都带回读地址（未缩短的正文也附地址尾行；`preserve` 只挡升档处理、不挡地址标注）；无地址的在缩短/清空时用 `L0_NO_ADDRESS_NOTICE` 变体（正文未被改动时不加提示，不写假 eventId），且同一内容只留痕一次（键是「长度:首 32 字符」的内容指纹，有界集合上限 64、FIFO 淘汰最旧）。**阶梯**：级 0 不动 / 级 1 缩短 / 级 2 清空；级 2 的硬前提是有地址（无地址永停级 1）；保护区 `LADDER_PROTECTION_TURNS = 3` 按用户意图轮计（user/`bashExecution` 开轮，toolResult/assistant/custom/compactionSummary 不开轮；不足 3 轮全保护，`turns <= 0` 才关保护区），只挡级 2/级 3、不挡级 1。**回读分页改 token 口径**：`read_session_event` 的页大小与 L0 同源推导（`toolResultTokenBudget(window)`）、随窗口单调，不再是固定 8000 字符常数。级 3（摘要）前的闸门只在 `reason === "threshold"` 且级 1/2 压完装得下时 decline（不花摘要调用）；生产路径上目前由前置守卫（摘要范围为空）先拦截，闸门自身的 decline 分支不可达、不构成用户可见行为。Bash 在返回前可能已截断并生成会淘汰的 spill 文件，不能把这些文件等同于持久会话原文；见[工具输出边界](tool-system.md#文件命令与取消)。
- L1：整段摘要。切分范围不由本仓决定：「最旧的连续完整用户意图轮、工具批次不拆、保留窗口」都是上游 `findCutPoint` 的执行结果（`@earendil-works/pi-agent-core` 的 `harness/compaction/compaction.js`）；宿主只提供摘要内核（`before_compaction`，[compactor.ts](../../src/services/engine/compactor.ts)）与提交后的可解释结果。切分回合时上游把当前未完成回合的前半段单列（`turnPrefixMessages`），宿主用 `SPLIT_TURN_INSTRUCTION` 另段摘要。素材超硬上限时切成 K 片，逐片串行调摘要、以 `previousSummary` 迭代合并，最终一次提交一份摘要（提交仍只有一次）；片数上限 `MAX_COMPACTION_SLICES = 8`，超上限或存在不可再分且自身超硬上限的片段则 `CompactionOverflowError`（`code = "COMPACTION_MATERIAL_OVER_CAP"`）明确失败——零请求、零提交，不存在静默丢弃。
- L2：在无法再安全压缩时保留原文；如果核心输入仍超过硬上限，先走 Harness 的一次性溢出恢复（压缩后重试一次，见上），恢复用尽或没有可摘要范围时才返回可解释的上下文不足错误，不用占位文案伪装压缩成功。

静态 Card、V1RTUAL、完整工具 schema 和当前输入不按字符截断。画像/召回可以整块淘汰并记录预算原因（淘汰结果进快照的 `budgetDrops`，见[运行时契约](runtime-contract.md#快照与人格状态)）；未被摘要覆盖的 transcript 不得静默删除。`loop.contextCompactAt` 已从默认配置与 getter 移除，旧文件保留该键不影响新预算。

## 请求快照与长期记忆边界

回合冻结与三阶段 PromptSnapshot 由[运行时契约](runtime-contract.md#快照与人格状态)维护（审计条目的入队与 `flushAudit()` 的落盘边界同见该节）。摘要调用不计为正常聊天回复，但摘要请求同样进快照体系：有会话归属的一次性调用写 payload 与 usage 两档快照（`one-shot:<purpose>` 身份、`request.step = "compaction"`），压缩成功后另写一条 `deskpet.prompt_rewrite`（`compaction_summary`，只含输入/输出 hash、运行来源与压缩条目地址，压缩正文与素材都不落盘）。

`V1RTUAL.md` 是人工指令，与摘要分别建块；用户画像不再有独立文件，它就是记忆库里置顶的条目。应用启动、每五轮与 session 结束都不隐式发起记忆整理：整理只能由记忆面板手动触发（或在用户显式开启 idle 整理后按空闲条件运行），作业完成后自动提交合格候选，失败/冲突/取消保持明确终态。

当前实现入口为 [harness-slot.ts](../../src/services/engine/harness/harness-slot.ts)（运行与压缩调度）、[compactor.ts](../../src/services/engine/compactor.ts)（摘要内核）、[session/repo.ts](../../src/services/session/repo.ts)（会话仓库）、[memory/](../../src/services/agent/memory/)（召回端口、来源收集、dreaming）、[instructions/](../../src/services/context/instructions/)（V1RTUAL）、[src-tauri/src/memory/](../../src-tauri/src/memory/)（SQLite 存储与治理命令）、[tool-output.ts](../../src/services/context/tool-output.ts)（L0 工具结果投影与回读地址）与 [delivery.ts](../../src/services/engine/harness/delivery.ts)（投递证据与上下文 epoch）；计划 checkpoint 与恢复扫描入口为 [checkpoint-store.ts](../../src/services/engine/plan/checkpoint-store.ts) 与 [runner.ts](../../src/services/agent/runner.ts) 的 `recoverPlanCheckpoints()`，恢复产出的继续/丢弃消费者 `resumePlan`/`discardPlan` 由 [runtime.ts](../../src/services/engine/harness/runtime.ts) 消费。

## 质量与资源证据

记忆质量跑批、独立审阅门禁与 release 存储/debug IPC 性能脚本已接入[测试入口](../../test/README.md#trace记忆质量与性能门禁)。质量数据集目前是待人工审计的合成标注草案；实际注入证据取请求预算裁剪后的 rendered IDs，提取与回答分开评分，无记忆/本地/always/adaptive/gold evidence 逐 cell 重建库并配对。采集完成不等于质量通过，缺审阅与缓存计数不能补成成功或零成本。

完整性/治理零失败、语义质量、重排收益与资源门槛分别判定，结果和未验证边界只在[未完成工作总表](../plans/active/未完成工作与已知缺口.md#3-长期记忆-b-方案已实施剩余验证边界)维护。当前尚不能宣称 adaptive 已带来收益；真实设置窗口、Windows 和 release UI/IPC 证据也不能由 Node 单测替代。
