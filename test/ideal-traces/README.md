# 理想线路稿（Ideal Traces）

本目录存放**只由用户编写**的理想线路稿：对桌宠"应该怎么表现"的期望描述。
它是 [trace 审阅门禁](../README.md#trace记忆质量与性能门禁) 的对照基准，**不是测试产物**——不参与保留淘汰，也不由任何工具生成。

## 红线（防假成功条款）

- 理想稿**只由用户编写**：仓库工具与 AI 代理不生成、不修改、不覆盖它。
- **不要把实际 trace 复制或改写成理想稿**——那等于拿现状当期望，审阅必绿而毫无意义
  （`trace-evidence.mjs` 给修复代理的原文：*Never edit or regenerate the ideal trace or treat a previous actual trace as a new oracle*）。
- 修复循环的正确姿势：读差异与证据 → 改产品 → 重跑采集 → **重新审阅**。旧审阅不能批准新产物（哈希绑定）。

## 放哪、怎么隔离

- 推荐放本目录，命名约定 `<主题>.ideal.md`；命令接受任意路径，约定只为在 IDE 里一眼区分期望与实际。
- **与自动产物隔离**：本目录不在 `test/reports/` 下——报告与 trace 的保留策略（最近 5 份）不会碰到它。
- **与 git 的关系**：`test/reports/` 与 `test/.tmp/` 在 `.gitignore` 中，本目录**不在**——理想稿默认随仓库版本化（它是"期望规格"，像文档一样值得留痕）。
- **含隐私的理想稿**：移到仓库外任意位置，或自行加 ignore 条目；运行命令时直接传路径即可，目录只是推荐。
- 实际 trace 在 `test/reports/traces/trace-bundle-*.trace.jsonl`（bundle 组，gitignore；bench / quality 运行在各自子目录的 `traces/`，理想稿审阅只针对门禁 L4 trace）；后缀约定让两者一眼可辨：`.ideal.md` 是期望、`.trace.jsonl` 是实际。

## 怎么写

- **任意 UTF-8 文本，不要求任何语法**——不需要 JSON，不需要写真实事件格式；写你期望的"线路"本身。
- 建议覆盖（有多少写多少，不必面面俱到）：
  - **场景前提**：谁、在什么状态下、发起了什么；
  - **期望的关键节点**（按顺序）：用户可感知、或证据中可核对的事。引用事件名有助于 AI 精确定位，
    可用事件见 [`RuntimeTraceKind`](../../src/services/engine/runtime/trace.ts)，但不强制；
  - **期望的结果**：回复应包含什么、状态应如何变化；
  - **不该发生的事**（负向期望同样重要）：不应弹权限确认、不应召回某条、不应静默失败；
  - **可接受的歧义**：哪些细节无关紧要——减少审阅把无关波动报成差异。
- 示例：

  ```text
  # 理想线路：问候时召回称呼偏好

  前提：库中已有"称呼偏好 = 阿澄"。
  用户发送"早上好"。

  期望（按序）：
  1. input_accepted —— 输入先落盘再投递
  2. memory_recall_rendered —— 召回投影中包含称呼偏好
  3. 回复正文使用"阿澄"称呼
  4. agent_end 正常结算

  不该发生：权限询问；工具调用（这题不需要工具）。
  ```

## 工作流

```bash
# 1. 写理想稿（本目录）
# 2. 采集（trace 默认 full；light 省略 payload/snapshot 事件，off 不能通过完整性门禁）
pnpm run test:e2e -- --module <模块> [--repeat 3]
#    → test/reports/traces/trace-bundle-<时间戳>.trace.jsonl / .manifest.json（+ quality 或 memory-bench / integrity；中断抢救时另含 result）
# 3. 让一个独立 AI 读【理想稿 + manifest + 实际 trace】，按下方字段表产出审阅 JSON
# 4. 跑门禁
pnpm run test:trace-review -- test/ideal-traces/xx.ideal.md \
  test/reports/traces/trace-bundle-<时间戳>.trace.jsonl \
  test/reports/traces/trace-bundle-<时间戳>.manifest.json \
  <审阅.json>
```

## 审阅 JSON 字段表（AI 产出）

| 字段 | 要求 |
|---|---|
| `verdict` | `pass` / `fail` / `pending` / `inconclusive` |
| `idealSha256` `actualSha256` `manifestSha256` | 与三份文件当前哈希一致；不一致即"旧审阅"，判 stale |
| `differences` | `pass` 必须为空数组；`fail` 必须至少一条差异（写明期望与实际的偏离） |
| `reviewedTrials` | 覆盖 `manifest.expectedTrials` 的全部场景/试次；每个被审阅 trial 还须至少引用一条它的事件作为锚 |
| `evidence` | 事件引用 `{chunkId, eventSeq, sceneId, trialId}`；合法静默线路可用边界引用 `{chunkId, boundaryKind, sceneId, trialId}` |
| `reviewedOrphans` | 孤儿事件逐条 `{chunkId, eventSeq}`，且同样要有 `evidence` 引用 |
| `summary` | 可选，人读的结论 |

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 完整且 `verdict=pass` |
| 1 | `verdict=fail`（差异已写明） |
| 2 | `pending` / `inconclusive`：缺理想稿、缺审阅、哈希失配、丢事件、缺 trial 边界、未完成 |

## 边界（别误解）

- 哈希只证明"这份审阅绑定这份产物"，**不证明 AI 判断正确**；门禁只核对证据完整性、哈希与审阅覆盖，不冒充语义理解。
- trace 只采结构、数量与已有审计 hash，**正文与工具参数/结果不落 trace**——理想稿的期望不要建立在"trace 里能看到原话"上；要核对正文请回查会话文件。
