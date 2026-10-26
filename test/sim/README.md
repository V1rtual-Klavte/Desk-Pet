# test/sim — 开发期陪伴闭环演练

这不是一个 CI 测试层，也不进契约门禁。它是**真实 app 进程内**的开发期演练工具：
让 Claude Code 通过文件控制通道和桌宠聊天，并在同一个进程里触发静默了解、dreaming、
主动消息与定时任务。不启动 E2E 宿主，不替换模型，不伪造业务入口。

与桌宠聊天时先读 [`desk-pet-chat/SKILL.md`](desk-pet-chat/SKILL.md)。评测数据集另有两个 Skill：
写题与用户审批见 [`desk-pet-eval-authoring/SKILL.md`](desk-pet-eval-authoring/SKILL.md)，
结构化执行、判分包冻结、裁决回填与报告见 [`desk-pet-eval-runner/SKILL.md`](desk-pet-eval-runner/SKILL.md)。
三者共用同一份数据集与 CLI 规则；W1–W3 已落数据集、题型、审阅、银标候选、debug 隔离起停、direct-seed 装载、证据封存与采集（W2／W3 已验收 2026-10-25）；W4 的独立 coding-agent judge 判分、可选抽查与同源报告已实现并通过快层反例验收（2026-10-25），真实 judge 未运行；W5 的授权、Node 域固定时钟、驱动／续跑、同条件对照与修复已于 2026-10-26 集中验收；真实模型／judge／Skill 与用户关口未执行。

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
node scripts/desk-pet-chat.mjs eval prepare --case saturday-companionship --card <card.md> --authorization <auth.json> [--run-id <id>] [--baseline <evalRunId>]
node scripts/desk-pet-chat.mjs eval prepare --repair-of <runId> [--run-id <id>]
node scripts/desk-pet-chat.mjs eval start --run-id <id>
node scripts/desk-pet-chat.mjs eval drive --run-id <id>
node scripts/desk-pet-chat.mjs eval status --run-id <id>
node scripts/desk-pet-chat.mjs eval finish --run-id <id> [--interrupted --reason <text>]
node scripts/desk-pet-chat.mjs eval compare --run-id <id> [--baseline <evalRunId>] [--json]
node scripts/desk-pet-chat.mjs eval holdout --case saturday-companionship [--json]
node scripts/desk-pet-chat.mjs eval judge prepare --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval judge apply --run-id <id> --verdicts <file.json> [--json]
node scripts/desk-pet-chat.mjs eval review show --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval review spotcheck --run-id <id> --checks <file.json> [--reviewer-name <name>] [--notes <text>] [--json]
node scripts/desk-pet-chat.mjs eval report --run-id <id> [--json]
node scripts/desk-pet-chat.mjs eval stop --run-id <id>
```

`dataset` 命令只读 `test/ideal-traces/suites/`，不启动 app、不调用模型。当前只有
`daily-companionship/saturday-companionship` 一条 silver/pending 候选（27 条用户消息 + 2 个 host 步骤、
3 个会话、23 条探针，其中 11 条 critical；覆盖 8 个题型；难度 L1 4／L2 5／L3 6／L4 6／L5 2），
其他套件为空占位。
数据集为 schema v4：fixture 声明 `loading`（`direct-seed` 直接写隔离数据根 / `real-chain` 走真实导入），
`fixed` 时钟要求每个 driver 步骤带升序 `at`，每条探针带 `questionType` 与 1–5 的 `difficulty`，
每条探针声明 `rubric`，内容词表、频率、时间关系、主语别名与跨会话来源只在 `expectation` 声明一次，rubric 注册表只保留通用判据；
case 的 `questionTypes` 必须等于探针题型并集；探针观察窗口限定在 driver 步骤，避免 fixture 预置的助手消息污染。
题型注册表是 [`desk-pet-chat/question-types.json`](desk-pet-chat/question-types.json)，共 7 个家族、24 个题型，
每个产品分类至少被一个题型覆盖。`review` 给人看完整候选、题型与判分方式、装载方式、难度分布与审批差异；`driver` 只输出
`schemaVersion`／`caseId`／`revision`／`specHash`／`userRole`／`driver`，不含题型、probes、oracle、检查点、证据或评分。
代理只能起草 silver；gold 必须由用户针对当前 `specHash` 的真实会话消息审批，代理不得代填审批或把框架通过当成用例审批。
authoring Skill 会先列候选、询问要审哪条，再把审阅卡贴到聊天区；W1–W5 没有 gold 审批写入，数据集校验通过不产生质量结论。
W2–W3 的 `eval` 命令做隔离启动、所有权核验、direct-seed 装载、采集与封存：运行根固定在 `test/.tmp/sim-eval-<id>`，
要求显式 `--card`，不读真实 CONFIG；`finish` 收口采集并封存，`stop` 只写 `stop.request`。真实启动、ready 核验、非法路径失败、跨进程单实例与停止后退出已于 2026-10-25 验收；`.instance.lock` 按设计保留但锁已释放。该轮 56 条测试已运行通过；固定时钟当时未注入。
W4 的 `judge prepare` 只对已封存完整证据冻结判分包（含 rubric、驱动、证据引用与判分说明），交给独立 coding-agent judge 逐条裁决；`judge apply` 只校验回填裁决并追加 `grades/`，缺项、重复、未知规则、证据引用无效、判分者与被测模型同源或 packet 哈希不符都会硬失败。runner 不调用模型 API、不读取 judge 凭据。`review show` 展示判分、证据引用与未抽查标记；`review spotcheck` 只记录用户本人的可选抽查，不阻塞也不改写判分。`report` 从同一证据重建四层报告。W4 快层 `聊天评分关口.test.ts` 已运行通过（2026-10-25），仍未发起真实模型／judge 调用。
全部探针（含 `humanizer.*` 与拟人化质量规则）统一由独立 coding-agent judge 判定；用户抽查只用于核对，
不会产生或改写 pass/fail，也不能替代 case 的 gold 审批。
W5 的 `prepare` 冻结 `--authorization`（用例、用途、模型／数据范围、trial 与修复预算、holdout 一致性）和 `clock.json`；
`start` 核验时钟一致，`drive` 按驱动包逐步推进并持久化进度，中断后从同一进度续跑、不重放未知副作用，调用前复核授权指纹与请求模型。
`compare` 只在固定条件一致时对照 baseline 与候选，漂移条件逐项列出；`holdout` 只报告留出使用，两者都不产生质量结论。
修复用 `--repair-of` 新建 attempt，沿用原 Case 哈希、Card、Profile 与时钟并保留旧失败。W5 已于 2026-10-26 集中验收；
真实 app／模型 Skill 运行仍需当次授权，固定时钟只推进 Node 域，Rust／OS 时间仍是真实时间。

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
