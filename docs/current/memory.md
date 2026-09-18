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

聊天正文以数据根 `sessions/` 的 JSONL 为真相源（JsonlSessionRepo，每会话一个文件，commit 事务写入）；`sessions/index.json` 只保存可丢弃 UI 状态。条目保存稳定 entryId/seq；工具调用/结果、usage 行与来源标记都落在条目与 usage 记录里。控制信息用 `deskpet.*` 自定义条目（如 prompt_snapshot、active_message、plan_checkpoint）；旧 Markdown 会话格式及其解析代码已删除，旧数据可弃。主动上下文不成为用户事实。

用户 ingress 先落盘再投递（lane 持久 inbox）；工具调用落盘后才执行；结果落盘后才允许下一次 Provider 请求。切换会话、旧代际回调和后台回复都绑定原 session。

## 压缩提交与恢复

压缩由 Harness 调度（阈值 / 手动 `/compact`→`lane.compact()` / 一次性溢出恢复），`/compact` 绑定调用时的会话与运行。陪伴/助手双模式结构化摘要在 `before_compaction` 钩子内生成——复用 [compactor.ts](../../src/services/engine/compactor.ts) 的摘要内核，经 model-gateway `completePiText` 发送——以 `CompactResult`（summary + retainedTail）返回，由 Harness 单事务提交为 compaction 条目；提交成功前不报告完成，摘要失败或无可覆盖时 decline/报错，切分回合的 turn-prefix 另段摘要。压缩调用不计为正常聊天回复，其 usage 落会话 totals 但不进主回合统计（purpose 单列属 PI-4）。

压缩设置（reserve/keepRecent）由 `contextBudget()` 推导并按模型窗口同步，不套用 Pi 默认值（默认窗口下会退化为每个检查点都压缩）。保留窗口只覆盖消息本体、按 chars/4 估算，静态提示词占比过大时会出现无可覆盖范围并 decline，因此窗口有下限：默认 `DEFAULT_CONTEXT_WINDOW` 128k、最低 `MIN_CONTEXT_WINDOW` 64k，低于下限时[设置页](../../src/components/SettingsPanel.vue)拒绝保存、运行期在模型解析处报错，不静默跑在坏预算上。上下文 epoch 在快照中等于已提交 compaction 条目数。

原始条目始终保留，压缩只改变请求视图；损坏或无效边界不能授权删除历史。摘要是派生历史数据，不能变成系统指令、权限许可、Card 状态或长期事实。

## 预算与工具大结果

预算由 [context/budget.ts](../../src/services/context/budget.ts) 统一，估算会计入标准化消息和完整工具 schema，不把估算值当成 Provider usage；主请求与一次性文本请求共享输出预留。正常目标在硬输入上限下留 `min(20,000, 16% 窗口)` 余量（极小窗口另有限制）；保留原文尾部和摘要输出各有独立上限。设置中的窗口还受已知模型上限约束。

请求层顺序为 static → dynamic → profile → memory → transcript → ephemeral，稳定静态前缀先放。预算桶比例是 static 12%、tools 8%、dynamic 10%、memory 15%、transcript 50%、ephemeral 5%；profile 计入 dynamic，schema/Skill 清单计入 tools。它们是可借用空闲容量的软配额，不是按百分比强行截字；设置页调整总窗口，比例由预算模块定义。

- L0：请求内缩短大工具结果，保留头尾和 eventId；工具实际返回的完整文本仍在会话条目，`read_session_event` 按当前会话条目分页读取。Bash 在返回前可能已截断并生成会淘汰的 spill 文件，不能把这些文件等同于持久会话原文；见[工具输出边界](tool-system.md#文件命令与取消)。
- L1：对最旧的连续完整用户意图轮生成结构化摘要。工具批次不能拆开，最后一轮与未完成调用保留；大历史分多次有界提交。
- L2：在无法再安全压缩时保留原文；如果核心输入仍超过硬上限，返回可解释的上下文不足错误，不用占位文案伪装压缩成功。

静态 Card、CANDY、完整工具 schema 和当前输入不按字符截断。画像/召回可以整块淘汰并记录预算原因；未被摘要覆盖的 transcript 不得静默删除。`loop.contextCompactAt` 已从默认配置与 getter 移除，旧文件保留该键不影响新预算。

## 请求快照与长期记忆边界

回合冻结与三阶段 PromptSnapshot 由[运行时契约](runtime-contract.md#快照与人格状态)维护。摘要调用不计为正常聊天回复。

`CANDY.md` 是人工指令，`User.md` 通过带来源的只读画像投影进入动态层；两者与摘要分别建块。现有记忆整理接口保留，但应用启动、每五轮和 session 结束不隐式发起记忆 LLM 整理。明确的长期记忆写入闭环在 P6 实施。

当前实现入口为 [harness-slot.ts](../../src/services/engine/pi/harness-slot.ts)（运行与压缩调度）、[compactor.ts](../../src/services/engine/compactor.ts)（摘要内核）、[session/repo.ts](../../src/services/session/repo.ts)（会话仓库）与 [provider.ts](../../src/services/agent/memory/provider.ts)（长期记忆只读端口）。历史验证证据只在[执行手册](../plans/active/记忆系统重构执行手册.md)记录。
