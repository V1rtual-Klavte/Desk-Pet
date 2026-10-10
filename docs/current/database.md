# 数据库（记忆与主动链状态共库）

全产品只有一个 SQLite 库：`数据根/memory/memory.sqlite3`，长期记忆与主动陪伴状态同库同文件（两侧建表在同一次打开里完成、共用同一连接）。两侧的**行为与治理语义**分别归[当前记忆](memory.md)与[主动陪伴](proactive.md)；本文件只记**库级事实**：打开与文件、建表点、表清单、版本策略与备份校验。

## 打开与文件

- 打开点：**命令分派器惰性打开**（[host/dispatch.rs](../../crates/native-host/src/host/dispatch.rs) 的 `NativeDispatcher::memory()`）——第一条记忆命令到达时才打开；打开失败如实透出原错误（含 `MEMORY` 码），不缓存失败结论、下一条命令会重报同一个错误（不降级、不假成功）。`--smoke` 不触库。用短锁串行化并发首开。
- 打开参数：`busy_timeout = 750ms`；[memory/schema.rs](../../crates/native-host/src/memory/schema.rs) 的 `ensure` 设 `foreign_keys = ON`、`journal_mode = WAL`、`synchronous = NORMAL`。
- 库文件：`memory.sqlite3`；`-wal` / `-shm` 是 WAL 模式的伴生文件（`paths::is_managed_memory_path` 一并纳管，通用文件工具不能绕过 MemoryStore 改写）。应用运行期间新结构和新数据先落 `-wal`，主文件要等干净退出（最后一次 checkpoint）才合并——外部查看器排查时请带上伴生文件，或退出应用后再打开；只复制主文件会看到空库。
- 写入并发：单连接（`MemoryStore` 持 `Mutex<Connection>`，锁中毒按恢复处理而非 panic），写入一律走事务；两侧各有 `operation_id` 幂等账本，提交结果未知时先查账、不盲重放。
- 备份与恢复走 SQLite 备份接口（不复制写入中的主文件）；恢复前与预览都校验备份的 `schema_version` 与必需表集合，不匹配的备份不应用；恢复时把「当前生效的遗忘墓碑」带过去，旧快照不能复活已忘内容。

## 建表点与版本策略

- 生产建表点只有两个：记忆侧 [memory/schema.rs](../../crates/native-host/src/memory/schema.rs)、主动链侧 [proactive/schema.rs](../../crates/native-host/src/proactive/schema.rs)；记忆侧 `ensure` 建完自己的表后调用主动链侧的 `ensure`（`proactive/store.rs` 里的建表语句属于 `#[cfg(test)]` 夹具，不是生产路径）。
- 版本：`MEMORY_SCHEMA_VERSION`（当前 3；2026-10-05 频率档位批随 `proactive_control.enabled` 列删除从 2 递增）存于 `memory_meta.schema_version`；常量的生成链是单向的：源定义在 [src/services/agent/memory/protocol.json](../../src/services/agent/memory/protocol.json)，由 [scripts/generate-memory-protocol.mjs](../../scripts/generate-memory-protocol.mjs) 生成到 [memory/protocol.rs](../../crates/native-host/src/memory/protocol.rs)（该文件头注明 Generated，不手改）。启动时以及恢复提交后的活动库，会用记忆侧与主动链侧现有 DDL 构造期望结构，事务内补齐可无损添加的字段/表/索引并搬回既有列数据；不可恢复的事实、来源或遗忘治理缺失会明确失败，未知未来 schema_version 永不降级。显式选择的备份仍须通过已有 schema_version 和必需表校验。**派生结论批（2026-10-06）不涉版本变更**：条目/来源类别 `origin` 不落额外列（由来源类别派生），旧库照常打开，无需重建。
- 既有库首次需要结构修复前，MemoryStore 通过 SQLite backup API 在 `memory/backups/` 预留 `memory-repair-*.sqlite3` 快照；修复事务失败会回滚且保留快照，修复完成后的重复打开不会重复备份。事实 `memory_fts` 从已接受的 `memory_items` 重建；会话 FTS 与索引行属于可重建缓存，JSONL 仍是聊天正文真相源。恢复也会在提交后复核活动库结构。
- 若清理来源清单曾声明完整但 fence 丢失，或缺失记忆作业/墓碑/来源关系、主动控制/预算等核心持久状态，启动不会创建空表掩盖缺口；会保留原库与诊断快照并返回可诊断错误。唯一同版本新增的可选模块例外是 `mcp_credentials`：缺表时可恢复空结构并保留修复前快照，`rust_warn!` 会说明原凭据无法由数据库重建，需重新录入或从备份恢复；应用不会伪造或声称恢复凭据值。旧库没有会话索引元数据时，clear 时间从操作/墓碑账本恢复；没有完整会话清单时只开放可证明晚于 cutoff 的缓存，TS 后续 clear 会提交稳定 seq fence。
- 同一版本内的已知安全增列仍以 nullable 或有默认值的字段为主，不重置既有行（主动链的 `proactive_budgets` 增列即此模式）；会话检索表随 `ensure` 创建，不改 schema_version。

## 表清单

记忆侧（[memory/schema.rs](../../crates/native-host/src/memory/schema.rs)）：

