---
name: live-test
description: Desk-Pet Live Test 的 Contract 分析、Scene 生成与覆盖审查流程。
---

# Live Test 工作流

运行命令、执行环境和 Scene 规范以 [README.md](./README.md) 为权威。本文件只定义代码代理在源码变更后如何分析 Contract、生成 Scene 和审查覆盖；它不是 shell 脚本。

## 触发词

- `/analyze test [module]`：从当前源码重新分析 Contract。
- `/generate test [module]`：按 Contract 补充或修订 Scene。
- `/audit test [--strict]`：审查 Contract 与 Scene 的引用和覆盖质量。

## `/analyze test [module]`

1. 确定受影响模块和跨模块调用链；读取当前 `contracts/{module}.contract.ts`、其 `sourceFiles` 与相关 Scene。
2. 分析当前公开行为、状态转换、持久化、取消/错误分支、边界值和平台差异。不要把计划文档中的 P6 或未接通能力写成已实现。
3. 更新 `sourceFiles`，使其覆盖行为实际所在的源码；覆盖点描述当前可验证行为，不以文件名替代行为。
4. 为每个 coverage point 设置唯一 id、`depth` 与 `scenarios`。`scenarios` 填已存在或将创建的 Scene **caseId**。
5. 根据实际风险设置 `minScenarios`、`minDeepScenarios`、`requireBoundary`、`requireErrorPath`。只有确实无法经运行时入口触达时才声明 `unitOnly`，并写明 `unitOnlyReason`。
6. 按项目的 source hash 计算方式刷新 `sourceHash`。不能只改 hash 而不完成前述行为审查。

## `/generate test [module]`

1. 读取目标 Contract、`sourceFiles` 和相关实现，确认每个 coverage point 的输入、输出、状态和副作用。
2. 为每个 coverage point 创建或更新 Scene；`meta.module` 必须等于 Contract module，`meta.contractId` 必须等于 coverage point id，`meta.caseId` 为全局稳定的小写 kebab-case。
3. 选择入口：完整聊天产品路径使用 `production`；运行时适配层使用 `runtime`；纯确定性逻辑使用 `unit`。不要以 unit 替代本该覆盖的产品链路。
4. 需要可重复模型输出时使用 fake Provider；它仍应经过真实运行时和工具链。需要验证真实模型能力时使用真实 Provider，并把模型不稳定性与产品失败区分开。
5. 断言用户可见结果之外的真实证据：工具调用状态、确认记录、会话事件、文件回读、变量状态、取消或错误结论。安全场景不执行破坏操作，只验证实际调用被受控拒绝。
6. Contract 要求边界或错误路径时，在对应 Scene 加 `boundary`、`error` tag；不要仅在描述文字中声称覆盖。
7. Scene 集合改变后更新 `dataset.ts` 的版本。

## `/audit test [--strict]`

1. 检查每个 Contract 的 `sourceFiles` 是否仍覆盖当前实现，并确认 `sourceHash` 与审查后的源码一致。
2. 检查每个 `coverage.scenarios` 是否是已发现的 caseId，且其 module/contractId 精确匹配。
3. 检查深度、边界、错误与非 unit 入口要求是否由真实 Scene metadata 满足；审查 `unitOnly` 是否仍有充分理由。
4. 审阅断言是否真正观测目标状态或副作用，避免“回复非空”“未报错”之类无法证明能力的断言。
5. 输出缺口、风险、建议补充的 Scene 与尚不可验证的能力。严格审查时，任何 GAP 都不能报告为已通过。

## 当前 Contract 模块

当前目录包含以下 Contract：

- `agent-runtime`
- `harness-storage`
- `memory`
- `personality-card`
- `planner`
- `safety`
- `tool-execution`
- `variable-pool`

新增模块时先新增 Contract 和至少一个关联 Scene，再把它加入此列表；不因历史通过记录或计划阶段名称推断其已验证。
