# 当前记忆与会话基础

长期记忆仍通过 `MemoryProvider` 只读端口进入 Runtime，默认返回空集合，召回时限为 1.5 秒。SQLite、自动事实提取、画像候选、纠正/遗忘和 dreaming 属于下一阶段。Card 变量与用户长期事实分别管理。

## 当前文件职责

| 文件 | 当前用途 |
|---|---|
| CANDY.md | 用户手写系统指令 |
| User.md | 重要用户事实的文件视图，作为只读 profile projection 进入上下文 |
| Outside.md | 外部知识指针，不自动成为用户事实 |
| MEMORY.md | 当前长期记忆注册表，尚未迁移到 SQLite |
| Project.md | 会话归档索引（写入链路已随旧格式清理删除） |

这些文件的读取/整理接口仍在 [memory-entries.ts](../../src/services/agent/memory/memory-entries.ts)；接口存在不表示自动链路已接通，不能声称 MemoryService.search() 已自动注入或 forkMemorySupplement() 已被每轮调用。未来 SQLite 迁移的写入与投影边界见 [P6 目标](../plans/active/记忆系统运行时契约.md)。

## 会话真相源

聊天正文以数据根 `sessions/` 的 JSONL 为真相源（JsonlSessionRepo，每会话一个文件，commit 事务写入）；`sessions/index.json` 只保存可丢弃 UI 状态。会话扫描失败会置 `sessionHistoryError` 且不自动建新会话——「读不到」不被伪装成「没有会话」，也不拿空列表覆盖已持久化的标签。条目保存稳定 entryId/seq；工具调用/结果、usage 行与来源标记都落在条目与 usage 记录里——来源按条目形态分字段：用户输入（含空闲发送）在消息上带 `deskpetEventId`（`<requestId>:user` 身份）与 `deskpetSource`（`InputSourceMark`：origin/querySource/priority/taint/eligibleForMemory；`eligibleForMemory=true` 只给用户本人的可信输入），恢复续跑投递的「继续」用 recovery 标记；工具结果在 `details.origin/taint/isError`；主动消息在 `details.*` 且 `eligibleForMemory=false`。没有这两个字段的历史条目按「没有身份 / 没有标记」处理，不猜来源。控制信息用 `deskpet.*` 自定义条目（如 prompt_snapshot、active_message、system_message、plan_checkpoint；`deskpet.compaction_continuation` 记录「压缩续跑在没有宿主回合的情况下已被结算」这一异常收口，供审计追溯；计划证据条目 `deskpet.plan_step_result`、`deskpet.plan_recovery_failed` 与 `deskpet.plan_write_failed` 已登记，均为宿主自定义条目，不进模型消息流，因此不受 `resultProjection`（请求层缩短）与 `historyCompaction`（压缩保留策略）约束）；旧 Markdown 会话格式及其解析代码已删除，旧数据可弃。主动上下文不成为用户事实。

用户 ingress 先落盘再投递（lane 持久 inbox）；工具调用落盘后才执行；结果落盘后才允许下一次 Provider 请求。切换会话、旧代际回调和后台回复都绑定原 session。

## 压缩提交与恢复

压缩由 Harness 调度（阈值 / 手动 `/compact`→`lane.compact()` / 一次性溢出恢复），`/compact` 绑定调用时的会话与运行。宿主硬预算超限同属这条恢复：`transform_context` 的判定由 model-gateway 作为 Provider 响应上报（length 停止、输出 0，命中上游 `isRecoverableLength`），Harness 压缩后带 `overflowRecoveryUsed` 重试一次；超限请求不发给 Provider，判定按当次请求视图重算（网关取走即清空），恢复用尽时按这条判定失败；上游因没有可安全摘要的范围 declined 时，失败分类保留上游文案，回复仍回落这条判定。失败分类（`TurnFailure.kind`）只能从失败文案派生（Harness 把运行失败降维成一条 message），状态码按独立数字匹配，判定文案里的估算 token 数不会把本地预算失败变成 Provider/认证/限流故障；目前只有 Live Test 的 `expectFailure` 与报告按 `kind` 分流。陪伴/助手双模式结构化摘要在 `before_compaction` 钩子内生成——复用 [compactor.ts](../../src/services/engine/compactor.ts) 的摘要内核，经 model-gateway `completePiText` 发送——以 `CompactResult`（summary + retainedTail）返回，由 Harness 单事务提交为 compaction 条目；提交成功前不报告完成，摘要失败或无可覆盖时 decline/报错，切分回合的 turn-prefix 另段摘要。摘要素材的 L0 投影与主请求同口径：`resultProjection=preserve` 的工具结果完整进入摘要请求，只有 `reference` 的会被缩短并留下回读标记；存档条目不受两者影响。压缩调用不计为正常聊天回复，其 usage 落会话 totals 但不进主回合统计；摘要调用的用量按 purpose 单列到用量统计的 `compaction` 分项，与主回合分项相加得到总消耗。

压缩设置（reserve/keepRecent）由 `contextBudget()` 推导并按模型窗口同步，不套用 Pi 默认值（默认窗口下会退化为每个检查点都压缩）；推导值还要经 `toHarnessEstimateTokens()` 换算到 Harness 的计数口径。Harness 的 `shouldCompact` 在会话存在 provider usage 时按真实 usage 计，本仓估算同为目标真实 token 口径，所以换算因子只在「会话已有有效 provider usage **且**尾随消息近似 ASCII」时是 1；纯中文且无 usage 时上游按 `chars/4` 计数，两边相差约 4 倍（该差异由 `provider_usage` 快照的 `tokenDrift` 留痕，见下）。

