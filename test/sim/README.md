# test/sim — 开发期陪伴闭环演练

这不是一个 CI 测试层，也不进契约门禁。它是**真实 app 进程内**的开发期演练工具：
让 Claude Code 通过文件控制通道和桌宠聊天，并在同一个进程里触发静默了解、dreaming、
主动消息与定时任务。不启动 E2E 宿主，不替换模型，不伪造业务入口。

与桌宠聊天时先读 [`desk-pet-chat/SKILL.md`](desk-pet-chat/SKILL.md)。评测数据集另有两个 Skill：
写题与用户审批见 [`desk-pet-eval-authoring/SKILL.md`](desk-pet-eval-authoring/SKILL.md)，
结构化执行、API judge 判分与报告见 [`desk-pet-eval-runner/SKILL.md`](desk-pet-eval-runner/SKILL.md)。
三者共用同一份数据集与 CLI 规则；W1–W2 已落数据集、题型、审阅、银标候选、debug 隔离起停与 direct-seed 装载（W2 已验收 2026-10-25）；W3 测试侧 `evidence.mjs`／`report.mjs`、产品侧 trace 采集与跨会话取证、运行器封存接线已于 2026-10-25 验收，聊天驱动和判分仍未实施。

## 启动

```bash
DESKPET_SIM_CHAT=1 pnpm dev
```

启动后控制通道会在 outbox 写一条 `{"type":"ready",...}`。app 保持运行。

## 路径

- 控制目录：`data/desk-pet/logs/sim/control/`
- 发消息（Claude 写）：`data/desk-pet/logs/sim/control/inbox.jsonl`
- 读回复（app 写）：`data/desk-pet/logs/sim/control/outbox.jsonl`
- 报告：`data/desk-pet/logs/sim/chat-<stamp>.json`
- 可读摘要：`data/desk-pet/logs/sim/chat-<stamp>.md`
- trace：`data/desk-pet/logs/sim/chat-<stamp>.trace.jsonl`

`inbox.jsonl` 一行一个 JSON，例如：

```json
{"id":"chat-1","type":"message","text":"刚回来，搞杯咖啡又坐下了。"}
```

## 命令

| type | 载荷 | 说明 |
|---|---|---|
| `message` | `text`, 可选 `tools:"auto"\|"none"`, `imagePaths` | 走真实 `sendMessage`；默认允许工具 |
| `host` | `method`, `args` | 直接走原生 UI 的请求分派面（聊天/设置/记忆/卡片/Profile/MCP/Skill/音效等） |
| `observe` | — | 立即跑一批静默了解 |
| `dream` | — | 手动 dreaming |
| `proactive` | — | 主动扫描 + 规划 + 表达 |
| `plan` | `mode:"auto"\|"stepByStep"\|"off"` | 替没有面板的 Claude 确认计划/步骤门 |
| `task` | 可选 `kind:"reminder"\|"agent_job"`, `text`, `work` | 提醒或执行型任务（子代理） |
| `report` | — | 写报告并返回路径 |
| `stop` | — | 收尾并停掉通道 |

`host` 的 method 与参数和原生 UI 发给 Node 的请求同形，完整列表见
[`src/services/native-ui/host-requests.ts`](../../src/services/native-ui/host-requests.ts) 的 `dispatchHostRequest`，
包括 `chat_*`、`settings_*`、`memory_*`、`card_*`、`profile_*`、`tools_*`、`mcp_*`、`skill_*`、`sound_*`
等正常使用面。涉及删除、恢复、清空的命令请显式确认参数，不要拿生产数据试。

## 辅助脚本

```bash
node scripts/desk-pet-chat.mjs chat "刚回来，搞杯咖啡又坐下了。"
node scripts/desk-pet-chat.mjs cmd observe
node scripts/desk-pet-chat.mjs observe --screenshot
node scripts/desk-pet-chat.mjs host settings_read
node scripts/desk-pet-chat.mjs host chat_stop
node scripts/desk-pet-chat.mjs humanize status
node scripts/desk-pet-chat.mjs humanize on
node scripts/desk-pet-chat.mjs choice list
node scripts/desk-pet-chat.mjs choice pick 0
node scripts/desk-pet-chat.mjs confirm deny
node scripts/desk-pet-chat.mjs context
node scripts/desk-pet-chat.mjs window
node scripts/desk-pet-chat.mjs sessions
node scripts/desk-pet-chat.mjs tasks
node scripts/desk-pet-chat.mjs proactive-state
node scripts/desk-pet-chat.mjs understanding
node scripts/desk-pet-chat.mjs suite memory --rounds 4
node scripts/desk-pet-chat.mjs suite observation,tasks --run --rounds 3
node scripts/desk-pet-chat.mjs tail 10
node scripts/desk-pet-chat.mjs dataset validate
node scripts/desk-pet-chat.mjs dataset list
node scripts/desk-pet-chat.mjs dataset types
node scripts/desk-pet-chat.mjs dataset review saturday-companionship
node scripts/desk-pet-chat.mjs dataset driver saturday-companionship
node scripts/desk-pet-chat.mjs eval prepare --case saturday-companionship --card <card.md> [--run-id <id>]
node scripts/desk-pet-chat.mjs eval start --run-id <id>
node scripts/desk-pet-chat.mjs eval status --run-id <id>
node scripts/desk-pet-chat.mjs eval stop --run-id <id>
```

