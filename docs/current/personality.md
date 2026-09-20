# 人格、变量与回复

用途：修改 Card、角色状态、阶段文案或回复效果时核对边界。Card 定义与 UI 玩法见 [DES](../DES.md#2-cardprofile-与用户记忆)，文件位置见[运行时数据](runtime-data.md)。

## 所有权

| scope | 值的来源 | 存储表示 | LLM 能否写入 |
|---|---|---|---|
| system | 时间、活动 Card 等运行时派生数据 | 原始值 | 否 |
| card | Card 的 variableDefs 注册表 | VariableState | 仅 updateBy=llm 的已注册字段 |
| interaction | 系统维护的互动状态 | VariableState | 否 |
| session | 当前会话运行状态 | 原始值，只读注入 | 否 |

精确类型见 [types.ts](../../src/services/personality/types.ts) 的 `CardVariableDef`、`VariableState`。VariableState 保存 value/type/updatedAt/updatedBy 和可选 lastResetAt；这些元数据参与状态恢复，不能在保存时退回裸值。

card/interaction 状态保存在 `personality/stages/{cardId}.json` 的变量区；vars.json 只保存 system 数据，session 不进入 Card 持久化。序列化由[变量池](../../src/services/personality/variable-pool.ts)和[阶段缓存](../../src/services/personality/stages-cache.ts)维护。用户长期事实不存入角色变量。

## Card 加载与切换

[loader.ts](../../src/services/personality/loader.ts) 从运行时 cards 目录读取和解析 Card，包内 defaults 只作首次初始化种子。[registry.ts](../../src/services/personality/registry.ts) 的 `switchPersonality()` 先准备阶段文案与变量池，成功后改变活动 Card；失败恢复旧 Card、变量池与阶段缓存。

默认种子提供 neutral 中性选择；没有可用 Card 时允许无活动 Card 降级运行。`whenText` 是自然语言语气指引；mustRules 参与 Prompt 构建，不是一套任意执行脚本。

阶段文案先读持久化缓存，缺失时可经模型生成。`getFallbackReply()` 提供角色化兜底并有中性回退。

## 回复与写入

```text
模型完整回复
  → parseRuntimeData：解析并剥离内部块
  → generateReply：情绪映射、显示文本处理
  → batchWriteVars：注册/写权限/类型/范围校验
  → savePoolToDisk：保存 Card 状态
```

入口见 [reply/generator.ts](../../src/services/reply/generator.ts) 和 [personality/index.ts](../../src/services/personality/index.ts)。模型不能新增变量、写 system/session、通过字符串绕过类型与边界限制。

主 run 捕获 Card ID、版本和 hash；返回时若当前 Card 已变，旧文本仍可保存到所属会话，但旧 RUNTIME_DATA 不写入新角色变量，也不会在 runtime 直接 emit 当前 UI 效果；返回的 effects 仍包含解析结果，调用方的显示/播放隔离需单独验证。流式增量和工具中间消息不直接写入 Card 变量。

## 验证入口

相关 Contract：`personality-card`、`variable-pool`、`emotion`；运行命令见[测试 README](../../src/services/__tests__/live/README.md)。格式解析的确定性断言与模型是否自发生成情绪字段是不同验证目标，不能相互代替。
