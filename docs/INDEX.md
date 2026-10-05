# 文档索引

按任务选择入口，不默认把 README、DES、全部 current 一起载入上下文。源码与配置决定实际行为；“当前文档”说明核对过的实现，“计划”说明尚未完成的目标。历史文档归档后封存，不再读取或修改；问题与后续工作只维护在未完成总表。

## 阅读入口

| 要解决的问题 | 先读 | 需要时再读 |
|---|---|---|
| 安装、运行、能力概览 | [README](../README.md) | [工程参考](current/development.md) |
| 产品定位、Card/Profile 玩法、交互 | [DES](DES.md) 对应章节 | [人格与回复](current/personality.md)、[资源所有权](current/runtime-data.md) |
| 找模块、跟踪主调用链 | [系统地图](current/system-design.md) | 目标源码与对应 current 文档 |
| TypeScript 业务服务与 HostBridge 接线规则 | [services AGENTS](../src/services/AGENTS.md) | 目标领域 current 与源码 |
| Rust 宿主、原生 UI 与平台规则 | [native-host AGENTS](../crates/native-host/AGENTS.md) | [工程参考](current/development.md)与目标源码 |
| 会话队列、取消、恢复、Pi 接线、PromptSnapshot | [运行时契约](current/runtime-contract.md) | [记忆与压缩](current/memory.md)、[工具系统](current/tool-system.md) |
| 配置、路径、Profile 持久化 | [运行时数据](current/runtime-data.md) | Config getter、AppPaths 和目标设置 Tab |
| 数据库表结构、schema 版本、库文件与 WAL | [数据库](current/database.md) | 记忆与主动链同库；行为见[当前记忆](current/memory.md)、[主动陪伴](current/proactive.md) |
| 工具权限、MCP、Skill | [工具系统](current/tool-system.md) | PermissionKernel、Router、对应工具实现 |
| Pi 协议与 Harness 接线 | [运行时契约](current/runtime-contract.md) | [工具系统](current/tool-system.md)、目标源码与[未完成总表](plans/active/未完成工作与已知缺口.md) |
| 测试执行/验证边界 | [测试边界](current/testing.md) | [测试 README](../test/README.md)；生成契约时再读 [测试 SKILL](../test/SKILL.md) |
| 推 tag、发版、打包产物、自动更新 | [工作流说明](../.github/workflows/README.md) | [工程参考](current/development.md) 的「打包与发布」、`scripts/check-bundle-config.mjs`、`scripts/set-version.mjs` |
| 主动陪伴、事项跟进、行为画像 | [主动陪伴](current/proactive.md) | [行为画像](current/behavior.md)、[未完成总表](plans/active/未完成工作与已知缺口.md) §5.1 |
| 主动消息/静默了解/记忆整理的频率档位、锁屏可用、设置落 CONFIG | [频率档位执行契约](plans/active/主动陪伴与记忆频率档位执行契约.md) | [未完成总表](plans/active/未完成工作与已知缺口.md) §12；对应 current 与目标源码 |
| 原生宿主（Rust）+ 唯一 Node Harness、私有 IPC 与轻量化收尾 | [未完成总表](plans/active/未完成工作与已知缺口.md) §10 | [系统地图](current/system-design.md) 与目标源码；目标契约已归档（见下方历史入口） |
| 查看还剩哪些未完成工作、继续记忆重构 | [未完成工作与已知缺口](plans/active/未完成工作与已知缺口.md) | [当前记忆](current/memory.md)及相关源码（B 方案契约已归档） |

## 文档职责与维护

