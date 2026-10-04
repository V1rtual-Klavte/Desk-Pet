# 数据库（记忆与主动链状态共库）

全产品只有一个 SQLite 库：`数据根/memory/memory.sqlite3`，长期记忆与主动陪伴状态同库同文件（两侧建表在同一次打开里完成、共用同一连接）。两侧的**行为与治理语义**分别归[当前记忆](memory.md)与[主动陪伴](proactive.md)；本文件只记**库级事实**：打开与文件、建表点、表清单、版本策略与备份校验。

## 打开与文件

- 打开点：Rust 启动装配（`lib.rs`）在路径就绪后立刻打开，建表与版本校验都在启动时完成——schema 不兼容要在启动时就说清楚，不能让第一轮召回才发现库是坏的；**打开失败会中止启动**（装配路径直接返回错误），不静默降级、不半启动。
- 打开参数：`foreign_keys = ON`、`journal_mode = WAL`、`synchronous = NORMAL`。
- 库文件：`memory.sqlite3`；`-wal` / `-shm` 是 WAL 模式的伴生文件（`paths::is_managed_memory_path` 一并纳管）。应用运行期间新结构和新数据先落 `-wal`，主文件要等干净退出（最后一次 checkpoint）才合并——外部查看器排查时请带上伴生文件，或退出应用后再打开；只复制主文件会看到空库。
- 写入并发：单连接（`MemoryStore` 持 `Mutex<Connection>`），写入一律走事务；两侧各有 `operation_id` 幂等账本，提交结果未知时先查账、不盲重放。
- 备份与恢复走 SQLite 备份接口（不复制写入中的主文件），并单独校验 schema 版本，不匹配的备份不应用。

## 建表点与版本策略

- 生产建表点只有两个：记忆侧 [memory/schema.rs](../../src-tauri/src/memory/schema.rs)、主动链侧 [proactive/schema.rs](../../src-tauri/src/proactive/schema.rs)；记忆侧 `ensure` 建完自己的表后调用主动链侧的 `ensure`。列定义与设计约束以这两个文件为准，本文件不复制结构定义（`proactive/store.rs` 里的建表语句属于 `#[cfg(test)]` 夹具，不是生产路径）。
- 版本：`MEMORY_SCHEMA_VERSION`（当前 2，定义在 [memory/protocol.rs](../../src-tauri/src/memory/protocol.rs)）存于 `memory_meta.schema_version`；打开时校验，**不一致拒绝以旧格式继续**。开发阶段不做数据迁移、不建兼容层——处理方式是删掉 `memory.sqlite3` 连同 `-wal` / `-shm` 后重建（旧数据可弃）。
- 同一版本内的结构演进用「检测缺列 → `ALTER TABLE` 补列（带默认值）」，不重置既有行。

## 表清单

记忆侧（[memory/schema.rs](../../src-tauri/src/memory/schema.rs)）：

| 表 | 职责 |
|---|---|
| memory_meta | 库级元数据（key-value）：schema_version、revision、forget_epoch |
| memory_items | 已接受记忆事实，召回的唯一条目来源；行按 id+version 版本化，带 status/kind/scope、正文/摘要/别名、pinned（核心画像标记）/importance/confidence、有效期与 supersedes 链 |
| memory_sources | 来源登记：候选与事实引用的会话条目身份（session/entry/event/seq/content_hash/taint/origin/card_id），同一事件按 (session, entry, hash) 唯一 |
| memory_item_sources | 事实 ↔ 来源关联（随 item 版本级联删除） |
| memory_candidates | Review 产出的 staging 候选：提交事务前只存在这里，不进 FTS、不进召回 |
| memory_jobs | dreaming 作业账本：phase/status/revision/forget_epoch、租约、cursor 与当日用量 |
| memory_watermarks | 来源消费水位（session → 已处理 seq），水位补扫的判定依据 |
| memory_tombstones | 遗忘墓碑：稳定事件身份（session+entry+content_hash+effect），拦住索引重建、旧水位补扫与旧批次发布让内容复活 |
| memory_operations | operation_id 幂等账本：提交结果未知时先查它，不盲重放 |
| memory_dreaming_budgets | dreaming 每日模型预算（按自然日记录 reserved/used） |
| memory_dreaming_reservations | 预算租约（reserved/settled） |
| memory_fts（+5 张 FTS5 影子表） | 全文索引：正文/摘要/别名，trigram 分词；工具输出与原始 JSON 不建索引 |

主动链侧（[proactive/schema.rs](../../src-tauri/src/proactive/schema.rs)）：

| 表 | 职责 |
|---|---|
| proactive_meta | 库级元数据（revision） |
| proactive_tasks | 已确认的事项与任务：版本化（id+version）、scope 与来源引用、意图、due/checkin/时区/周期、状态、失效代、幂等 operation_id |
| proactive_evaluations | 机会评估快照：按来源指纹去重（rule_id、来源引用、决定、有效期、来源 revision） |
| proactive_topics | 已用话题登记（topic_key + used_at），话题去重的判定依据 |
| proactive_source_registry | 来源登记（kind+source_id → 版本、revision、scope、指纹、有效期） |
| proactive_attempts | 主动尝试账本：request_id 唯一，携带来源指纹与控制 revision、额度与本地日、session 与送达回执（assistant_entry_id）、租约、用量与错误 |
| proactive_attempt_occurrences | 尝试 ↔ 机会实例的关联（随尝试级联删除） |
| proactive_occurrences | 机会实例（kind/status/retry_after），重试调度依据 |
| proactive_control | 主动总开关单行表（id=1：enabled、mute_until、revision），命令与设置页共用同一行 |
| proactive_budgets | 每日预算与用量（规划/表达尝试、成功消息与上限、token 预留/已用/未知、观察与话题尝试、下一次成功间隔） |
| proactive_auxiliary_reservations | 辅助模型（observation/topic）调用租约：reserved/unresolved/committed/failed |
| proactive_operations | operation_id 幂等账本（提交结果未知时先查，不盲重放） |
