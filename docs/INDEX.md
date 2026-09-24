# 文档索引

按任务选择入口，不默认把 README、DES、全部 current 与历史方案一起载入上下文。源码与配置决定实际行为；“当前文档”说明核对过的实现，“计划”说明尚未完成的目标。

## 阅读入口

| 要解决的问题 | 先读 | 需要时再读 |
|---|---|---|
| 安装、运行、能力概览 | [README](../README.md) | [工程参考](current/development.md) |
| 产品定位、Card/Profile 玩法、交互 | [DES](DES.md) 对应章节 | [人格与回复](current/personality.md)、[资源所有权](current/runtime-data.md) |
| 找模块、跟踪主调用链 | [系统地图](current/system-design.md) | 目标源码与对应 current 文档 |
| 会话队列、取消、恢复、Pi 接线、PromptSnapshot | [运行时契约](current/runtime-contract.md) | [记忆与压缩](current/memory.md)、[工具系统](current/tool-system.md) |
| 配置、路径、Profile 持久化 | [运行时数据](current/runtime-data.md) | Config getter、AppPaths 和目标设置 Tab |
| 工具权限、MCP、Skill | [工具系统](current/tool-system.md) | PermissionKernel、Router、对应工具实现 |
| 查 Pi 协议与 Harness 迁移的原设计 | [Pi 方案 2026-09-20 基线](history/implementation/Pi运行时与工具协议建设方案-2026-09-20基线.md)对应章节 | 当前 runtime/tool/memory 契约与源码 |
| 测试执行/验证边界 | [测试边界](current/testing.md) | [Live README](../src/services/__tests__/live/README.md)；生成契约时再读 [SKILL](../src/services/__tests__/live/SKILL.md) |
| 查看还剩哪些未完成工作、继续记忆重构 | [未完成工作与已知缺口](plans/active/未完成工作与已知缺口.md) | [P6 目标契约](plans/active/记忆系统运行时契约.md)、[执行手册基线](history/implementation/记忆系统重构执行手册-2026-09-20基线.md)及相关源码 |
| 追溯旧方案、比较项目与实施证据 | 下方历史入口 | 只读关联章节，历史命令与授权不自动生效 |

## 文档职责与维护

| 文档 | 只维护什么 |
|---|---|
| [AGENTS](../AGENTS.md) | 全局约束与任务阅读路由；不承担项目百科、详细测试教程或动态进度 |
| README | 用户安装、启动、能力简介与文档导航 |
| DES | 产品定位、玩法与用户可感知行为 |
| current | 已核对的模块契约、关键边界与源码入口；按主题分文档 |
| plans/active | 未完成工作总表与尚在实施的目标契约；不为单一主题另开文档 |
| history | 当时设计、旧实现和验证证据；不随新代码反复改写正文 |

一个事实只有一个主要维护位置，其他文件用链接。每轮都核对 README、AGENTS、DES 与相关 current 的影响，受影响内容在同一改动中同步；新增规则改 AGENTS，用户入口变化改 README，玩法变化改 DES，模块变更更新系统地图及受影响导航。未变化的文档不为同步而追加总结。

运行时 CONFIG 字段新增、改名、删除或语义变化同时执行[配置变更同步清单](current/runtime-data.md#配置变更同步清单)，覆盖 CONFIG、开发模板、类型/getter、设置页、保存与刷新消费者。真实本地配置需单独授权，未同步/未验证项在交付中说明。完成计划后保留正文和证据归档，active 留后续事项及跳转。

计划/归档文件用简短文件头说明用途、状态、日期及替代入口；核对日期不代表整个工作树已验证。报告必须区分源码基线、执行环境和未验证项，不把旧通过数复制到每份概览。历史文件可能带 archived 或 implemented_verified 等状态，所在 history 目录均表示它不再是当前行为契约。

AGENTS 维持全局规则入口，CLAUDE 只导入它；模块细节通过任务路由按需读取，不建立互相重复的子目录规则。阅读路径的成本按实际文件 token 数评估，仓库 Markdown 总量不等于每轮 Prompt 注入量。

## 未完成工作

- [未完成工作与已知缺口](plans/active/未完成工作与已知缺口.md)：**唯一未完成工作总表**——Pi 剩余批次、平台与发布、已知代码缺口、验证缺口、P6 与当前验证证据。
- [P6 目标契约](plans/active/记忆系统运行时契约.md)：候选、来源、受控召回、纠正/遗忘与评测要求；这些目标尚未成为运行时能力。
- [Skill 与 Tool 收敛及模式统一方案](plans/active/Skill与Tool收敛及模式统一方案.md)：把 skill 换成 Pi 原生三层、tool 面优化与补齐、移除 pet/assistant 双模式的实施前方案（决策已定，尚未实施）。

## 历史入口

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
- [旧运行时契约](history/implementation/记忆系统运行时契约-2026-09-17基线.md)、[旧执行手册](history/implementation/记忆系统重构执行手册-2026-09-17基线.md)：原阶段协议、接力记录与证据。
- [加固审查基线](history/analysis/运行时加固与清理计划-2026-09-17基线.md)：原缺陷、修复批次、历史行号与当时决策。
- [愿景驱动重构方案](history/design/愿景驱动整体重构方案.md)：早期设计；其中纯 Markdown 和 Pi 候选结论已被后续方案替代。

其他材料按 `history/design/`、`history/implementation/`、`history/analysis/`、`history/source/` 保存；目录与文件名用于检索，不将某篇旧全仓审查称为当前实现基线。