| 文档 | 只维护什么 |
|---|---|
| [AGENTS](../AGENTS.md) | 全局约束与任务阅读路由；不承担项目百科、详细测试教程或动态进度 |
| [services AGENTS](../src/services/AGENTS.md) | TS 业务层的状态、配置取用、HostBridge、运行时与工具约束 |
| [native-host AGENTS](../crates/native-host/AGENTS.md) | Rust 宿主的类型、平台、原生 UI、执行边界与同步义务 |
| [test AGENTS](../test/AGENTS.md) | 测试域的规则入口、分层、门禁与维护义务 |
| README | 用户安装、启动、能力简介与文档导航 |
| DES | 产品定位、玩法与用户可感知行为 |
| current | 已核对的模块契约、关键边界与源码入口；按主题分文档 |
| plans/active | 未完成工作总表与尚在实施的目标契约；不为单一主题另开文档 |
| history | 封存当时设计、旧实现和验证证据；归档后不再读取或修改 |

一个事实只有一个主要维护位置，其他文件用链接。每轮都核对 README、AGENTS、DES 与相关 current 的影响，受影响内容在同一改动中同步；新增规则改所属范围的 AGENTS，用户入口变化改 README，玩法变化改 DES，模块变更更新系统地图及受影响导航。未变化的文档不为同步而追加总结。

