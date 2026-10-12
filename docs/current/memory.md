# 当前记忆与会话基础

长期记忆由 Rust SQLite（`数据根/memory/memory.sqlite3`）承载，原始会话保留在 JSONL。普通主回合先用本地检索提供小组直接证据，缺信息时由主模型在同一 Pi 循环中浏览目录、搜索并分页读取原文；不再运行独立阅读模型或自动覆盖清单补查。已接受事实按完整正文与编码计量，超预算整条淘汰；Card 变量与用户事实分开。

## 记忆的五层与召回链路

| 层 | 承载 |
|---|---|
| 真相层 | `sessions/` 的 JSONL 会话正文，永久保留、不迁移、不替代 |
| 记忆层 | Rust SQLite：已接受条目 + 来源 + 治理记录；会话片段与 FTS5 均为可重建索引 |
| 投影层 | `memory/exports/` 下的只读 Markdown；模型不能直接写 |
| 作业层 | dreaming（Light → Review → 自动 Publish），离线整理只在事务提交前短暂保留候选 |
| 端口层 | `MemoryProvider` 统一召回与 catalogue/search/read；原话读取复用 `conversation` 模块 |

记忆语义分四类：核心画像（用户确认并置顶的称呼与稳定偏好）、事实/偏好、经历、短期事项（带有效期，到期自动退出召回）。`kind = fact | preference | episode | working`，`scope = user | card | session`。另有来源类别 `origin = user | derived_behavior`（条目的 origin 由来源类别唯一派生，没有第二个存储位）：`user` = 用户本人可信输入沉淀的用户事实；`derived_behavior` = **系统观察得出的、可撤销的结论**（行为画像的稳定结论沉淀，2026-10-06 方案 b；抽取与准入口径见[行为画像](behavior.md#稳定结论沉淀)）。

**准入判据是「谁说的」，分两条互不混淆的通道**：用户事实只收 `origin=user` + `taint=trusted_user` + `eligibleForMemory=true` 的已提交条目——助手台词、工具结果、压缩摘要、主动搭话与缺来源标记的历史条目一律出局（它们都可能又长又具体，但没有一条能证明是用户本人说的）；系统观察只收 `origin=derived_behavior` + `taint=derived` + `eligibleForMemory=true` 的画像结论（reliable 档才有）或带稳定 artifact 与实际输入版本证据的了解摘要（见[行为画像](behavior.md)）。**两类分区存放、分区召回，不混池**：混用来源的候选整条拒绝；系统观察永不进核心画像、不做 working 事项、不能被改写成用户事实（反向亦然）——模型写入（`memory_change`）与用户区整理在结构上引用不到派生来源，不存在「顺手合并」的路径；错误配对的来源（如 `derived_behavior` + `trusted_user`）登记即拒收。投递时刻冻结的 `cardId` 随来源落盘，事后不从「当前正在显示的 Card」反推。

**检索链路**：同一库版本下先过滤 scope、状态、有效期与遗忘 → 本地合并 FTS5 trigram、主题/别名与**短词 LIKE 回退**（FTS 命中集合只计算一次，按条目 id 与版本精确关联），英文检索词排除通用疑问词、助动词与功能词，避免仅命中问句骨架的原文挤掉内容词命中；事实与原话通道共用同一分词规则。本地顺序按相关度优先、importance／时间／id 依次兜底 → 按预算取全文。FTS5 trigram 的 `MATCH` 不匹配少于三个 Unicode 字符的查询（「咖啡」这类两字词在它下面恒零命中），所以两字中文查询靠短词回退兜住。一次召回从同一 SQLite 读快照取 user／当前 Card／当前 session 候选、置顶核心与精确目标，并带回同一读取快照的事实 revision、索引 indexRevision 和 forgetEpoch；核心画像（pinned）无关键词也独立读取，不参与重排、不因查询词缺席而消失。首次会话检索最多返回 50 个候选条目供上层筛选；这是候选上限，不是最终注入条数。普通主回合首包至多含一个最高优先级置顶核心条目，以及本地排序中第一个可容纳的动态证据组（同轮 user 与锚定 assistant 成组）；选中后停止，不以可用窗口为填充目标。安全预算复用 ContextKernel 真实 headroom 与 `toolResultTokenBudget(window)` 上限，不表示数值最佳。adaptive 重排只用于显式启用它的调用方，不属于普通主回合首包策略。

索引发现时冻结原始条目的 `throughSeq`；发布正文、指纹确认与批次均使用同一前缀。发现后新增条目留待后续 dirty 刷新，不混入旧快照，文件变化与版本冲突仍须复核。

**请求落位**：核心画像、动态事实与原话组成 `[记忆与会话参考]` custom 消息，固定在本轮用户输入之前；同一工具循环复用首次检索结果，仅治理变化刷新，真实 headroom 不足时按完整条目重裁。稳定阅读规则进入 system，动态证据不进入 system。参考块标为 `eligibleForMemory=false`，JSON 带 `coverage=selected_evidence`、来源类别、角色、时间、seq 与 entry/chunk 范围；系统观察使用独立的可撤销推断标记，正文不能伪造宿主元数据。目录预览仅作定位，事实结论须能核对实际来源。

## 统一查询改写与候选重排

默认 SQLite MemoryProvider 合并事实、核心画像、派生观察与原话候选。[query-shape.ts](../../src/services/agent/memory/query-shape.ts) 在本地派生意图、实体、角色偏好与时间约束，生成互补关键词。普通主回合显式关闭模型改写和模型重排；后续扩词、浏览与读取由主模型工具选择承担，不再有 coverage/reader 循环。MemoryProvider 的可选改写和重排仍供显式调用方及对照评测使用：只接受有界 queries 与实际候选 ID，失败回退本地结果，合法空选择不补回。

时间约束区分 `record` 与 `event`。询问某天聊过什么时，经 `conversation_search.recordTime` 在 SQLite 按记录日期或 `[start,end)` 区间先定位，无需正文重复日期词，再由主模型决定读取哪些原文；`before` 仍是额外的开区间上界。日期按客户端本地日历解释；只有月日时保留年份未定并匹配各年记录，不自动套当前年。询问事件发生时间，或日期位于说过的事件内容中时，不用记录日期硬筛掉证据；事件里的昨天等相对时间由主模型按来源记录锚定。明确的查询相对日期沿用与时间注记同源的回合 timeAnchor，上周和上周末按日历周解析；它与限制可见 JSONL 的 before 截止时间分开，题目时间锚不会被真实接收时间覆盖。

用户事实、派生画像与原话均先过来源、scope、状态、有效期、遗忘与删除规则。普通主回合首包至多包含一个最高优先级置顶核心条目，以及本地排序中第一个可容纳的动态证据组（同轮用户消息与锚定助手保持成组）；选中后立即停止，不把安全预算当作填充目标。预算上限复用 ContextKernel 的真实 headroom 与 `toolResultTokenBudget(window)`，没有新设的固定证据 token 数。首次召回不再因为数量、概览、原因或建议意图而自动遍历整个 session。目录可用于补足关键词没有命中的早轮；是否深入由主模型决定，不能把首次命中当作全部历史。

显式调用的可选改写与重排沿用召回总时限和取消：主回合传入已冻结的模型及窗口，独立调用在入口冻结一次，配置中途变化不切换本次选择器。输出预算由合法 queries/候选 ID 的 JSON 形状估算，并检查模型输出上限；重排输入及改写的近期历史小包复用工具结果预算，再受该模型请求余量约束，不用固定 2048 token 或固定候选条数。与普通主回合工具读取分开记账。主动与精确引用只解引用调度器提供的目标，不扩展历史。

`ai.memory.queryRewrite` 与 `ai.memory.rerank` 仅控制没有显式覆盖模式的 MemoryProvider 调用方；普通主回合固定本地模式，见[运行时数据](runtime-data.md#配置变更同步清单)。不通过修改真实开发配置启用新工具链。

## 回合内按需读取记忆

普通主回合不再调用独立阅读模型，也不靠模型生成的 questionChecks/supported 状态驱动自动补查。小型且已随请求投影的证据由主模型直接回答；需要更多个人历史时，主模型可在同一 Pi 工具循环中按需调用 `memory_list`、`memory_search` 与 `memory_read`。工具导航结果只是目录或搜索线索，不能当成原文事实；回答个人历史时，需用稳定 handle 读取受治理的原始事实或会话记录。

普通产品 `sendMessage` 的主 Pi 工具循环接入既有导航工具。工具读取分层进行：先列目录确定范围，再对事实与会话历史做统一检索，最后读取命中的原文或分页后续事件。会话正文仍来自 SQLite 索引指向的 JSONL；完整回读必须逐字匹配身份、角色、序号、时间和 chunk 元数据。每次返回都明确范围、revision、分页游标与是否完整；不完整分页不能伪装成完整历史。正文、Card/session scope 与遗忘资格均由宿主冻结并复核，revision/forget epoch 改变、来源失效或取消时，旧 handle 与迟到结果 fail closed。

工具返回按完整 JSON 消息计入主请求预算，受 `toolResultTokenBudget(window)` 与调用时真实 headroom 双重限制；并行工具先预留额度、结束后退回未使用部分。普通聊天没有额外 reader 的输入、推理和输出账单。深查仍会产生真实工具轮及其 Provider 请求，不能因没有独立阅读器就推断总 token 已节省。只有最终请求视图仍包含原始 `memory_read` 正文页，或实际渲染入页且带权威范围证明的首次参考证据时，才授权复用其精确 UTF-16 字符范围。首次证据与工具页共享同一范围账本和 readId 引用协议；首次证据的 readId/range 随正文一起编码计量，目录预览、未入页候选或预算淘汰项不能授权。账本按实际 fact 版本或会话 entry 归属共享范围，不依赖 handle、搜索 chunk、turn/episode 入口或页预算相同；不保存正文副本，也不沿引用回执建立授权链。Provider 每次先复核当前入口的资格、范围、版本、遗忘代和原会话指纹；事件来源还须匹配已接受的内容 hash。当前 entry 的多个可见区间合并后覆盖所需全文时不再构造正文；仍有缺口时经既有可见 JSONL 投影读取，一页只返回一个缺口的 `text/range`，其前后已读范围用 `reusedRanges` 直接引用原始 readId，后续缺口保留真实游标。正文离开上下文后必须重读；预算不足可只返回容得下的连续引用前缀或明确停止，不重发已读正文、不越过未呈现缺口。指纹核验仍会访问原会话，不能把模型输入复用说成本地零 I/O。首次自动证据的跨请求缓存继续负责检索复用，渲染后的正文范围则加入工具共用账本。事实以 id/version 绑定完整正文；会话以实际 entry 的完整内容 hash 与绝对字符坐标绑定，索引分块验证时直接保存坐标，不以字符串搜索猜测重复文本的位置。后续读取同源时只补仍未呈现的缺口；首次证据因预算缺席或来源失效时撤销其范围授权。`memory_navigation_rendered.usedTokens` 计入当前成功 read 结果的完整编码，包括短引用开销；readRefs 只指向新正文范围。版本变化、取消或来源失效时 fail closed。工具按需读取是主模型的行动选择，不承诺每个问题都会检索，也不把工具没有找到等同于历史不存在。助手原话仍不成为用户事实，来源不可信或归属不明的内容不参与事实回答。

个人建议需先查找相关的已拥有物品、已尝试方法、已作选择与限制；计划、假设和助手建议不能升级成用户事实。主模型应区分有证据、没查到与证据范围不完整，并明确说明关键未知，不用常识补成个人经历。

本轮变更的测试验证工具接线、分页与治理边界，不证明答案质量、准确率提升或 token 节省。旧 LoCoMo 停止批次与新工具架构口径不同，不拼接为同一次评测。

## 当前会话与跨会话原文检索

“用户是什么样的人”和“当时谁说过什么”分开回答。助手推荐、说明与承诺保留为助手原话，不转成用户事实；错误的旧话也只能证明当时说过。查询覆盖当前数据根下全部 JSONL，包括已关闭标签的会话，不受聊天视图条数上限或压缩摘要限制。会话不拥有 Card 归属，不能根据当前 Card 反推旧助手身份。

导航层依次提供会话目录、可信用户轮次（及锚定助手概览）和原文读取。`memory_list(level=turns)` 必须明确 sessionIds，可按记录时间缩小范围；`events` 是 accepted episode 的跨来源目录，依据其多个 accepted sourceIds 汇总；`memory_search` 统一搜索已接受事实正文/别名与原话词面候选，带 run-local handle；`memory_read` 回读已接受事实正文或 JSONL 原话；轮次句柄可读用户轮及锚定助手，事件句柄逐页读取其 accepted sourceIds 对应的原始用户记录。sourceCoverage 表示事件来源当前的可读资格，真正读到哪里由 unread、游标和 scope 覆盖账本记录。目录与搜索按请求条数批量取页；预算只容纳部分候选时，缩小该批次并取回真实前缀游标，未入页条目留在后续页，不按单条反复请求底层。单页完整 JSON 预算由 `toolResultTokenBudget(window)` 与调用时真实 headroom 共同推导，不设固定 token 页大小；附准确字符区间、角色、来源和后续游标，不靠截断省略号冒充全文。只有从初始游标连续枚举至结尾，scope 覆盖账本才可标记完整；从中间游标开始不能证明前页已覆盖。若正文读取因 `budget_exceeded` 未能完成，仍返回已枚举范围的 progress 并标记 `stoppedAt: "budget"`、`unread=true`；不推进覆盖账本，不生成可复用 read receipt，也不把该范围标成读完。整理覆盖不完整时，目录结束也不能证明 JSONL 历史总事件数。导航的条数、预览字符、检索词与游标大小限制统一定义在 protocol.json 的 constants.navigation，并生成 TS/Rust 常量；它们是资源边界，不是经评测证明的最佳参数。people/topics 导航元数据由现有离线 dreaming 或受治理的 `memory_change` 写入，只用于定位，不作为事实主张；同名人物的 aliases 在合并时按确定性顺序去重并集，遵循现有别名上限。

`session/readVisibleSessionTranscript` 复用聊天投影和主动送达回执核验；只索引已提交且用户可见的 user/assistant 正文，剥离 RUNTIME_DATA，排除 thinking、工具结果、控制条目与未确认主动输出。可信用户事件作为普通助手回应的锚点；外部输入和主动触发打断该锚点。原始 JSONL 为真相源，索引保存 entry/event ID、seq、角色、时间与 Unicode 片段坐标。

索引发现、prune 与分批发布由同一写入队列串行执行，快照建立前等待所有在途刷新退出。冷启动首次准备核对当前数据根全部来源，随后由 JSONL 提交通知与文件 watch 标脏，后台仅核对变化来源；watch 不可信时回到全根内容核验；完整发现确认已删除或不属于当前仓库的路径后，只有期间未出现更新通知才清除其 dirty 标记，避免准备快照无限等待。watch 与 mtime 只提示可能变化，不能替代内容版本。导航 owner 首次 catalogue/search 前等待已观测变更收敛并取得索引快照 lease；最后一个 owner dispose/release 后续建积累的 dirty 来源。并发 owner 如共享尚有待更新来源的旧快照，返回 indexUpdating，覆盖账本不得宣称范围完整；数据根切换使旧 owner 与句柄失效。索引按全来源构建，before 仅限制查询和读取资格；原文复核限定在该索引的 throughSeq 边界，内容指纹包含准入正文、角色、身份、时间和分块版本。边界后的追加不使旧引用失效，边界内原文编辑或删除会失效。原文读取前后均重新核对指纹。长正文按约 400 个估算 token、最多 1600 个 Unicode 字符分块，相邻片段重叠不超过 48 token；中英文共用上下文估算器，边界不拆 Unicode 字符。分块规则版本纳入会话指纹，下次检索自动重建旧派生索引，JSONL 不改；刷新分批暂存，完整快照提交前旧索引保持可读，指纹和遗忘代 CAS 拦住过期写回。FTS5 trigram 与参数化短词 LIKE 共用事实检索的分词口径；轻量英文词形匹配保留短词、中文及明显专名原样，候选内按词频降低常见名字的权重，优先区分具体内容；所有符合治理规则的关键词命中逐条评分，仅保留本次所需最佳候选，不再先按时间截取最近 1000 条后排序，旧的高相关原话仍可入选。命中用户问题时可带回有界同轮助手窗口。明确短指代在关键词无命中时才取近期历史，普通无命中不补无关片段。索引统计与正文读取共用每会话文件锁，该锁也串行化 close、flush 与 fold；会话重新打开须等待上一次 close、flush、fold 全部退出。查询后和每次 Provider 请求前复核原会话仍存在。

索引以流式批次暂存，保持同一快照 ID、连续 offset 和末次 complete 提交；取消、文件变化或遗忘代冲突不能发布半份索引。单帧容量仅是桥接层流控单位：请求参数或检索结果的完整 JSON 超过协商控制帧容量时，自动经既有 blob 二进制通道传输，再恢复完整对象。索引与检索业务不按 IPC 字节数截断，不把单帧容量当成整段会话的总字节或总条数上限。索引清理的保留会话列表没有总条数门槛，仍逐项校验身份与重复项，并在同一事务中清理。

首次召回中核心和精确目标优先，动态证据按本地相关性与会话覆盖装配，整轮组装不新增关键词未命中的邻居。命中引用回读 JSONL，校验 entry、role、seq、时间和 chunk；不匹配就丢弃陈旧证据。导航的目录/搜索游标绑定查询、范围、索引 revision、事实 revision 和 forget epoch；读取必须通过 Rust 同一 MemoryStore 的资格裁决和 JSONL 内容指纹核验。版本变化、取消或 owner 失效返回明确 stale，非支持后端明确 unsupported，不用空命中伪装成功。

会话索引使用同一 Rust MemoryStore 连接，自己的 revision 不推进事实 revision。遗忘同事务抑制来源用户条目及锚定它的助手原话，重建不复活；清空还保存原会话 seq 边界，旧时间戳和时钟变化不能绕过。删除正文后清理其索引，关闭标签保留正文与检索资格。原始聊天或已经发出的模型请求并不会因记忆治理被追回。

召回受现有 recallTimeoutMs 与运行取消控制。超时停止等待，晚到索引不能发布，故障走统一日志与会话审计；首次建索引的冷成本及长会话性能尚未实测。源码入口是 [conversation.ts](../../src/services/agent/memory/conversation.ts) 与 [Rust conversation.rs](../../crates/native-host/src/memory/conversation.rs)。这借鉴了 OpenViking 的原文保留与按需读取思路，没有引入其服务、向量库或模型摘要调用。

**参考实现（固定源码版本）**：借鉴 Agno [filesystem toolkit](https://github.com/agno-agi/agno/blob/df4a5861be6e13f508a75378465ef0c595bc49db/libs/agno/agno/knowledge/filesystem.py) 的 list/search/read 工具，以及 OpenViking [上下文分层](https://github.com/volcengine/OpenViking/blob/4c9a755bff4d31fd9bd9a3be1a19a6054ef3cea5/docs/en/concepts/03-context-layers.md) 的目录→概览→原文。该 Agno revision 没有 typed entities 或实体别名实现。轮次概览是确定性有界原话预览，事件概览复用已接受 episode 的摘要及来源集合；没有另建完整语义摘要树。保留 SQLite/JSONL，不引入 Python 框架、向量服务或另一个写入真相源；机制相似不能当作质量或 token 收益证据。

## 记忆库的治理不变量

- **一次写入一个事务**：条目/版本、来源关联、FTS 与 revision 一起提交，失败全回滚，不对 UI 报成功。
- **operation_id 幂等**：提交结果未知时先查这条操作记录，绝不盲重放。
- **基准版本**：写入与发布都带 `baseRevision`，不匹配返回 `MEMORY_CONFLICT`，由调用方重新读取后再决定；不静默覆盖。
- **候选隔离**：Review 的产物先落为 `prepared`，不进 FTS、不进召回；作业完成时由 `memory_dreaming_commit` 复核来源、版本、hash、遗忘代并在单事务内将候选变成 `accepted`、生成的记忆条目写为 `active`。用户面板不提供人工发布门，只做提交后的查看、纠正与遗忘。
- **遗忘闭包**：遗忘写 `memory_tombstones`（稳定事件身份 session+entry+content_hash），同时清正文、FTS 与候选，并递增 `forget_epoch`。之后**索引重建、旧水位补扫、旧批次发布都不会让内容复活**；抑制匹配的是稳定身份而不是可重建的行号。行为画像清除（`/behavior clear`）对全部 `derived_behavior` 来源复用同一闭包口径（先失效主动引用、再写墓碑并清正文/索引/候选、推进 `forget_epoch` 与 revision；库里没有派生数据时不动代际），已清来源身份不能迟到回灌。计量升级通过内部 `forget_derived_behavior` 复用同一闭包，读取和登记派生记忆前先处理持久撤销待办，事务失败不确认完成；用户事实不受影响。清除静默了解复用同一闭包、范围收在 `understanding:` 来源（`memory_apply_change` 的 `forget_understanding`，actor 固定 internal），已清来源同样不得迟到回灌。缺证据的旧了解记录只可展示，不参与就绪或沉淀，已沉淀部分在首次读取前按持久待办撤销。
- **范围隔离**：`card` 范围的记忆绑定 Card id（外观 Profile 切换不改变归属）；跨 scope 不隐式 supersede。
- **删除范围分开讲**：「记住/忘记」只清应用管理的记忆与它的回灌资格；原始聊天正文、已导出的文件和外部备份各自有独立的删除入口，界面必须分别说明。当前会话正文里仍然存在的被忘内容无法追回，不能宣称模型已经完全不知道。

## 显式写入与整理

模型写入只经 `memory_change` 工具（`local_mutation` / `exclusive_effect` / `replay: never`，继续由 PermissionKernel 终裁）：工具只接受本轮已提交可信用户事件，宿主绑定来源、目标版本与库版本后直接提交；不存在另起的人工发布确认 UI。只读导航走 `memory_list/search/read`（shared_read、preserve），身份、Card、before、预算由宿主冻结。事实可见范围为 user＋当前 Card＋当前 session；原话可见范围为当前数据根全部合格会话，模型只可缩小检索范围。管理界面跨 Card 的浏览能力不暴露给模型。

自然语言显式写入不等待下一轮 dreaming；成功的判据是 Rust 返回的已提交 revision，而不是模型说「记住了」。每个尚未发出的 Provider 请求前都会复核记忆库 revision：与本回合读到的 revision 不一致时整份刷新（跳过重排、按新资格重选），读不到库时本次请求放弃记忆投影（fail closed）—— 用户刚纠正或忘记的事实要在下一次请求里生效，已发出的网络输入无法收回。

**用户入口与运行期同步**：原生设置窗的「记忆」页经宿主请求面（`memory_overview` / `memory_item_detail` / `memory_item_change`）读取库总览、条目详情与历史版本（库总览行副标题与详情「来源类别」一栏对 `origin=derived_behavior` 的条目追加同一枚呈现标记 `DERIVED_PROVENANCE_MARK`——与记忆块逐行呈现同一份判据与措辞，用户事实不标注；「已记住」列表按 5 条一页分页——2026-10-06 用户裁决，分页只在原生 UI 层做，`memory_overview` 仍返回全部条目，切片与页码 clamp 在设置域纯函数），并按需解引用来源原话（`memory_source_evidence`：登记时有界证据 + 会话正文原话，已遗忘来源返回不可用；**逐条展开**——详情下方每条来源一行，点某行才取并展开那一条，同时最多展开一条、再点收起，旧的「一次拼接最多 5 条」文档形态已删除）；写操作支持纠正、核心画像标记与遗忘（actor 固定 `user_ui`，信任门槛与遗忘语义保持 Rust 既有裁决，界面不放宽）。整理作业行按状态投影动作：进行中（running/queued）= 可取消（`memory_job_cancel`，租约身份 = 记忆整理的既有写者，状态没变成 cancelled 即如实拒绝）、受限的 review 作业（paused/cancelled/failed）= 可继续（`memory_job_resume` + 既有 `runDreamingSweep({resumeJobId})`，非 review 作业由领域拒绝）；终态作业只读列出。同一条通道另有：范围筛选（`memory_overview` 的 scope，card/session 的 id 由 Node 补激活值）、手动整理（`memory_dreaming_sweep`）与维护（`memory_maintenance` 备份/只读导出/重建索引）、备份列表（`memory_backup_list`：托管备份目录里的 `.sqlite3` 逐份一行，时间/大小，点行选中，缺省与选中失效时回退最新一份）与恢复预览/应用（`memory_restore` 带 `backupPath` = **选中的那一份**；路径边界仍由 Rust 只接受托管备份目录内的文件）。面板提交成功后才 `publishMemoryRevision(revision)` —— 单 Node 架构下它是**进程内分发总线**：运行侧订阅者（runtime）据此中止陈旧记忆投影，总线等待运行取消准入完成后返回；不在工具内部等待当前回合 idle，回合收尾仍由原出口承担；失败的提交不发布、不谎报。备份的预览与应用也在这条管理通道上（应用走 Rust 备份恢复语义）。宿主分派层另保留「记住这条」的存储门禁组合（main principal + actor `user_ui` + action `add` + 可信会话），消费点是聊天消息右键菜单（`chat_remember_message`），存储门禁与 actor 不动。槽存活期间 `appendPiSessionCustomEntry` 转交 `HarnessSlot` → `AgentLane`（按 operation 状态进分支或持久 inbox），只有无活槽的空闲会话才直接写 session Branch，避免旁路追加移动盘上 tip 把条目挤成孤立分支。

用户区 Review 与库内 merge 走辅助模型的显式 low 档，避免目录缺失时默默落到服务端高推理默认；输出仍受完整模型预算约束，截断照常失败。作业实际用量按 input + cacheRead + cacheWrite + output 结算，trace 归类为 `dreaming`。

dreaming 分三阶段：Light 固定输入范围（来源登记 + 水位）、Review 产出带证据引用的 `prepared` 候选、Publish 在复核来源/版本/抑制后单事务提交。**Review 判据（2026-10-06 加强）**：只有用户明确表达、跨会话仍成立的事实/偏好才记（要能从原话直接读出来）；请求句（帮我 / 看看 / 猜猜 / 查一下 / 截个图）不是偏好，测试与调试、临时任务不记；同一批同类内容最多一条候选；**没有值得记或更新的内容时返回空数组——空数组是常见且正确的输出**（此前的弱判据把测试闲聊「猜猜我在放什么歌」「看看今天天气」归纳成了持久偏好，属反面样本；`memory_change` 工具对主 agent 主动记忆同口径）。**系统观察区同理且是结构保证**：结论来源的 sourceId 含内容 hash、登记幂等（同 hash 只更新 evidence、水位不推进），水位后无新来源时连作业都不开——同一结论重复产出零写入，画像身份绑定计量版本与结论文本，了解身份绑定稳定 artifact、实际输入版本及摘要；证据发生变化才登记新来源并覆盖旧条目（「没有可更新的就不写」不靠自觉，靠三道闸门）。**来源分两区且一次作业只驱动一类**（写入前登记两区来源，前置查询与批内取数按 `origin` 过滤）：用户区走模型 Review（下述预算/模型口径只作用于它）；系统观察区（`derived_behavior`）含**两个子类**：画像 reliable 档的稳定结论（身份前缀 `conclusion:`）与静默了解的观察摘要（前缀 `understanding:`，登记窗口与在库上限各 12 条、满额按最旧优先覆盖），均走**确定性 Review**——文本原样成为候选正文、不经模型改写或演绎、不占 token 预算，同槽位/同身份的新版本带 `supersedesId` 在发布事务里覆盖旧条目（版本收敛）。两类候选在发布口复核来源类别：混用来源、派生候选带 pinned 或 kind=working 一律整条拒绝。每批来源数与正文长度有界，单条过大整条跳过交给用户挑选片段，不做静默截断；模型来源 id 必须落在本批内，否则整条丢弃。单次 Review 的输出预算按模型窗口推导（窗口 × 1/8、32k 封顶，且不越过模型目录声明的上限；reasoning 的 thinking 也计入），再按「窗口 − 估算输入 − 余量」逐批收紧；`ai.memory.dreaming.reviewMaxTokens` 只用于显式压低上限，缺省即自动。触达长度上限的批次仍以「输出达到长度上限」如实失败，不采用不完整结果。Review 使用的模型取辅助模型 `ai.auxModel`（留空跟随聊天模型；与子运行共用同一解析入口）。运行入口支持手动整理（不受档位约束）；开作业前先查「水位之后还有没有待处理来源」（`memory_pending_source_count`，与 `memory_job_sources` 同一水位判定，**按来源类别分开查**）：没有就转**库内整理**（2026-10-06）：在没有待处理来源时，对库内已有条目做同 origin 区内的合并整理——按 scope+kind 分组的已有条目（pinned/working/过期/派生条目出局）交模型产出合并组（2–4 条/组、≤3 组/次），候选带 `supersedesIds`，发布事务内旧条目 supersede（历史链保留）、**来源取并集（Rust 事务内强制）**、范围/类别/失效逐条复核、冲突按 `MEMORY_CONFLICT` 如实失败；库内没有可合并分组时一次列举零写早退（不开 job、不动预算/租约，如实回报「水位之后没有新的可整理来源」）。有新来源时不做库内整理（新来源优先）；只有系统观察来源时照常开派生区的作业。恢复既有作业（`resumeJobId`）不经前置查询——job 自带游标、水位为空也能继续（恢复不分类别；水位按会话隔离，两区来源互不吞并；作业内 checkpoint 按**本批实际处理的每个会话**各自推进水位，不只批尾游标所在会话——2026-10-10 修复，此前批中段会话的来源会留在水位之后被下个作业整段重读）。`ai.memory.dreaming.tier` 非 `off` 时，启动的定时调度器按固定钟点表（低 12/20、中 10/14/18/22、高 9/11/13/15/17/19；钟点起 15 分钟追赶窗）到点即跑、不再要求系统空闲，同一钟点只跑一轮（判定与静默了解共用 `proactive/schedule.ts`），并在作业完成时自动 Publish；`off` = 定时调度器早退（手动入口保留）。档位（低/中/高）= 每天 2/4/6 轮，最小间隔 240 / 60 / 30 分钟保留为防重兜底；档位表内原 idleSeconds/idleRequiredMs 字段已删除（钟点表取代）。每日 token 上限已按 2026-10-06 用户裁决撤除（与主动链同批口径：「一天最多几次」保留、「一天最多烧多少 token」取消）：空闲调度器不再查 token 账做门禁，批次也不再因 token 账被中止（Rust 预留一律接受）；token 的预留/结算照记进 Rust 作业账本，只作观测账，重启后沿用同一自然日的已用量与租约状态；原 `mode / idleSeconds / minIntervalMinutes / maxDailyTokens` 四键已删（`manual` 被 `off` 吸收）。

## 当前文件职责

| 文件 | 当前用途 |
|---|---|
| V1RTUAL.md | 用户手写系统指令（人工入口，不是记忆数据） |
| memory.sqlite3 | 已接受记忆、来源与治理决定的真相源（Rust 管理） |
| exports/ | 只读 Markdown 投影，不可回写 |
| backups/ | 一致性备份（走 SQLite 备份接口，不复制写入中的主文件） |

旧的 MEMORY.md / User.md / Outside.md / Project.md 注册表**不再创建、不再读取**：记忆主路径已换成 SQLite。磁盘上的旧文件保持原样，由用户自行决定是否清理；没有隐式回退到旧文件的路径。

### 数据库

库文件、schema 版本策略与库级事实见[数据库](database.md)。

## 会话真相源

聊天正文以数据根 `sessions/` 的 JSONL 为真相源（JsonlSessionRepo，每会话一个文件，commit 事务写入；写入以追加为主）。已删除 key 的写入行由折叠回收（纯删除式重写：只删每个 key 最后一次 `list/delete` / `value/delete` 之前的 `list/append` / `value/set` 写入行，以及从未 delete、被反复覆盖的 value key 中非最后一次的 `value/set` —— 同一 value key 只保留最后一次写入，`list/append` 是累积语义不适用；不重编号、不重写保留行、不改逻辑状态；原子替换 + 折叠前后状态 hash 校验，不一致就放弃折叠、保留原文件；`storageVersion` 不匹配则跳过）；折叠只改变文件的物理行数，不改变会话正文的真相源地位。折叠的触发时机：`releasePiSession` 句柄关闭之后（主路径）+ `open` 前按需（兜底，仅当文件超过 `FOLD_POLICY.minFileBytes`）；三阈值 `minFileBytes` 512 KiB / `minReclaimBytes` 128 KiB / `minReclaimRatio` 0.15（三者 AND）。`sessions/index.json` 只保存可丢弃 UI 状态（经宿主命令读写）。会话扫描失败会置 `sessionHistoryError` 且不自动建新会话——「读不到」不被伪装成「没有会话」，也不拿空列表覆盖已持久化的标签。条目保存稳定 entryId/seq；工具调用/结果、usage 行与来源标记都落在条目与 usage 记录里——来源按条目形态分字段：用户输入（含空闲发送）在消息上带 `deskpetEventId`（`<requestId>:user` 身份）与 `deskpetSource`（`InputSourceMark`：origin/querySource/priority/taint/eligibleForMemory；`eligibleForMemory=true` 只给用户本人的可信输入），恢复续跑投递的「继续」用 recovery 标记；工具结果在 `details.origin/taint/isError`（工具来源的 taint 记为 `untrusted_external`）；主动消息在 `details.*`（requestId/rawText/normalizedText/querySource/priority/taint/visibleToUser/eligibleForTranscript/eligibleForMemory）且 `eligibleForMemory=false`。没有这两个字段的历史条目按「没有身份 / 没有标记」处理，不猜来源。两类 `deskpet.*` 要分清：**message 条目**（`role:"custom"` 的 AgentMessage，如主动搭话 `deskpet.active_message`——它是正文条目，会进 `buildSessionContext`）与 **custom 条目**（`appendCustomEntry` 写入的控制信息，如 `deskpet.prompt_snapshot`、`deskpet.system_message`、`deskpet.plan_checkpoint`——`sessionEntryToContextMessages` 对 `type:"custom"` 返回空，只有注册了 `entryProjectors` 才会投影）。**不要把主动搭话改成 custom 条目**：宿主不注册 projector，改过去会被静默丢弃。custom 条目里，`deskpet.prompt_rewrite` 记录一次提示词派生的输入/输出 hash 与派生来源（压缩摘要写 `compaction_summary`，附压缩条目地址），只留 hash 不落派生正文，也不进模型消息流；`deskpet.compaction_continuation` 记录「压缩续跑在没有宿主回合的情况下已被结算」这一异常收口，`deskpet.compaction_declined` 记录宿主摘要内核失败导致的压缩降级（含 status/reason/error），`deskpet.recall_failed` 记录 MemoryProvider 召回抛错后按空召回继续的降级（含 requestId/error/at），两者都供审计追溯；计划证据条目 `deskpet.plan_step_result`、`deskpet.plan_recovery_failed` 与 `deskpet.plan_write_failed` 已登记，均为宿主自定义条目，不进模型消息流，因此不受 `resultProjection`（请求层缩短）与 `historyCompaction`（压缩保留策略）约束）。宿主不提供 `toProviderMessages` 与 `entryProjectors`，走上游默认投影（`convertToLlm` 把 `custom` 投影为 user，`deskpetEventId` 不泄漏）——这是有意的边界，不是缺口；要改条目类型或投影语义必须同时改契约与场景。`resources.skills` 已由宿主下发（装配 lane 时用启用清单调 `setResources`）：它只服务 Pi 的技能准入（`/skill`）与披露来源，不写会话条目，也不把技能正文投影进请求。旧 Markdown 会话格式及其解析代码已删除，旧数据可弃。主动上下文不成为用户事实。

用户 ingress 先落盘再投递（lane 持久 inbox）；工具调用落盘后才执行；结果落盘后才允许下一次 Provider 请求。切换会话、旧代际回调和后台回复都绑定原 session。

## 压缩提交与恢复

压缩由 Harness 调度（阈值 / 手动 `/compact`→`lane.compact()` / 一次性溢出恢复），`/compact` 绑定调用时的会话与运行。宿主硬预算超限同属这条恢复：`transform_context` 的判定由 model-gateway 作为 Provider 响应上报（length 停止、输出 0，命中上游 `isRecoverableLength`），Harness 压缩后带 `overflowRecoveryUsed` 重试一次；超限请求不发给 Provider，判定按当次请求视图重算（网关取走即清空），恢复用尽时按这条判定失败；上游因没有可安全摘要的范围 declined 时，失败分类保留上游文案，回复仍回落这条判定。失败分类（`TurnFailure.kind`）除 `admission` 外只能从失败文案派生（Harness 把运行失败降维成一条 message）；`admission` 由调用点写入（回合准入拒绝、lane 结构操作在飞），分类函数不返回它。状态码按独立数字匹配，判定文案里的估算 token 数不会把本地预算失败变成 Provider/认证/限流故障；目前只有 Live Test 的 `expectFailure` 与报告按 `kind` 分流。结构化摘要在 `before_compaction` 钩子内生成——复用 [compactor.ts](../../src/services/engine/compactor.ts) 的摘要内核，经 model-gateway `completePiText` 发送——以 `CompactResult`（summary + retainedTail）返回，由 Harness 单事务提交为 compaction 条目；提交成功前不报告完成，摘要失败或无可覆盖时 decline/报错：宿主摘要内核失败走显式 decline（钩子内 catch 后返回 decline，不把上游通用英文摘要落进历史）+ 可见失败（`/compact` 报当前 Card 的 `commands.compactFailed` 并附上技术原因、`compactActiveSession` 返回 `failed`）+ 一条 `deskpet.compaction_declined` 审计条目（内核失败带 `error`），切分回合的 turn-prefix 另段摘要。策略性 decline（摘要素材为空 / 保留守卫 / 闸门装得下）不报失败、文案保持 declined：钩子把结构化原因（kind / trigger / 会话 id / 关键数字——空素材时是素材与保留窗口读数）写进统一日志，`manual` / `overflow` 触发另落同一条 `deskpet.compaction_declined` 条目（带 `decline` 记录），`threshold` 是每个检查点都可能重试的内部优化、只留日志；`commands.compactDeclined` 与 `commands.compactNothing` 语义不同（有历史但无可安全摘要范围 vs 没有可压缩历史），不合并。摘要素材的 L0 投影与主请求同口径（同一个 `projectToolResultText`，回读地址同样只认 `details.deskpetEntryId`）：`resultProjection=preserve` 的工具结果完整进入摘要请求，只有 `reference` 的会被缩短并留下回读标记；没有回读地址的结果不写假 eventId，改标「该结果的原始条目没有回读地址，中间段不可恢复」；存档条目不受两者影响。压缩调用不计为正常聊天回复，其 usage 落会话 totals 但不进主回合统计；摘要调用的用量按 purpose 单列到用量统计的 `compaction` 分项，与主回合分项相加得到总消耗。`historyCompaction=retain` 维持保留（不删）：生产工具全部声明 `summarize`，`retain` 在生产路径无消费者，是按声明保留原文配对的能力预留，由 `memory-retain-guard` 场景驱动。

压缩设置（reserve/keepRecent）由 `contextBudget()` 推导并按模型窗口同步，不套用 Pi 默认值（默认窗口下会退化为每个检查点都压缩）；推导值还要经 `toHarnessEstimateTokens()` 换算到 Harness 的计数口径。Harness 的 `shouldCompact` 比的是它自己的 `estimateContextTokens`：有 provider usage 时前缀按真实 usage 计，本仓预算同为目标真实 token 口径，因此换算因子**恒为 1**（`toHarnessEstimateTokens()` 现为恒等函数，不要再按 `chars/4` 反推因子）；纯中文且无 usage 时上游仍按 `chars/4` 计数，两边相差约 4 倍（该差异由 `provider_usage` 快照的 `tokenDrift` 留痕，见下）。**保留窗口的换算还要按这条最坏偏差封顶**：上游切点尺子（chars/4）下保住 `keepRecentTokens × 4` 个字符，纯非 ASCII 时就是 4× 本仓 token —— 若超过 `normalInputTarget`，纯中文会话的保留段自身会顶破正常输入目标（素材恒为空、溢出恢复压完重试仍超限），因此 `compactionSettingsFor` 把换算值再与 `⌊normalInputTarget / 4⌋` 取小（`ESTIMATOR_WORST_CASE_BIAS`，纯 ASCII 下不生效）。

上下文估算按字符类别分列：ASCII 约 4 字符 1 token、非 ASCII 每 UTF-16 单元约 1 token，**刻意不留余量**——余量已由 `compactionHeadroom` 承担，估算偏差 k 一旦超过 `hardInputLimit` 与 `normalInputTarget` 的比值（该比值随窗口增大逼近 1），硬预算就会先于压缩报错，压缩永远轮不到触发。调整估算常数前先跑 `memory-compaction-threshold-calibration` 场景。

消息估算走唯一的内容投影（`projectMessageContent`，token 估算与快照 `contentHash` 共用）：按角色表覆盖 `compactionSummary` / `branchSummary` / `bashExecution` / `custom`（摘要只计 `summary` 正文、`excludeFromContext` 的 bash 执行计 0，与上游 `convertToLlm` 一致），未知角色按整条消息估算并去重留痕，绝不退化成空串；`usage`、时间戳、模型名与持久化元数据一律不计费。`provider_usage` 阶段的 PromptSnapshot 带 `tokenDrift`（`estimated`/`actual`/`ratio`）：估算与实际 usage 的比值超过 `ESTIMATE_DRIFT_WARN_RATIO`（1.15）时只 `log.warn` 并在 trace 的 `provider_usage` 事件里带出 `driftRatio`，不改变预算判定。

保留窗口只覆盖消息本体、按上游 chars/4 估算，静态提示词占比过大时会出现无可覆盖范围并 decline（素材为空的直接判据是消息估算总量没越过 `keepRecentTokens`，切点因此停在开头、全量进 retainedTail；该拒绝必须带结构化读数，见上），因此窗口有下限：默认 `DEFAULT_CONTEXT_WINDOW` 256k、最低 `MIN_CONTEXT_WINDOW` 64k，低于下限时原生设置窗按 schema 值域拒绝保存、运行期在模型解析处报错，不静默跑在坏预算上；模型解析处的下限错误会指出模型 id 与配置窗口取小的关系（该值来自模型目录的已知窗口与配置取小），引导用户换窗口更大的模型，而不是去改一个本来合法的配置值。上下文 epoch 在快照中等于**本会话 lane 分支上**已提交的 compaction 条目数，唯一定义点是 `engine/harness/delivery.ts` 的 `readContextEpoch`（槽快照与请求快照共用它），读不到时快照不写该字段（未知不等于 0）。

原始条目始终保留，压缩只改变请求视图；折叠不是删除历史（只回收已删除 key 的写入行与被覆盖的 value 旧写入行，entry/usage 行一个不动），损坏或无效边界不能授权删除历史。摘要是派生历史数据，不能变成系统指令、权限许可、Card 状态或长期事实。

## 预算与工具大结果

预算由 [context/budget.ts](../../src/services/context/budget.ts) 统一，估算会计入标准化消息和完整工具 schema，不把估算值当成 Provider usage；主请求与一般一次性文本请求共享容量预留，显式查询改写另有较小任务输出上限，普通主回合没有独立阅读输出。正常目标在硬输入上限下留 `min(20,000, 16% 窗口)` 余量（极小窗口另有限制）；保留原文尾部和摘要输出各有独立上限。设置中的窗口还受已知模型上限约束。

预算账目按 static/dynamic/memory/transcript/ephemeral 分类，完整工具 schema 计入 tools；这与消息在网络请求中的实际顺序分开。普通对话首包由 [budget.ts](../../src/services/agent/memory/budget.ts) 标记 initial-evidence 模式，容量上限复用 ContextKernel 的实际 availableTokens 与 `toolResultTokenBudget(window)`；选取规则固定为最多一个置顶核心条目和一个本地排序动态证据组，选中后停止。它不是经实验确定的最佳 token 数。主动、目标与显式调用仍使用各自目标政策。工具页复用同一 `toolResultTokenBudget(window)`，并结合工具调用时的真实剩余 headroom，对完整 JSON 结果计量。首次 packet 固定在本轮输入之前，不因工具结果增长重复检索或改写，有效性仍在每次请求前复核。

参考块表头、JSON 编码、出处与正文共同计量；事实不裁片段，原文索引片段明确 extent=chunk，不冒充整条全文。主模型分页阅读见[回合内按需读取记忆](#回合内按需读取记忆)。静默了解和主动规划使用自身 JSON 计量。工具结果、静态 Card、当前输入和 transcript 仍遵守各自硬预算及压缩机制。

- L0：请求内缩短大工具结果（保留头尾和 eventId），阈值由 `contextBudget().normalInputTarget × L0_TOOL_RESULT_CAP`（10%）推导，判定与裁剪都用 token 口径（中文 ≈1 token/字符，头尾各半按 token 切），随窗口单调。**无条件带地址**：不论是否超阈值，每条工具结果在请求视图里都带回读地址（未缩短的正文也附地址尾行；`preserve` 只挡升档处理、不挡地址标注）；无地址的在缩短/清空时用 `L0_NO_ADDRESS_NOTICE` 变体（正文未被改动时不加提示，不写假 eventId），且同一内容只留痕一次（键是「长度:首 32 字符」的内容指纹，有界集合上限 64、FIFO 淘汰最旧）。**阶梯**：级 0 不动 / 级 1 缩短 / 级 2 清空；级 2 的硬前提是有地址（无地址永停级 1）；保护区 `LADDER_PROTECTION_TURNS = 3` 按用户意图轮计（user/`bashExecution` 开轮，toolResult/assistant/custom/compactionSummary 不开轮；不足 3 轮全保护，`turns <= 0` 才关保护区），只挡级 2/级 3、不挡级 1。**回读分页改 token 口径**：`read_session_event` 的页大小与 L0 同源推导（`toolResultTokenBudget(window)`）、随窗口单调，不再是固定 8000 字符常数。级 3（摘要）前的闸门只在 `reason === "threshold"` 且级 1/2 压完装得下时 decline（不花摘要调用）；生产路径上目前由前置守卫（摘要范围为空）先拦截，闸门自身的 decline 分支不可达、不构成用户可见行为。Bash 在返回前可能已截断并生成会淘汰的 spill 文件，不能把这些文件等同于持久会话原文；见[工具输出边界](tool-system.md#文件命令与取消)。
- L1：整段摘要。切分范围不由本仓决定：「最旧的连续完整用户意图轮、工具批次不拆、保留窗口」都是上游 `findCutPoint` 的执行结果（`@earendil-works/pi-agent-core` 的 `harness/compaction/compaction.js`）；宿主只提供摘要内核（`before_compaction`，[compactor.ts](../../src/services/engine/compactor.ts)）与提交后的可解释结果。切分回合时上游把当前未完成回合的前半段单列（`turnPrefixMessages`），宿主用 `SPLIT_TURN_INSTRUCTION` 另段摘要。素材超硬上限时切成 K 片，逐片串行调摘要、以 `previousSummary` 迭代合并，最终一次提交一份摘要（提交仍只有一次）；片数上限 `MAX_COMPACTION_SLICES = 8`，超上限或存在不可再分且自身超硬上限的片段则 `CompactionOverflowError`（`code = "COMPACTION_MATERIAL_OVER_CAP"`）明确失败——零请求、零提交，不存在静默丢弃。
- L2：在无法再安全压缩时保留原文；如果核心输入仍超过硬上限，先走 Harness 的一次性溢出恢复（压缩后重试一次，见上），恢复用尽或没有可摘要范围时才返回可解释的上下文不足错误，不用占位文案伪装压缩成功。

静态 Card、V1RTUAL、完整工具 schema 和当前输入不按字符截断。画像/召回可以整块淘汰并记录预算原因（淘汰结果进快照的 `budgetDrops`，见[运行时契约](runtime-contract.md#快照与人格状态)）；未被摘要覆盖的 transcript 不得静默删除。`loop.contextCompactAt` 已从默认配置与 getter 移除，旧文件保留该键不影响新预算。

## 请求快照与长期记忆边界

回合冻结与三阶段 PromptSnapshot 由[运行时契约](runtime-contract.md#快照与人格状态)维护（审计条目的入队与 `flushAudit()` 的落盘边界同见该节）。摘要调用不计为正常聊天回复，但摘要请求同样进快照体系：有会话归属的一次性调用写 payload 与 usage 两档快照（`one-shot:<purpose>` 身份、`request.step = "compaction"`），压缩成功后另写一条 `deskpet.prompt_rewrite`（`compaction_summary`，只含输入/输出 hash、运行来源与压缩条目地址，压缩正文与素材都不落盘）。

`V1RTUAL.md` 是人工指令，与摘要分别建块：有 `## 指令` 小节时只取该节内容，没有则整份正文都算指令（手写文件不留标题也不能静默丢）；用户画像不再有独立文件，它就是记忆库里置顶的条目。应用启动、每五轮与 session 结束都不隐式发起记忆整理：整理只能由记忆面板手动触发（或在档位非「关」时按空闲条件自动运行），作业完成后自动提交合格候选，失败/冲突/取消保持明确终态。

当前实现入口为 [conversation.ts](../../src/services/agent/memory/conversation.ts)（会话原文索引与召回）、[harness-slot.ts](../../src/services/engine/harness/harness-slot.ts)（运行与压缩调度）、[compactor.ts](../../src/services/engine/compactor.ts)（摘要内核）、[session/repo.ts](../../src/services/session/repo.ts)（会话仓库）、[memory/](../../src/services/agent/memory/)（召回端口、来源收集、dreaming）、[instructions/](../../src/services/context/instructions/)（V1RTUAL）、[crates/native-host/src/memory/](../../crates/native-host/src/memory/)（SQLite 存储与治理命令）、[tool-output.ts](../../src/services/context/tool-output.ts)（L0 工具结果投影与回读地址）与 [delivery.ts](../../src/services/engine/harness/delivery.ts)（投递证据与上下文 epoch）；计划 checkpoint 与恢复扫描入口为 [checkpoint-store.ts](../../src/services/engine/plan/checkpoint-store.ts) 与 [runner.ts](../../src/services/agent/runner.ts) 的 `recoverPlanCheckpoints()`，恢复产出的继续/丢弃消费者 `resumePlan`/`discardPlan` 由 [runtime.ts](../../src/services/engine/harness/runtime.ts) 消费。

## 质量与资源证据

记忆质量以外部权威基准为**主口径**（memory-bench：LongMemEval／MemoryBank cn／LoCoMo，按分层节奏运行，报告是质量证据）；自建 80 题是**兜底冒烟与治理语义回归**，目前仍是待人工审计的合成标注草案。跑批、独立审阅门禁与 release 存储/debug IPC 性能脚本已接入[测试入口](../../test/README.md#trace记忆质量与性能门禁)。实际注入证据取请求预算裁剪后的 rendered IDs，提取与回答分开评分，无记忆/本地/always/adaptive/gold evidence 逐 cell 重建库并配对。采集完成不等于质量通过，缺审阅与缓存计数不能补成成功或零成本。

完整性/治理零失败、语义质量、重排收益与资源门槛分别判定；尚需修复的问题与完成条件见[未完成工作总表](../plans/active/未完成工作与已知缺口.md#3-长期记忆剩余)，测试结果由 `test/reports/` 报告与交付检查点承担，不在待办重复记录。当前尚不能宣称 adaptive 已带来收益；真实设置窗口、Windows 和 release UI/IPC 证据也不能由 Node 单测替代。
