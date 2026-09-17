# 当前记忆与会话基础

长期记忆仍通过 `MemoryProvider` 只读端口进入 Runtime，默认返回空集合，召回时限为 1.5 秒。SQLite、自动事实提取、画像候选、纠正/遗忘和 dreaming 属于下一阶段。Card 变量与用户长期事实分别管理。

## 当前文件职责

| 文件 | 当前用途 |
|---|---|
| CANDY.md | 用户手写系统指令 |
| User.md | 重要用户事实的文件视图，作为只读 profile projection 进入上下文 |
| Outside.md | 外部知识指针，不自动成为用户事实 |
| MEMORY.md | 当前长期记忆注册表，尚未迁移到 SQLite |
| Project.md | 会话归档索引；正文仍以 sessions/*.md 为准 |

这些文件的读取/整理接口仍在 [memory-entries.ts](../../src/services/agent/memory/memory-entries.ts)；接口存在不表示自动链路已接通，不能声称 MemoryService.search() 已自动注入或 forkMemorySupplement() 已被每轮调用。未来 SQLite 迁移的写入与投影边界见 [P6 目标](../plans/active/记忆系统运行时契约.md)。

## 会话真相源

`sessions/*.md` 保存完整正文、工具调用/结果和控制事件；`sessions/index.json` 只保存可丢弃 UI 状态。新增正文以一条 `deskpet-event` 保存完整 `Message`，预览不参与重放，兼容旧 `deskpet-turn` 和纯预览。`appendSequence` 按同一会话写锁下的落盘顺序递增；实际 Pi 工具调用与结果保存同一 `apiRoundId`、call ID、错误标记和来源。主动上下文不成为用户事实。

调用事件落盘后才准许执行工具；结果落盘后才允许下一次 Provider 请求。异步订阅通过回合内写队列收敛，写入失败阻止继续执行。归档只更新元数据，不再用内存文本重建文件。切换会话、旧代际回调和后台回复都绑定原 session。

## 压缩提交与恢复

`compactSession()` 返回 `committed / skipped / stale / failed`，只有 `committed` 显示完成。`/compact` 固定调用时的 session 和 generation；自动压缩在首次请求前及 Pi `transformContext` 中执行，不在每轮回复后启动后台 LLM。

当前使用项目自建压缩器。安装的 Pi Agent Core 0.85.1 已公开压缩算法，但基础 Agent 不自动调度它们；Harness 的自动压缩也未接入。逐请求 usage 校准、按工具声明投影/保留与长轮次切分属于[后续方案](../plans/active/Pi运行时与工具协议建设方案.md#7-压缩算法的渐进复用)，不能把目标切分规则当作现有 checkpoint 允许的行为。

检查点保存：结构化 summary、连续 `coveredEventIds`、`keepFromEventId`、输入/输出 hash、前一个检查点、context epoch、来源 revision、session version、run generation。提交前校验完整轮边界及 hash，写入时再次 CAS；摘要与检查点由同一 `session_file_write_atomic` 原子提交。取消在进入提交前使结果失效；进入原子写入后属于已开始的提交，不尝试删除或回滚已写入事实。

重载时从完整事件重建并验证检查点链，只有有效覆盖前缀会从模型请求视图中移除。损坏或无效边界不能授权删除历史。原始文件始终保留，旧格式也可参与新检查点。摘要是派生历史数据，不能变成系统指令、权限许可、Card 状态或长期事实。

## 预算与工具大结果

预算由 [context/budget.ts](../../src/services/context/budget.ts) 统一，估算会计入标准化消息和完整工具 schema，不把估算值当成 Provider usage；主请求与一次性文本请求共享输出预留。正常目标在硬输入上限下留 `min(20,000, 16% 窗口)` 余量（极小窗口另有限制）；保留原文尾部和摘要输出各有独立上限。设置中的窗口还受已知模型上限约束。

请求层顺序为 static → dynamic → profile → memory → transcript → ephemeral，稳定静态前缀先放。预算桶比例是 static 12%、tools 8%、dynamic 10%、memory 15%、transcript 50%、ephemeral 5%；profile 计入 dynamic，schema/Skill 清单计入 tools。它们是可借用空闲容量的软配额，不是按百分比强行截字；设置页调整总窗口，比例由预算模块定义。

- L0：请求内缩短大工具结果，保留头尾和 eventId；工具实际返回的完整文本仍在会话，`read_session_event` 按当前会话分页读取。Bash 在返回前可能已截断并生成会淘汰的 spill 文件，不能把这些文件等同于持久会话原文；见[工具输出边界](tool-system.md#文件命令与取消)。
- L1：对最旧的连续完整用户意图轮生成结构化摘要。工具批次不能拆开，最后一轮与未完成调用保留；大历史分多次有界提交。
- L2：在无法再安全压缩时保留原文；如果核心输入仍超过硬上限，返回可解释的上下文不足错误，不用占位文案伪装压缩成功。

静态 Card、CANDY、完整工具 schema 和当前输入不按字符截断。画像/召回可以整块淘汰并记录预算原因；未被摘要覆盖的 transcript 不得静默删除。`loop.contextCompactAt` 已从默认配置与 getter 移除，旧文件保留该键不影响新预算。

## 请求快照与长期记忆边界

回合冻结与三阶段 PromptSnapshot 由[运行时契约](runtime-contract.md#快照与人格状态)维护。摘要调用不计为正常聊天回复。

`CANDY.md` 是人工指令，`User.md` 通过带来源的只读画像投影进入动态层；两者与摘要分别建块。现有记忆整理接口保留，但应用启动、每五轮和 session 结束不隐式发起记忆 LLM 整理。明确的长期记忆写入闭环在 P6 实施。

当前实现入口为 [session-files.ts](../../src/services/agent/memory/session-files.ts)、[compaction-store.ts](../../src/services/agent/memory/compaction-store.ts)、[compactor.ts](../../src/services/engine/compactor.ts) 和 [provider.ts](../../src/services/agent/memory/provider.ts)。历史验证证据只在[执行手册](../plans/active/记忆系统重构执行手册.md)记录。