`dataset` 命令只读 `test/ideal-traces/suites/`，不启动 app、不调用模型。当前只有
`daily-companionship/saturday-companionship` 一条 silver/pending 候选（27 条用户消息 + 2 个 host 步骤、
3 个会话、21 条探针，其中 9 条 critical；覆盖 8 个题型），其他套件为空占位。
数据集为 schema v3：fixture 声明 `loading`（`direct-seed` 直接写隔离数据根 / `real-chain` 走真实导入），
`fixed` 时钟要求每个 driver 步骤带升序 `at`，每条探针带 `questionType` 与 1–5 的 `difficulty`，
case 的 `questionTypes` 必须等于探针题型并集；探针观察窗口限定在 driver 步骤，避免 fixture 预置的助手消息污染。
题型注册表是 [`desk-pet-chat/question-types.json`](desk-pet-chat/question-types.json)，共 7 个家族、24 个题型，
每个产品分类至少被一个题型覆盖。`review` 给人看完整候选、题型与评审权威、装载方式、难度分布与审批差异；`driver` 只输出
`schemaVersion`／`caseId`／`revision`／`specHash`／`userRole`／`driver`，不含题型、probes、oracle、检查点、证据或评分。
代理只能起草 silver；gold 必须由用户针对当前 `specHash` 的真实会话消息审批，代理不得代填审批或把框架通过当成用例审批。
authoring Skill 会先列候选、询问要审哪条，再把审阅卡贴到聊天区；W1–W2 没有评分与审批写入，数据集校验通过不产生质量结论。
W2 的 `eval` 命令只做隔离启动、所有权核验与 direct-seed 装载：运行根固定在 `test/.tmp/sim-eval-<id>`，
要求显式 `--card`，不读真实 CONFIG；`stop` 只写 `stop.request`。真实启动、ready 核验、非法路径失败、跨进程单实例与停止后退出已于 2026-10-25 验收；`.instance.lock` 按设计保留但锁已释放。固定时钟未注入，跨天间隔仍属未验证；相关 56 条测试已在验收轮运行通过。
结构化探针的正式判分走 API judge；`humanizer.*` 与拟人化质量只由用户本人判定，coding agent 只能给建议，
不能产生 pass/fail 或 gold。自动化遇到 human 权威探针必须停在 `pending`。

测试分类的唯一真相源是 [`desk-pet-chat/categories.json`](desk-pet-chat/categories.json)；
题型与家族的真相源是 [`desk-pet-chat/question-types.json`](desk-pet-chat/question-types.json)。
不带 `--run` 打印步骤与证据，带 `--run` 只跑可自动化的组件类别，聊天/plan/tools 由 Claude 驱动。
轮数与分类都由调用方显式指定，不设默认上限。拟人化默认开启来测：先用 `humanize status`
确认，不是 `true` 就 `humanize on`，收尾按原值恢复；评分与 trace 判据见 skill 的「拟人化检测」。
上下文与压缩用 `context` 查看占用，手动压缩走 `chat_slash_command` 的 `/compact`；
弹窗用 `choice` / `confirm` 应答，判据见 skill 的「上下文与压缩」。
静默了解每批随机广度/深度；设置页「立即了解一次」可手动触发，不受开关限制、不计当天次数，
上一批未结束时不会重复触发。
新一轮测试先 `host chat_new_session`，多会话用 `sessions` 查看；测试写出的 SQLite/会话数据
默认保留，收尾列给用户并询问是否清理。

## 边界

- 只在 development 模式启动；不要指向生产数据根。
- 控制文件与报告都在 dev 数据根，不提交到 git。
- 这里没有 CI 门禁；它的价值是真实链路证据与人工质量观察，不是 pass/fail 测试。
