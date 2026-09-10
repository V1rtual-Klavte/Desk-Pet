# 文档索引

本目录按文档用途组织。代码与配置是运行行为的最终依据；文档用于说明已验证的现状、记录待实施方案和保存历史决策。

## 当前文档

- [DES.md](DES.md)：项目总览、玩法、交互与平台能力，面向项目负责人阅读。
- [当前系统设计](current/system-design.md)：当前模块边界、主链路和运行时数据契约。
- [当前工具系统](current/tool-system.md)：Pi 基础工具、双模式策略、Tauri 执行环境与验证边界。
- [当前记忆系统](current/memory.md)：记忆系统已接通的能力、已知缺口和后续路线。
- [当前测试说明](current/testing.md)：Live Test 的执行方式、覆盖范围与验证边界。

## 计划与历史

- [愿景驱动整体重构方案](plans/active/愿景驱动整体重构方案.md)：当前总方案，覆盖可组合桌宠、Pi Runtime、纯 Markdown 记忆、安全、资源和全项目迁移。
- [Pi Agent 内核迁移设计](plans/active/pi-agent-迁移设计.md)：待 PoC 决策的 Pi Core 迁移目标、边界、资源验证和 Coding 能力路线。
- [Pi Agent 能力替换与运行链路设计](plans/active/pi-agent-能力替换与运行链路设计.md)：队列、Pi AI Provider、工具协议、UI 事件和上下文压缩的下一阶段方案。
- `plans/active/`：尚未实施的计划。计划完成后移入历史目录。
- `history/design/`：过去的设计与 PRD，保留当时的取舍和细节。
- `history/implementation/`：已完成的实施计划与修复记录，正文不再按当前代码维护。
- `history/analysis/`：特定日期的现状分析和审查报告。
- `history/source/`：原始外部文档。

历史 Markdown 文档文件头均标记为 `archived`；`history/source/` 保存的原始文件按文件格式保留。它们不构成当前实现契约，阅读当前行为时优先使用本目录的当前文档和源码。

最新全仓阶段审查：[阶段现状（2026-08-06）](history/analysis/阶段现状-2026.8.6.md)。