运行时 CONFIG 字段新增、改名、删除或语义变化同时执行[配置变更同步清单](current/runtime-data.md#配置变更同步清单)，覆盖 CONFIG、开发模板、类型/getter、设置页、保存与刷新消费者。真实本地配置需单独授权，未同步/未验证项在交付中说明。归档前保留正文和证据，归档后封存；未完成总表直接写清剩余事项与验收条件，不依赖跳转历史。

计划/归档文件用简短文件头说明用途、状态、日期及替代入口；核对日期不代表整个工作树已验证。报告必须区分源码基线、执行环境和未验证项，不把旧通过数复制到每份概览。历史文件可能带 archived 或 implemented_verified 等状态，所在 history 目录均表示它不再是当前行为契约。

根 AGENTS 只维护全局规则；services、native-host、test 的 AGENTS 各自维护本域约束，通过链接引用全局条款，避免重复。所有 CLAUDE.md 只写一行 `@agents.md`，导入同目录规则。模块细节通过任务路由按需读取；阅读路径的成本按实际文件 token 数评估，仓库 Markdown 总量不等于每轮 Prompt 注入量。

## 未完成工作

- [未完成工作与已知缺口](plans/active/未完成工作与已知缺口.md)：**唯一未完成工作总表**——Pi 剩余批次、平台与发布、长期记忆 B 方案的剩余验收、活人感与整链陪伴的剩余环境验收、已知代码缺口、验证缺口与已决策的不修边界。
- [主动陪伴与记忆频率档位执行契约](plans/active/主动陪伴与记忆频率档位执行契约.md)：主动消息/静默了解/记忆整理的根因修复（macOS 观察态恒 unavailable）、锁屏可用、三处「关/低/中/高」频率档位、设置全部落 CONFIG、带工具规划器、自带 MCP 与 Skill；含 8 条**执行前需用户确认**的开放问题与 W1–W5 分波验收。**实施尚未开始**，进度只在总表 §12 维护。
- [主动陪伴与记忆频率档位执行契约](plans/active/主动陪伴与记忆频率档位执行契约.md)：主动消息/静默了解/记忆整理的根因修复（macOS 观察态恒 unavailable）、锁屏可用、三处「关/低/中/高」频率档位、设置全部落 CONFIG、带工具规划器、自带 MCP 与 Skill；含 8 条**执行前需用户确认**的开放问题与 W1–W5 分波验收。**实施尚未开始**，进度只在总表 §12 维护。

## 历史入口

以下只保留归档目录索引，不作为后续任务的阅读入口；不再读取或修改这些文件。当前问题与进度只看未完成总表。

- [主题设计稿（三套预设）](history/design/theme-candidates.html)：三套主题预设（`brushed` / `chrome` / `verdigris`）的视觉基准与 55 个自定义属性取值。**例外说明**：它同时是 `crates/native-host/src/ui/theme/tokens.rs` 的 `include_str!` **编译期依赖**（常量 `DESIGN_DOC`），移动即编译失败；主题逐屏对照收尾前仍作视觉基准使用，改色值须与 `tokens.rs` 两处同改。2026-10-05 由 `docs/plans/active/` 移入，路径引用已全仓同步。
- [主题设计稿（两款 · 聊天面）](history/design/theme-candidates-2.html)：2026-10-05 聊天面板改版的视觉基准（`.rail` / `.insp` 等结构与尺寸），`macos_chat.rs` 三处注释引用；同批移入归档。
- [原生宿主轻量化执行契约 2026-10-04 基线](history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md)：用户已定功能边界、最终接口、源码映射与 W0–W11 执行/验收条件；**W0–W9 已实现后归档**，W10/W11 的验收条件、打包定案、L4 重接与资源口径已折入[未完成总表](plans/active/未完成工作与已知缺口.md) §10。
- [原生宿主迁移过程记录 2026-10-04 基线](history/implementation/原生宿主迁移过程记录-2026-10-04基线.md)：W0 只读盘点基线、W0/W1 已发现的问题、W0 冻结决定（含**仍具约束力的六条裁定**：Node 不得驱动窗口显隐与层级、不静默改线格式字段名、契约 sourceFiles 只指向 native-host、命令矩阵冻结流程、光标事件不进 Node 事件表、`window-observed` 双投）、W1 行为差异对照，以及功能对等接线批次与设置管理面的交付记录；W0–W9 实现落地后归档，剩余工作已转入未完成总表 §10。
- [活人感（拟人化）运行时契约 2026-10-04 基线](history/implementation/拟人化运行时契约-2026-10-04基线.md)：分条气泡、打字节奏、正在输入、回合分流、主动消息同路径与三个开关、静默了解、话题画像、主动纪律和图片输入的目标契约与自动验收检查点（§12）；实现完成后归档，剩余环境验收已转入未完成总表 §7。
- [主动陪伴运行时执行方案 2026-10-03 基线](history/implementation/主动陪伴运行时执行方案-2026-10-03基线.md)：完整目标契约、实现对照矩阵与检查点；核心链路已接入，核对后的实现与验收缺口已转入未完成总表，归档不表示完整验收。
- [记忆 check-in 与主动扫描器设计 2026-10-03 基线](history/design/记忆checkin与主动扫描器设计-2026-10-03基线.md)：原始功能／效果蓝图；旧数据结构、分轮安排及范围修订由执行基线的对照说明承接，不再作为当前指令。
- [测试分层重构契约 2026-09-29 基线](history/implementation/测试分层重构契约-2026-09-29基线.md)：推翻单一 Live 层的论证、L0–L5 目标分层、观测性与证据强度要求、测试树落位 `test/` 与跨层契约门禁；W0–W7 已实施后归档，三处未完成项（L4 端到端实跑、Windows CI job 真实触发、`entry: "unit"` 枚举值删除）已转登记到未完成总表。
- [Skill 与 Tool 收敛及模式统一方案 2026-09-26 基线](history/implementation/Skill与Tool收敛及模式统一方案-2026-09-26基线.md)：把 skill 换成 Pi 原生三层、tool 面优化与补齐、移除 pet/assistant 双模式的方案正文、决策定稿、覆盖矩阵与实测证据（2026-09-26 实施并通过严格门禁后归档）。
- [会话压缩与存储瘦身方案 2026-09-27 基线](history/implementation/会话压缩与存储瘦身方案-2026-09-27基线.md)：压缩分级重构与存储瘦身的设计真相源——六个问题的实测证据、唯一压缩判据、手段阶梯与日志折叠的改法论证（**设计冻结归档；实施由执行方案承接**）。
- [会话压缩与存储瘦身执行方案 2026-09-28 基线](history/implementation/会话压缩与存储瘦身执行方案-2026-09-28基线.md)：W1–W6 波次分解、跨波交接契约、覆盖矩阵与 §0.6 进度台账及终局门禁证据（2026-09-28 实施并通过严格门禁后归档）。
- [前舞台修复方案 2026-09-24 基线](history/implementation/前舞台修复方案-2026-09-24基线.md)：全仓审查的约 120 条发现、修复论证与 §7/§8 决策与验收设计（需求真相源）。
- [前舞台修复执行方案 2026-09-24 基线](history/implementation/前舞台修复执行方案-2026-09-24基线.md)：W1–W5 的波次分解、§0.6 进度台账、W5.0 执行结果、W5.2 未验证边界收口与附录 A 覆盖矩阵。正文内的 `plans/active/前舞台修复方案.md` 是当时路径，实体现为本目录的两份基线。
- [收尾清单 2026-09-20 基线](history/analysis/收尾清单-2026-09-20基线.md)：表情/动画/音效移除收尾、L3 与许可残留的决策论证、当时的验证缺口快照。
- [Pi 方案 2026-09-20 基线](history/implementation/Pi运行时与工具协议建设方案-2026-09-20基线.md)：PI-1/PI-2 协议正文、实施订正与验收设计。
- [执行手册 2026-09-20 基线](history/implementation/记忆系统重构执行手册-2026-09-20基线.md)：H-1–H-4 实现细节、06:58 轮证据与当时的未验证边界。
- [表情 / 动画 / 音效移除基线](history/implementation/表情动画音效移除-2026-09-20基线.md)：移除边界、保留范围，以及 `RUNTIME_DATA` 指令随情绪链被删的回归与处理（已实施并通过整轮门禁）。
- [加固计划 2026-09-20 基线](history/analysis/运行时加固与清理计划-2026-09-20基线.md)：2026-09-18 逐条复核后的剩余待办快照；剩余条目已迁入当前未完成工作总表。
- [轻量陪伴方案 2026-09-20 基线](history/design/轻量陪伴运行时与统一内核建设方案-2026-09-20基线.md)：A–E 已完成、F/G 待建时的方向快照。
- [AgentHarness 迁移方案基线](history/implementation/AgentHarness迁移方案-2026-09-18基线.md)：运行内核替换的协议、替换映射与 H-1–H-4 批次设计（已实施并通过集中验证）。
- [2026-09-18 执行手册基线](history/implementation/记忆系统重构执行手册-2026-09-18基线.md)：H-1–H-4 的实现与修复细节、集中验证收敛过程与当时的证据表。
- [会话压缩建设方案](history/implementation/会话压缩建设方案.md)：参考项目比较、压缩设计与当时的实施证据。
- [旧产品与技术说明](history/design/DES-2026-09-17基线.md)：DES 精简前正文。
- [旧统一内核总方案](history/design/轻量陪伴运行时与统一内核建设方案-2026-09-17基线.md)：原比较、论证和候选设计。
- [记忆系统运行时契约 2026-10-03 基线](history/implementation/记忆系统运行时契约-2026-10-03基线.md)：无向量分层记忆的设计口径、SQLite／来源／治理协议、dreaming、UI/配置接线与验收矩阵；已按当前实现归档，提案差异见文末 §14。
- [旧运行时契约](history/implementation/记忆系统运行时契约-2026-09-17基线.md)、[旧执行手册](history/implementation/记忆系统重构执行手册-2026-09-17基线.md)：原阶段协议、接力记录与证据。
- [加固审查基线](history/analysis/运行时加固与清理计划-2026-09-17基线.md)：原缺陷、修复批次、历史行号与当时决策。
- [愿景驱动重构方案](history/design/愿景驱动整体重构方案.md)：早期设计；其中纯 Markdown 和 Pi 候选结论已被后续方案替代。

其他材料按 `history/design/`、`history/implementation/`、`history/analysis/`、`history/source/` 保存；目录与文件名用于检索，不将某篇旧全仓审查称为当前实现基线。
