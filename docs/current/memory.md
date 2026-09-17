# 当前记忆与会话基础

长期记忆仍通过 `MemoryProvider` 只读端口进入 Runtime，默认返回空集合，召回时限为 1.5 秒。SQLite、自动事实提取、画像候选、纠正/遗忘和 dreaming 属于下一阶段。Card 变量与用户长期事实分别管理。

## 会话真相源

`sessions/*.md` 保存完整正文、工具调用/结果和控制事件；`sessions/index.json` 只保存可丢弃 UI 状态。新增正文以一条 `deskpet-event` 保存完整 `Message`，预览不参与重放，兼容旧 `deskpet-turn` 和纯预览。`appendSequence` 按同一会话写锁下的落盘顺序递增；实际 Pi 工具调用与结果保存同一 `apiRoundId`、call ID、错误标记和来源。主动上下文不成为用户事实。

调用事件落盘后才准许执行工具；结果落盘后才允许下一次 Provider 请求。异步订阅通过回合内写队列收敛，写入失败阻止继续执行。归档只更新元数据，不再用内存文本重建文件。切换会话、旧代际回调和后台回复都绑定原 session。

## 压缩提交与恢复

`compactSession()` 返回 `committed / skipped / stale / failed`，只有 `committed` 显示完成。`/compact` 固定调用时的 session 和 generation；自动压缩在首次请求前及 Pi `transformContext` 中执行，不在每轮回复后启动后台 LLM。

检查点保存：结构化 summary、连续 `coveredEventIds`、`keepFromEventId`、输入/输出 hash、前一个检查点、context epoch、来源 revision、session version、run generation。提交前校验完整轮边界及 hash，写入时再次 CAS；摘要与检查点由同一 `session_file_write_atomic` 原子提交。取消在进入提交前使结果失效；进入原子写入后属于已开始的提交，不尝试删除或回滚已写入事实。

重载时从完整事件重建并验证检查点链，只有有效覆盖前缀会从模型请求视图中移除。损坏或无效边界不能授权删除历史。原始文件始终保留，旧格式也可参与新检查点。摘要是派生历史数据，不能变成系统指令、权限许可、Card 状态或长期事实。

## 预算与工具大结果

预算由 `context/budget.ts` 统一，主请求与一次性文本请求共享输出预留。正常目标在硬输入上限下留 `min(20,000, 16% 窗口)` 余量（极小窗口另有限制）；保留原文尾部和摘要输出各有独立上限。设置中的窗口还受已知模型上限约束。

- L0：请求内缩短大工具结果，保留头尾和 eventId；完整文本仍在会话，`read_session_event` 按当前会话分页读取。Bash 继续复用已有 Rust spill。
- L1：对最旧的连续完整用户意图轮生成结构化摘要。工具批次不能拆开，最后一轮与未完成调用保留；大历史分多次有界提交。
- L2：在无法再安全压缩时保留原文；如果核心输入仍超过硬上限，返回可解释的上下文不足错误，不用占位文案伪装压缩成功。

静态 Card、CANDY、完整工具 schema 和当前输入不按字符截断。画像/召回可以整块淘汰并记录预算原因；未被摘要覆盖的 transcript 不得静默删除。`loop.contextCompactAt` 已从默认配置与 getter 移除，旧文件保留该键不影响新预算。

## 请求快照与长期记忆边界

每轮冻结模型、Card、变量、CANDY、User、工具和 Skill 目录。PromptSnapshot 分 `transform_context / provider_payload / provider_usage` 三阶段，持久化 hash、来源、预算估算、真实 usage、缓存 token 和 context epoch，不保存原始 Prompt。摘要调用不计为正常聊天回复。

`CANDY.md` 是人工指令，`User.md` 通过带来源的只读画像投影进入动态层；两者与摘要分别建块。现有记忆整理接口保留，但应用启动、每五轮和 session 结束不隐式发起记忆 LLM 整理。明确的长期记忆写入闭环在 P6 实施。

本分支 macOS 类型/编译通过；89 个场景三次严格 trial（267 次）全部通过。详细实现、报告路径与下一阶段边界见[执行手册](../plans/active/记忆系统重构执行手册.md)。
