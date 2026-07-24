---
name: live-test
description: Desk-Pet Live Test Framework — AI 自驱动端到端测试。分析源码生成覆盖契约和测试场景，用真 LLM 模拟对话验证系统行为。
---

# Live Test Framework Skill

## 触发

- `/analyze test [module]` — AI 分析源码 → 生成覆盖契约 (Contract)
- `/generate test [module]` — AI 读 Contract → 生成测试场景 (Scene)
- `/audit test [--strict]` — AI 审视覆盖完整性
- "跑测试" / "运行 live test" → 执行 `pnpm test`

## 工作流程

### `/analyze test [module]`

1. 读取指定模块（或全部 8 个模块）的源码文件
2. 对照 `src/services/__tests__/live/types.ts` 中 `ModuleContract` 和 `CoveragePoint` 类型
3. AI 分析：
   - 导出函数/方法 → 每个公开 API 一个 coverage point
   - 分支路径 (if/switch/try-catch) → 每个分支一个 coverage point
   - 边界值 (min/max/enum/范围校验) → 边界 coverage point
   - 错误路径 (返回 false/error) → 错误 coverage point
   - 深度判定: 有状态变化的 → deep; 纯计算/查询的 → shallow
4. 计算所有 sourceFiles 的 sha256 hash
5. 生成 `ModuleContract` 写入 `src/services/__tests__/live/contracts/{module}.contract.ts`
6. 设置合理的 `rules`:
   - minScenarios: coverage points 数量的 80% (至少 2)
   - minDeepScenarios: deep points 数量的 100% (至少 1)
   - requireBoundary: true
   - requireErrorPath: true

### `/generate test [module]`

1. 读取指定的 contract 文件
2. 对每个 coverage point:
   - 读 contract: { id, feature, description, why, depth }
   - 读相关源码 (contract.sourceFiles)
   - AI 生成 SceneDef 文件要求:
     - 用户消息自然口语化，像真人聊天
     - deep 场景必须多轮对话，包含对比
     - 每轮必须断言: 回复输出 + 内部状态 + 副作用
     - 边界测试构造触发边界的对话
     - 错误路径构造触发错误的对话
   - 生成 .scene.ts 文件写入 `src/services/__tests__/live/scenes/{module}/`
   - 回写 contract: coverage.scenarios[] 填充文件名

### `/audit test [--strict]`

1. 读取所有 contract 文件
2. 运行 contract-checker 检查 (STALE / MISSING / GAP)
3. AI 额外审视: 覆盖完整性、深度、边界、错误路径
4. 输出报告
5. `--strict` 时: 有 GAP 直接报错

## 覆盖的 8 个模块

| 模块 | 源文件 |
|------|--------|
| variable-pool | `src/services/personality/variable-pool.ts`, `src/services/personality/types.ts` |
| when-engine | `src/services/personality/when-engine.ts` |
| emotion | `src/services/personality/emotion.ts` |
| safety | `src/services/safety/checker.ts` |
| memory | `src/services/agent/memory/index.ts`, `src/services/agent/memory/memory-entries.ts` |
| planner | `src/services/engine/planner.ts` |
| tool-execution | `src/services/tool/router.ts`, `src/services/tool/registry.ts` |
| personality-card | `src/services/personality/registry.ts`, `src/services/personality/loader.ts` |

## 约束

- Contract 和 Scene 文件均由 AI 生成，每次 analyze 必须重新审视
- 生成完成后提示用户 review，用户确认后提交
- 如果源码 hash 变化但不重新 analyze，pnpm test 会报 [STALE] 并拒绝执行