上下文估算按字符类别分列：ASCII 约 4 字符 1 token、非 ASCII 每 UTF-16 单元约 1 token，**刻意不留余量**——余量已由 `compactionHeadroom` 承担，估算偏差 k 一旦超过 `hardInputLimit` 与 `normalInputTarget` 的比值（该比值随窗口增大逼近 1），硬预算就会先于压缩报错，压缩永远轮不到触发。调整估算常数前先跑 `memory-compaction-threshold-calibration` 场景。

消息估算走唯一的内容投影（`projectMessageContent`，token 估算与快照 `contentHash` 共用）：按角色表覆盖 `compactionSummary` / `branchSummary` / `bashExecution` / `custom`（摘要只计 `summary` 正文、`excludeFromContext` 的 bash 执行计 0，与上游 `convertToLlm` 一致），未知角色按整条消息估算并去重留痕，绝不退化成空串；`usage`、时间戳、模型名与持久化元数据一律不计费。`provider_usage` 阶段的 PromptSnapshot 带 `tokenDrift`（`estimated`/`actual`/`ratio`）：估算与实际 usage 的比值超过 `ESTIMATE_DRIFT_WARN_RATIO`（1.15）时只 `log.warn` 并在 trace 的 `provider_usage` 事件里带出 `driftRatio`，不改变预算判定。

保留窗口只覆盖消息本体、按上游 chars/4 估算，静态提示词占比过大时会出现无可覆盖范围并 decline，因此窗口有下限：默认 `DEFAULT_CONTEXT_WINDOW` 128k、最低 `MIN_CONTEXT_WINDOW` 64k，低于下限时[设置页](../../src/components/SettingsPanel.vue)拒绝保存、运行期在模型解析处报错，不静默跑在坏预算上。上下文 epoch 在快照中等于已提交 compaction 条目数。

原始条目始终保留，压缩只改变请求视图；损坏或无效边界不能授权删除历史。摘要是派生历史数据，不能变成系统指令、权限许可、Card 状态或长期事实。

## 预算与工具大结果

预算由 [context/budget.ts](../../src/services/context/budget.ts) 统一，估算会计入标准化消息和完整工具 schema，不把估算值当成 Provider usage；主请求与一次性文本请求共享输出预留。正常目标在硬输入上限下留 `min(20,000, 16% 窗口)` 余量（极小窗口另有限制）；保留原文尾部和摘要输出各有独立上限。设置中的窗口还受已知模型上限约束。

请求层顺序为 static → dynamic → profile → memory → transcript → ephemeral，稳定静态前缀先放。预算桶比例是 static 12%、tools 8%、dynamic 10%、memory 15%、transcript 50%、ephemeral 5%；profile 计入 dynamic，schema/Skill 清单计入 tools。它们是可借用空闲容量的软配额，不是按百分比强行截字；设置页调整总窗口，比例由预算模块定义。

- L0：请求内缩短大工具结果，保留头尾和 eventId；阈值由 `contextBudget().normalInputTarget × L0_TOOL_RESULT_SHARE`（10%）推导，判定与裁剪都用 token 口径（中文 ≈1 token/字符，头尾各半按 token 切），随窗口单调。工具实际返回的完整文本仍在会话条目，`read_session_event` 按当前会话条目分页读取。Bash 在返回前可能已截断并生成会淘汰的 spill 文件，不能把这些文件等同于持久会话原文；见[工具输出边界](tool-system.md#文件命令与取消)。
- L1：对最旧的连续完整用户意图轮生成结构化摘要。工具批次不能拆开，最后一轮与未完成调用保留；大历史分多次有界提交。
- L2：在无法再安全压缩时保留原文；如果核心输入仍超过硬上限，先走 Harness 的一次性溢出恢复（压缩后重试一次，见上），恢复用尽或没有可摘要范围时才返回可解释的上下文不足错误，不用占位文案伪装压缩成功。

静态 Card、CANDY、完整工具 schema 和当前输入不按字符截断。画像/召回可以整块淘汰并记录预算原因；未被摘要覆盖的 transcript 不得静默删除。`loop.contextCompactAt` 已从默认配置与 getter 移除，旧文件保留该键不影响新预算。

## 请求快照与长期记忆边界

回合冻结与三阶段 PromptSnapshot 由[运行时契约](runtime-contract.md#快照与人格状态)维护。摘要调用不计为正常聊天回复。

`CANDY.md` 是人工指令，`User.md` 通过带来源的只读画像投影进入动态层；两者与摘要分别建块。现有记忆整理接口保留，但应用启动、每五轮和 session 结束不隐式发起记忆 LLM 整理。明确的长期记忆写入闭环在 P6 实施。

当前实现入口为 [harness-slot.ts](../../src/services/engine/pi/harness-slot.ts)（运行与压缩调度）、[compactor.ts](../../src/services/engine/compactor.ts)（摘要内核）、[session/repo.ts](../../src/services/session/repo.ts)（会话仓库）与 [provider.ts](../../src/services/agent/memory/provider.ts)（长期记忆只读端口）；计划 checkpoint 与恢复扫描入口为 [plan-checkpoint-store.ts](../../src/services/agent/memory/plan-checkpoint-store.ts) 与 [runner.ts](../../src/services/agent/runner.ts) 的 `recoverPlanCheckpoints()`，恢复产出的继续/丢弃消费者 `resumePlan`/`discardPlan` 由 [runtime.ts](../../src/services/engine/pi/runtime.ts) 消费。当前验证证据只在[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md#6-当前验证证据)记录。
