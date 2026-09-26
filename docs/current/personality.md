# 人格、变量与回复

用途：修改 Card、角色状态、阶段文案或回复效果时核对边界。Card 定义与 UI 玩法见 [DES](../DES.md#2-cardprofile-与用户记忆)，文件位置见[运行时数据](runtime-data.md)。

## 所有权

| scope | 值的来源 | 存储表示 | LLM 能否写入 |
|---|---|---|---|
| system | 时间、活动 Card 等运行时派生数据 | 原始值 | 否 |
| card | Card 的 variableDefs 注册表 | VariableState | 仅 updateBy=llm 的已注册字段 |
| interaction | 系统维护的互动状态 | VariableState | 否 |

精确类型见 [types.ts](../../src/services/personality/types.ts) 的 `CardVariableDef`、`VariableState`。VariableState 保存 value/type/updatedAt/updatedBy；重置游标（`lastDailyResetKey`/`sessionKey`）随 Card 的 `variables` 段持久化，不逐变量记账；会话级重置（`reset: session`）的判定键是当前会话的 `createdAt`（`getSessionCreatedAt`，来自 `SessionMeta`，读不到则不做判定），游标随变量区持久化。

card/interaction 状态保存在 `personality/stages/{cardId}.json` 的变量区，两段由 [stages-file.ts](../../src/services/personality/stages-file.ts) 单一读写：段级合并，两个生产者互不抹除；`vars.json` 不再写入。用户长期事实不存入角色变量。

## Card 加载与切换

[loader.ts](../../src/services/personality/loader.ts) 从运行时 cards 目录读取和解析 Card，包内 defaults 只作首次初始化种子。[registry.ts](../../src/services/personality/registry.ts) 的 `switchPersonality()` 先准备阶段文案与变量池，成功后改变活动 Card；失败恢复旧 Card、变量池（含变量注册表）与阶段缓存。设置页展开 Card 只构建局部预览快照，不改动全局变量池所有权。

默认种子提供 neutral 中性选择；没有可用 Card 时允许无活动 Card 降级运行。`whenText` 是自然语言语气指引；mustRules 参与 Prompt 构建，不是一套任意执行脚本。

阶段文案先读持久化缓存，缺失时可经模型生成；任一 Card 首次激活或角色设定/语言风格变化时会重新生成一次（一次 LLM 调用/卡）。失效判定键是生成输入 `sourceHash`（`SHA-256(roleSetting + "\n" + languageStyle)`），`version:` 只作元数据、不参与判定；重新生成只覆写 stages 段，不清空变量区。

**用户可见的阶段与兜底文案只有 Card 一个来源**，取用点固定为四个 getter：

| getter | 覆盖面 | 消费点 |
|---|---|---|
| `getStagePrompt(stage, category)` | `executing` / `done` / `blocked` 的工具类别映射 | ChatPanel 的工具状态提示位 |
| `getSimpleStage(key)` | `thinking` / `planning` / `error` / `retry` 状态行 | 同上（`thinking` 来自每轮 `turn_start`，`planning` 来自计划阶段入口，`retry` 来自 Harness `retry_start`） |
| `getCommandReply(key)` | `commands` 段的 slash 命令输出 | `/clear`、`/memory clean`、`/compact`、`/skill` |
| `getFallbackReply(key)` | `fallbacks` 段的异常兜底正文 | 运行内核各失败出口 |

引擎只经 `deskpet-stage-hint { sessionId, stage }` 发语义 key，文案由界面按当前 Card 取 —— 与 `tool-executing` 同一条口径，引擎不持有第二份台词。`commands` 里带计数与错误插值的明细行保持中性：插值内容是诊断事实，角色化会让用户分不清「真的排了几条」和「角色在说话」。系统消息与错误诊断同样保持中性（角色台词会掩盖故障）。

新增一个用户可见场景的联动清单：`StageMap` / `FallbackReplies` / `CommandReplies` 加 key → `stages-prompt.md` 补说明与 JSON 模板 → `validateStages` 把它列为必需（旧缓存判过期才会重生成，否则新 key 永远取不到 Card 文案）→ 接消费点。`FALLBACK_STAGES` / `FALLBACK_FALLBACKS` / `FALLBACK_COMMANDS` 只是 Card 完全不可用时的中性兜底，不是第二份产品文案。

`thinking` / `planning` / `retry` 是状态行不是对话回复，`error` 供工具错误前缀；`timeout` 无处安放，超时是**终态**且已有专属于它的 `fallbacks.turnTimeout`，不再保留第二个同名阶段字段。`idle` 已删除（生成侧强制为 null 的死字段）。

## 回复与写入

```text
模型完整回复
  → parseRuntimeData：解析并剥离内部块
  → generateReply：解析 RUNTIME_DATA、变量写入落盘、显示文本处理
  → batchWriteVars：注册/写权限/类型/范围校验
  → savePoolToDisk：保存 Card 状态
```

入口见 [reply/generator.ts](../../src/services/reply/generator.ts) 和 [personality/index.ts](../../src/services/personality/index.ts)。模型不能新增变量、写 system 变量、通过字符串绕过类型与边界限制。

主 run 捕获 Card ID、版本和 hash；返回时若当前 Card 已变，旧文本仍可保存到所属会话，但旧 RUNTIME_DATA 不写入新角色变量。流式增量和工具中间消息不直接写入 Card 变量。

结算只解析**结算正文**自己的 RUNTIME_DATA：结算取 `state.finalPlainAssistant ?? state.finalAssistant`（本回合最后一条无 toolCall 的助手消息；没有它时才退回最后一条助手消息），再用 Harness 的 afterResponse 留底的「原始正文 ↔ 剥离后正文」配对取回原始正文（剥离先于提交，提交的条目里已经没有协议块）。因此本回合其他助手消息（含带 toolCall 的过程消息）里的 RUNTIME_DATA 只被剥离、不写变量。计划步骤的子代理（`runPiSubAgent`）不解析变量：其原始正文随父会话的 `deskpet.plan_step_result` 条目留证（PLAN-09），变量解析入口只有主回合的 `generateReply` 一处。

## 验证入口

相关 Contract：`personality-card`、`variable-pool`；运行命令见[测试 README](../../src/services/__tests__/live/README.md)。格式解析的确定性断言与模型是否主动写入变量是不同验证目标，不能相互代替。

计划回合的写入路径（主回合写入、步骤子代理只留证）由 `agent-runtime` 的 `runtime-plan-step-variable-write` production 场景承接；该场景 2026-09-24 首跑（dataset `2026-09-24.4`）的结论是**原断言不成立**：它读的是 production 入口不透出的 `runtimeData`（观测面缺陷，不是产品丢失变量），离线探针证明结算取值正常，场景已改按可观测的写入事实断言。