| 表 | 职责 |
|---|---|
| memory_meta | 库级元数据（key-value）：schema_version、revision、forget_epoch |
| memory_items | 已接受记忆事实，召回的唯一条目来源；行按 id+version 版本化，带 status/kind/scope、正文/摘要/别名、pinned（核心画像标记）/importance/confidence、有效期与 supersedes 链；**不存 origin 列**——条目类别由来源类别唯一派生（user / derived_behavior） |
| memory_sources | 来源登记：候选与事实引用的会话条目身份（session/entry/event/seq/content_hash/taint/origin/card_id），同一事件按 (session, entry, hash) 唯一；origin 按成对约束分两类：`user` + `trusted_user`（用户可信输入）、`derived_behavior` + `derived`（画像稳定结论，合成会话 `behavior`），错配拒收，两类不混池 |
| memory_item_sources | 事实 ↔ 来源关联（随 item 版本级联删除） |
| memory_candidates | Review 产出的 staging 候选：提交事务前只存在这里，不进 FTS、不进召回 |
| memory_jobs | dreaming 作业账本：phase/status/revision/forget_epoch、租约、cursor 与当日用量 |
| memory_watermarks | 来源消费水位（session → 已处理 seq，单调 MAX 推进；整理 checkpoint 按**本批实际处理的每个会话**各自推进，不只批尾游标所在会话），水位补扫的判定依据 |
| memory_tombstones | 遗忘墓碑：稳定事件身份（session+entry+content_hash+effect），拦住索引重建、旧水位补扫与旧批次发布让内容复活 |
| memory_operations | operation_id 幂等账本：提交结果未知时先查它，不盲重放 |
| memory_dreaming_budgets | dreaming 每日 token 账（按自然日记录 reserved/used；只记账观测，不参与准入——2026-10-06 起日上限不再是门禁） |
| memory_dreaming_reservations | token 预留租约（reserved/settled；只记账） |
| mcp_credentials | MCP 凭据（主键 server + var → value）：服务器 headers 模板 `${VAR}` 的定向存取；值不写 CONFIG、不回显、不落日志，唯一出口是连接期注入的 `mcp_credential_get`（[commands/mcp_credentials.rs](../../crates/native-host/src/commands/mcp_credentials.rs)）；`ensure` 每次打开执行（未动 schema_version，旧库只多一张表）；若表缺失，只补空结构并记录警告，值需重新录入或从备份恢复；与记忆同库，随库备份/恢复一并带出 |
| memory_fts（+5 张 FTS5 影子表） | 全文索引：正文/摘要/别名，trigram 分词；工具输出与原始 JSON 不建索引 |
| conversation_index_meta | 会话索引自己的 revision、clear cutoff 与完整清空来源清单标记；不推进事实记忆 revision |
| conversation_index_sessions | 每个会话当前索引指纹；replace 以旧指纹和 forgetEpoch 做 CAS |
| conversation_index_entries | read-model 投影出的 user/assistant 文本片段，含 chunk、稳定来源身份与可选助手锚点；JSONL 仍是正文真相源 |
| conversation_index_suppressions | forget 后保留的 session/entry/event 身份，阻止重建找回原条目及同轮助手回应 |
| conversation_index_clear_fences | 清空时每个原会话的稳定 seq 上界，空会话用 -1；后续新来源不依赖墙钟时间判定 |
| conversation_index_staging_batches | 分批索引的快照身份、指纹/遗忘代CAS、偏移与完成回执；只在 complete 后原子发布 |
| conversation_index_staging_entries / conversation_index_staging_calls | 未发布片段与幂等批次回执；不参加检索，删除源会话或清空时级联清理，遗留批次按TTL回收 |
| conversation_fts | 会话片段全文检索索引，trigram 分词；短词另用参数化 LIKE 回退 |

主动链侧（[proactive/schema.rs](../../crates/native-host/src/proactive/schema.rs)）：

| 表 | 职责 |
|---|---|
| proactive_meta | 库级元数据（revision） |
| proactive_tasks | 已确认的事项与任务：版本化（id+version）、scope 与来源引用、意图、due/checkin/时区/周期、状态、失效代、幂等 operation_id |
| proactive_evaluations | 机会评估快照：按来源指纹去重（rule_id、来源引用、决定、有效期、来源 revision） |
| proactive_topics | 已用话题登记（topic_key + used_at + 产生它的 attempt），话题去重的判定依据 |
| proactive_source_registry | 来源登记（kind+source_id → 版本、revision、scope、指纹、有效期） |
| proactive_attempts | 主动尝试账本：request_id 唯一，携带来源指纹与控制 revision、额度与本地日、session 与送达回执（assistant_entry_id）、租约、用量与错误 |
| proactive_attempt_occurrences | 尝试 ↔ 机会实例的关联（随尝试级联删除） |
| proactive_occurrences | 机会实例（kind/status/retry_after），重试调度依据 |
| proactive_control | 运行期控制单行表（id=1：mute_until、revision）：暂停与清除来源状态；主动开关已并入 CONFIG `ai.proactive.frequency` 档位，`enabled` 列 2026-10-05 删除 |
| proactive_budgets | 每日预算与用量（规划/表达尝试、成功消息与上限、token 预留/已用/未知 —— 只记账观测，不参与准入、观察与话题尝试、下一次成功间隔） |
| proactive_auxiliary_reservations | 辅助模型（observation/topic）调用租约：reserved/unresolved/committed/failed |
| proactive_operations | operation_id 幂等账本（提交结果未知时先查，不盲重放） |
