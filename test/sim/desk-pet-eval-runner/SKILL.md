---
name: desk-pet-eval-runner
description: Use when 用户要运行 V1rtual-Desk-Pet 结构化聊天评测、执行或续跑已冻结用例、修复失败评测、冻结判分包、应用独立 coding-agent judge 的裁决，或生成同源报告。写题与审批用 desk-pet-eval-authoring；自然聊天与自由定性评测用 desk-pet-chat。
---

# 结构化聊天评测运行与判分

## 边界

本 Skill 只执行已冻结的 case，不写题、不改 oracle、不替 judge 判分。当前实现状态与未完成项只在[未完成总表 §12](../../../docs/plans/active/未完成工作与已知缺口.md)维护，历史验收记录见[归档契约](../../../docs/history/implementation/聊天评测闭环执行契约-2026-10-26归档.md)与[测试 README](../../README.md)；本文件只写稳定操作契约，不记录某次运行结果。

运行器不调用模型 API、不读取 judge 凭据、不替 judge 作判断。`judge prepare` 只冻结判分包；`judge view` 只从已冻结判分包派生按取证窗口精简的读取件（判定字段与哈希绑定原样继承）；`judge apply` 只校验外部回填裁决并追加记录。

结构化驱动会真实启动 app 并调用模型，但消息文本来自冻结 driver。它不是 `desk-pet-chat` 的自主聊天，不能声称聊天 Skill 已被运行；自然聊天记录也不能替代结构化证据或探针判分。

## 命令

```bash
node scripts/desk-pet-chat.mjs eval prepare --case <caseId> --card <card.md> --authorization <auth.json> [--baseline <evaluationRunId>] [--humanizer]
node scripts/desk-pet-chat.mjs eval prepare --repair-of <runId> [--run-id <id>]
node scripts/desk-pet-chat.mjs eval start --run-id <id>
node scripts/desk-pet-chat.mjs eval drive --run-id <id>
node scripts/desk-pet-chat.mjs eval status --run-id <id>
node scripts/desk-pet-chat.mjs eval finish --run-id <id> [--interrupted --reason <text>]
node scripts/desk-pet-chat.mjs eval batch --case <caseId> --card <card.md> --authorization <auth.json> [--trials <n>] [--evaluation-run-id <id>] [--baseline <evaluationRunId>] [--humanizer]
node scripts/desk-pet-chat.mjs eval compare --run-id <id> [--baseline <evaluationRunId>] [--json]
node scripts/desk-pet-chat.mjs eval holdout --case <caseId> [--json]
node scripts/desk-pet-chat.mjs eval judge prepare --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval judge view --run-id <id> [--packet-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval judge apply --run-id <id> --verdicts <file.json> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval review show --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval review spotcheck --run-id <id> --checks <file.json> [--attempt-id <id>] [--grade-id <id>] [--reviewer-name <name>] [--notes <text>] [--json]
node scripts/desk-pet-chat.mjs eval report --run-id <id> [--json]
node scripts/desk-pet-chat.mjs eval stop --run-id <id>
node scripts/desk-pet-chat.mjs eval rescue --run-id <id> [--reason <text>]
node scripts/desk-pet-chat.mjs capture status
node scripts/desk-pet-chat.mjs capture sessions
```

- 封存证据与 attempt 在 `test/reports/chat/<runId>/attempts/<0001>`；隔离宿主数据根在 `test/.tmp/sim-eval-<runId>/`。默认使用运行状态里的 `chat.attemptId`。有多个 attempt 时先 `eval status --json` 或列 attempts 目录核对，再显式传 `--attempt-id`；只有已封存（含 `manifest.json`）的 attempt 可判。
- `judge apply` 不带 `--attempt-id` 时落到默认 attempt；修复后的判分要显式指定目标 attempt。
- `review spotcheck` 默认绑定最新判分；`--grade-id` 指旧判分会被拒绝。`--checks` 结构见 `test/sim/desk-pet-chat/judging.mjs` 的 `normalizeSpotChecks`，`reviewer.role` 必须是 `user`。

## 操作语义

- `prepare` 只在 `test/.tmp/sim-eval-<id>/` 建隔离根，写入合成 CONFIG、显式给出的 Card、`seed.json`、`clock.json`、授权文件与 `driver-package.json`；`--card` 与 `--authorization` 必须由调用方提供，不读取真实 CONFIG、凭据或用户 Card。合成 CONFIG 默认关闭拟人化（`ai.humanizer.enabled=false`，分泡会改写句数与长度观感）；需要测拟人化链路本身时加 `--humanizer`，`batch` 同样接受，`prepare --repair-of` 沿用原运行开关、不能为修复单方面打开。授权文件声明用例范围、用途、`isolated` 数据范围、模型、预算（`trials > 0`、`repairs >= 0`）与是否留出，留出布尔必须等于用途。
- `start` 只接受 debug 构建，设置 `DESKPET_SIM_EVAL=1` / `DESKPET_SIM_EVAL_RUN_DIR` 拉起宿主，依次核对 `ready.json`、控制通道 ready 与 `seed-report`：pid 必须是本次子进程、`runDir`／`dataRoot`／`controlDir` 必须同源、运行模式必须是 development，控制通道时钟必须与运行根 `clock.json` 一致，fixture／会话／消息数／记忆数必须与 `runner.json` 一致；核对通过后建 attempt 并开始 trace 采集。
- `drive` 只按驱动包推进：每步先复核授权指纹与请求模型，再推进固定时钟、发送消息或执行 host 步骤、等待检查点；进度写入 `driver-progress.json`，中断后用同一命令续跑，已完成、已阻塞或有 in-flight 的进度拒绝续跑；消息／分钟／已知 token 预算在下一步副作用前到界阻塞，未知用量记 unknown 不记零。每个消息步骤生成唯一 `operationId`，回执必须原样回带 `caseId`／`trialId`／`sessionId`／`generation`／`stepId` 与 `requestId`；缺身份、错组或会话／代际不一致直接失败，排队回复按同一 `requestId` 的 run 分支取回，不回落到最后一条助手消息。采集期间手动写入的 `chat` 消息没有 drive 身份，会被拒绝。消息里的 `{{dataRoot}}` 只在发送时渲染为隔离数据根，驱动包装载到宿主时保留原样。case 声明 `toolApproval: "allow-once"` 时，驱动在消息在飞期间轮询单槽确认并只允许一次；未声明时驱动同样轮询并一律拒绝，桌宠得不到工具只能在对话里作答。确认记录（`requestId`／工具名／效果类／决定／时间）随进度持久化，同一回合被拒超过三次以 `driver.confirm-loop` 中止，不让确认把回合挂到消息超时。被测模型在回合里反问用户时，驱动同样在消息在飞期间轮询提问通道并一律取消（`requestId`／选项数／`cancel`／时间进进度），取消后模型只能按已有信息作答，同一回合连续取消超过三次以 `driver.question-loop` 中止；查询与取消之间提问被产品侧收回会让下一次重试再取消，同一请求连续两次取消失败才算故障。驱动确认与取消都只是评测驱动代答，不能冒充用户自然确认或自然回答。驱动失败写 blocked，不自动重放已完成副作用。手工触发步骤只接受 `sim_proactive_tick`／`sim_task_deliver`：前者调用主动 tick 并只记录本次产生的 `proactive_*` 事件，后者走任务组件的创建与交付；回执必须带 `manualPath=sim-component`，任务还必须 `created`／`delivered` 为 true，否则本步阻塞。这是组件入口证据，不代表自然受理、调度或实际 UI 显示；采集器只把显式绑定的活跃会话用于归属，未绑定会话的迟到事件仍是 orphan。
- `assistant_message` 必须取得同一请求持久 run 分支里的终态助手正文，并携带 `assistantEntryId` 与 `replyBinding=request-response`；直接与排队回执遵守同一规则。非空返回字符串或 usage 的 `responded` 不证明正文落盘；失败回执即使有兜底文案仍阻塞，失败记录保留回执与诊断。
- `memory_extraction_end` 检查点在消息副作用之前抓取作业基线，只把基线之外的新抽取作业算作本步触发；新作业必须到达终态（`completed`／`failed`／`cancelled`）且 `pendingSources=0`、`activeJobs=0` 稳定后才满足。空水位 `0/0`（没有任何新作业）不算抽取结束，超时以“没有发现新抽取作业”或未收口作业明细收口。检查点只证明抽取作业发生并结束，不证明抽取内容正确——内容仍由状态探针与 judge 判定。
- `finish` 只按驱动结果收口：驱动未完成时必须显式 `--interrupted --reason <text>`，不能补写完成边界；随后结束试次、收口采集、写 dialogue、补声明会话、按 case 声明捕获交付产物（只读复制到 `artifacts/`，逐项记 delivered／missing／oversized／invalid，符号链接与越界路径拒绝采集）、封存 attempt 并生成同源报告。产物缺失或超限只作为交付规则证据，不改变证据完整性。
- `compare` 只比较两次运行的固定条件（case／fixture／driver／模型／宿主／版本），代码／Card／配置等目标变化只记录，缺失固定字段记为不可比；`holdout` 只报告某个 case 被哪些保留运行引用（含在途与待审），不产生质量结论。
- `batch` 在同一 evaluationRun 下串行编排 N 个独立试次：首次运行把 `trialIds`、计划总数与授权指纹冻结进 `trials.json`，`--trials` 是计划总数（含已有 attempt），默认取授权 `budget.trials`；之后不能用 `--trials` 或新计划改写。每个槽位用确定性派生的子运行 id 执行 `prepare → start → drive`，`drive` 失败按中断封存后继续下一个；未封存、失败或证据不完整的槽位保持占位，不自动替换、不自动判分。计划外 trialId、重放同一 trialId、已有 attempt 却事后补建计划都会硬失败。批量结束只写 `batch.json` 与报告，判分仍需按 attempt 逐个 `judge prepare`。
- `prepare --repair-of` 只接受已封存 attempt，复核数据集哈希、Card、Profile 与时钟与原运行一致，并按授权修复次数在同一 evaluationRun 下创建新 attempt；旧失败、旧证据与旧判分保留，不能覆盖。
- `stop` 只写 `stop.request`，由宿主走产品退出序列并移除 ready，未完成采集以中断状态收口。宿主在 flush 之后把真实关停结果写进运行根 `exit.json`（pid、Node flush、强杀／中断），`stop` 核对它与本次宿主绑定、flush 完成且非强杀非中断，缺失或不干净都会报问题并以非零退出码结束；`finish` 收口时会把这些关停问题写进摘要与退出码。停止条件是进程退出且 ready 消失。`.instance.lock` 文件按设计保留（OS 在进程退出时释放锁，删除文件会引入 unlink 竞争），无残留判据是无宿主进程、无 ready、锁未被持有且真实数据根未变。不要 kill 进程来“收尾”。
- `rescue` 只用于宿主没有走完退出序列（崩溃、被强杀）的现场：宿主仍活着（先 `stop`）或 attempt 已封存都拒绝；只把已落盘的 `manifest.json.pending` 按 `interrupted` 封存，缺对话、缺 trace 封口、缺 `exit.json` 写进 issues，封存结果保持 incomplete/inconclusive，不冒充完成；封存后可 `prepare --repair-of`。救援后不再重放原驱动。
- `status` 只读现有证据，不修复、不重启、不清理失败现场；`capture status|sessions` 通过开发控制通道核对本次采集的范围与来源，不读取真实用户会话。
- `judge prepare` 只在证据完整、执行完成、数据集绑定未漂移且驱动无 oracle 泄漏时冻结判分包（规则、对话、状态、产物哈希与允许的证据引用）；不调用模型，也不写判分。判分包为 schema 4（`chat-judge@6`，`chat-grader@4`）：按 case 声明携带交付产物的封存状态与受限内容（单文件 4 KiB、整包 16 KiB），超限截断并标注；二进制、哈希不符或预算耗尽只保留原因；`deliverable:<id>` 是可引用的证据，缺失产物仍可冻结并由裁决判失败。
- `judge view` 只读已冻结判分包并写出 `<packetId>.view.json`：内联规则取证窗口内的助手回复与全部驱动回合，窗口外回合留元数据并标 `textOmitted`，没有规则取状态或产物时不带 `state`／`deliverables`／`artifacts`（原因在 `projection.omittedSections`）；`case`、`fixtureContext`、规则、引用白名单原样继承，顶层带原 `packetSha256`，判定权威与绑定不变。缺省取该运行最新的判分包，已存在的视图拒绝覆盖，可 `--packet-id` 指定。
- `judge apply` 只接收外部 coding-agent judge 回填的 `verdicts` JSON，校验覆盖、绑定、证据引用、异构性与 prompt 版本后追加 `grades/`；不合规硬失败，不修正、不补写裁决。
- `review show` 展示判分、规则对照与“未抽查”标记；`review spotcheck` 只接受用户本人填写的抽查记录，追加 `reviews/`，不阻塞也不改写判分。
- `report` 从同一证据集合重建“结论卡→检查对照→时间线→原始证据”四层报告；报告不反向定义 oracle，也不成为业务真相。产物窗口的规则按封存产物取证，原始证据列出每个交付产物的封存状态与原因。驱动包含手工触发时，结论卡注明 `sim_proactive_tick`／`sim_task_deliver` 是评测驱动直接调用的组件入口，不代表自然受理、调度或实际 UI 显示。

## 生成正文与交付证据

- 对话证据以同一已提交消息的身份绑定最终 `text`／`textParts` 与 `replyEvidence`。available 声明剥内部协议后的生成正文及处理状态，缺少持久取证则为 unavailable；不以最终正文、旧原文字段或未封存会话补造原文。空助手工具轮与沉默保留空正文和明确状态，工具调用数仅按同条持久消息派生且缺失保持未知，不复制参数、不伪造作答。
- 产品判分始终看最终交付，生成正文仅帮助解释生成和展示差异；原文正确、最终错误仍判产品失败。换行、气泡、编号与句数分别核对，不能把行数当句数；记得过去说过什么不等于必须继续认同。
- 最终正文足够判断时，缺原文仅限制归因；只有判断实际需要的证据不足才判 inconclusive。精简视图必须保留取证窗口内的生成／交付证据和允许引用，不能读源码或活动会话来补齐。旧封存与旧判分不改写，正式重判须冻结新 packet 并追加 grade。

## 判分执行者与独立性

- **谁判**：由用户在本轮明确指定的独立 coding-agent 会话（Claude Code／Codex／Qoder 等）读取冻结判分包并逐条裁决。judge 模型必须与被测模型异构；平台与模型由用户选定，不沿用历史运行的默认值，也不复用已作废判分里的 judge。
- **谁不能判**：驱动本 attempt 的会话、冻结或执行 runner 的同一会话、任何临时 API 客户端、SDK／curl 脚本或直接 provider 调用都不能充当 judge。不得使用被测 endpoint／凭据，不得读取 `test/eval-models.local.json` 或其他 judge 凭据。
- **用户未指定就停**：没有明确指定 judge 平台与模型时，不要自行挑模型、不要复用上一轮 judge、不要因为“模型名不同”就开判；先向用户确认。
- **裁判只看判分包**：judge 只读 `judge-packets/<packetId>.packet.json`，或 `judge view` 为它写出的精简读取件 `<packetId>.view.json` —— 两者判定要求相同，视图顶层 `packetSha256` 就是原判分包，回填裁决用它；视图里 `textOmitted` 的回合需要原文时回到原判分包读，不猜测。不读仓库源码、测试、`dataset review`、历史判分、报告或 gold；不得修改证据、判分包或视图。
- **身份如实填写**：`judge.identity.platform` 必须是实际 coding-agent 宿主，`model` 是实际模型，`promptVersion` 等于判分包版本；不得伪造。
- **机械校验的边界**：runner 校验 packet 绑定、规则覆盖、证据引用、prompt 版本、模型名异构，并要求 `judge.platform` 属于 coding-agent 白名单（`claude-code`／`codex`／`qoder`）；API 客户端回填会被 `judge apply` 拒绝，平台不在白名单的历史判分不算权威。它仍无法证明 judge 是独立会话，也无法验证平台自述；这些由用户选择与本流程保证。独立性无法确认时，不应用裁决，不产生有效判分。
- **重判**：`judge apply` 追加新判分，报告与 `status` 采用最新判分；旧判分保留在封存证据中，不覆盖、不删除，也不能手工改分。

## 判分边界

- **全部规则统一由独立 coding-agent judge 判定**：没有权威分流，也不存在 runner 自带的确定性内容判定。题型（`questionType`）、`critical` 与 `difficulty` 只用于报告分组、覆盖统计与分层，不决定由谁判分。
- **runner 只核运行有效性**：证据完整、执行完成、探针窗口可用、oracle 未泄漏进驱动、数据集绑定未漂移。这些前置条件只决定“能否判分”，不产生任何探针分数。
- **声明式期望，通用 rubric**：事实、频率、时间关系、主语别名、跨会话来源与禁止项只在探针 `expectation` 声明一次；rubric 注册表不复制单个 case 的内容词表。未知 rubric、缺失或多余的 expectation 直接失败，不静默通过。
- **判分包是判分唯一输入**（其 `judge view` 读取件等价）：包含规则、对话、状态、产物哈希、按声明携带的交付产物状态与受限内容，以及允许的证据引用，不包含仓库源码、测试期望、历史判分或 gold。judge 不得修改证据或判分包；内容缺失、被截断或为二进制时，不得按未出现内容猜测。
- **裁决格式**：每个 `ruleId` 恰好一条 `pass` / `fail` / `inconclusive`，理由非空；`pass` / `fail` 至少引用一条 `allowedEvidenceRefs`，`inconclusive` 可说明缺失或冲突证据。漏项、重复、未知规则、引用越界、packetId／packetSha256／caseId／promptVersion 不匹配都硬失败。
- **聚合规则**：单个 attempt 内所有适用规则均为 `pass` 才通过；任一 `fail` 判失败，任一非 `pass`（含窗口不可用）判 inconclusive；证据不完整或执行未完成时一律 inconclusive。用户抽查不参与聚合。多个 attempt 时报告按冻结计划给出 critical `pass^k`：全部计划试次都通过才算通过，任一 `fail` 即失败；缺试次、证据不完整、执行未完成、未判分、judge 身份不一致或 pass/fail 无证据引用都保持 inconclusive；非 critical 规则只展示分布。
- **跳过规则由 runner 记录**：窗口不可用的规则不交给 judge，运行器直接记为 inconclusive 并说明原因。
- **抽查可选**：用户想看结果时才抽查；抽查记录只用于核对与保留分歧，不阻塞运行、不改写判分、不会把 inconclusive 变回 pass。
- **快层通过不等于正式评测**：测试通过只证明流程能力；真实运行必须当次授权，单次运行或快层测试都不能当成质量、gold 或基线结论。当前状态以执行契约与测试 README 为准。
- **证据冻结**：grades／reviews 每次新增版本，绑定原始证据与规则；不得覆盖旧判分、旧证据或用户抽查。

## 驱动与隔离

- **环境运行入口**：MemoryArena 使用 `dataset external run memoryarena --config <配置> --task <组id> --card <card.md> --authorization <auth.json>`，可加 `--model-settings <settings.json>` 指定隔离模型覆盖；接手前先执行 `dataset external status all` 与 `dataset external verify all`，后者非零时按诊断处理，不视为已安装完整。环境身份必须从首个 `chat_new_session` 开始绑定同一 config/group；普通 `eval prepare`／`batch` 也要求显式提供已启用的 stdio `--mcp-server`，否则在创建运行根前拒绝。初始身份由 `prepare` 写入，`start` 将该文件路径传给 MCP；不要手工补空环境文件。隔离 runner 的 run-id 只允许小写字母、数字、连字符，最长 48 字符；LHTB 入口更严，限 3–39 字符，为 Harbor 追加的 `-phase-<n>` 后缀留出同一上限。
- **外部公开集**：用 `dataset external catalog` 看固定来源，用 `install <dataset|all>` 安装完整固定输入，`status` 查看状态，`verify` 离线重核来源和文件，`connect <dataset|all> --card-name <名称>` 编译可接通的现有套件。完整原始文件与编译套件长期保存在忽略的 `test/sim/desk-pet-chat/external/.data/<dataset>/{raw,dataset}/`；`fetch` 仍用于单个公开文件，`prepare / import` 仍用于自备输入。有效缓存校验后离线复用，校验失败拒绝覆盖；临时输出限于 `test/.tmp/external-eval/`。GAIA 是 gated 数据，安装要求已有本地授权登录；公开 test 的 `?` 占位答案不可作为评分 oracle。`--revision` 绑定上游 commit 和输入 SHA-256；BEAM 10M 有独立 source revision。LHTB 使用官方 Git commit、verifier 与 Harbor 输入。`dataset validate|list|review|driver` 与 `eval prepare|batch` 显式使用 `--dataset-root`；runner 状态固定所选 root，repair、start、report、judge 沿用此绑定。适配运行仍复用产品 driver、隔离宿主、证据封存与独立 coding-agent judge，不等于官方 benchmark runner／榜单分数。
- **适配范围限制**：GAIA validation 的附件经 SHA-256 校验后复制进每次隔离 run；test split 不编译成可评分任务。MultiChallenge 将最后一条 user 消息作为 live 请求，之前的 user／assistant 历史固定预置；`target_question` 与 `pass_criteria`（通常 YES）只进入 oracle／judge。BEAM 按数值 plan/batch 顺序保留角色历史并只执行目标 probe，不复现在线摄入与记忆更新。MemoryArena group travel 走顺序多会话环境路径，同一隔离 data root 保留任务依赖和 dreaming 边界；runner 在 `sim-eval` 根写 `external-environment.json`，每次 MCP `tools/call` 前按固定 config/group/subtask index 重置环境，不要求模型自行初始化。五个 config 均已接入统一运行入口：`bundled_shopping` 走 run-owned loopback 预热包装器，其余经环境 MCP 直接执行，`run` 按 `verify` 的 per-config 环境就绪度拒绝未满足项；group travel 之外的 config 尚未在真机完成正式运行与验收。LHTB 单任务通过隔离 MCP 和官方 verifier 执行；源码校验忽略 Harbor 运行期派生的字节码缓存，入口 run-id 限 3–39 字符为相位后缀留位；原镜像 smoke 修复后未重跑，最终门禁仍待验收。`--mcp-server`、任务超时与 `--model-settings <settings.json>` 只写本次隔离副本；后者暂存为隔离 `eval-models.local.json`，不改真实配置，可用于本地 scripted-provider 诊断。环境步骤由 Node driver 消费，不添加 Rust IPC。所有外部工具评分必须标记为适配口径；不得绕过 readiness 或把环境任务改造成静态聊天题。
- 外部 case 的 `source.kind` 为 `external`，始终保持 silver，须有用户针对真实会话消息的审批才可成为 gold；参考答案／criteria 只在 oracle 和 judge packet，不进入 driver。上游许可与 gated 访问要求由调用者负责，导入不授予再分发权。
- `direct-seed` 与 `real-chain` 不能混用：前者只预置初始状态，后者必须通过真实导入建立；不要把纠正结果 seed 进去再宣称纠正成功。
- `fixed` 时钟由 runner 写入 `clock.json` 并在宿主 Node 引导早期安装，只改变 Node 域 `Date`；Rust 调度器、OS 文件时间与跨进程时间戳仍是真实时间。可以声明 Node 域时间按用例推进，不能声明真实日程间隔或真实自动抽取时序已经验证。自动抽取依赖 Node 调度器的真实节拍与真实模型时延，`memory_extraction_end` 只认基线之后的新作业收口，空闲水位不代表抽取发生。
- 聊天驱动入口是 `eval drive`（不是 `dataset run`）：它按驱动包逐步推进并持久化进度；中断后从同一进度续跑，不重放已开始但结果未知的步骤。真实 app／模型的 Skill 运行仍需当次授权；没有运行就不能声称某个 attempt 是自动执行产生的。
- 预算与授权在 `prepare` 冻结：请求模型必须在授权范围内，修复次数不能超过授权值，留出用途与留出布尔必须一致；中途更换授权文件或隔离 CONFIG 会被拒绝。`compare` 只在固定条件一致时可比，`holdout` 只报告使用记录，两者都不产生质量结论。
- 探针窗口限定 driver 步骤；fixture 预置的助手消息不得进入 `last-assistant` 或 `all-assistant` 判定。
- driver 只读 `dataset driver` 的 `userRole` + `driver`；不得读题型、探针、oracle、检查点、证据、判分材料、修复提示或留出材料。driver 里的 `at` 会推进 Node 域固定时钟，不触发真实等待，也不证明真实日程间隔或 Rust／OS 时间已经推进；不要自行等待或伪造跨天。
- 题型（`questionType`）和 `questionTypes` 只用于报告分组，不进入驱动包；驱动代理不需要知道题目分类，避免按题型反推判据。
- 看过 `dataset review` 的代理不得驱动同一个 case；驱动换独立会话／代理。
- 桌宠可读测试工作区、工具许可范围与报告目录不得泄漏题库、gold 或 judge 材料；泄漏的运行显式标受污染，不能称盲测。
- 权限等待沿用现有消息链／控制链分离；不因等待用户回复死锁，不自动重放未知副作用。
- 旧 ready、错回执、跨代际、过期授权不得续用；trial 起点在副作用前声明，结束在任务收敛或明确中断后声明。

## 报告与人工关口

- 人读与机读报告从同一证据集合派生；`report` 按“结论卡→检查对照→时间线→原始证据”四层重建，不反向定义 oracle，也不成为业务真相。存在冻结计划或多个 attempt 时先给多 trial 聚合（试次表、规则矩阵、critical `pass^k`、非 critical 分布、judge 身份与证据引用），再按 attempt 展开；门禁问题优先于通过结论。
- 分开显示“声明覆盖”“实际触达”“有证据验证通过”；多标签不增加 case 数，主动作未发生时不宣称验证了主动引用。
- 执行／证据／检查状态分离；缺证据或执行未完成时显式阻断结论，不输出掩盖问题的单一总分。
- 结论卡展示判分者平台／模型／prompt 版本、聚合规则与 `未抽查`／抽查覆盖；检查对照逐条列出规则、判分理由与证据引用，未抽查的规则明确标注。平台是 judge 自述，报告不得把它当成独立验证。
- 抽查只由用户本人记录（`reviewer.role = "user"`），绑定当前 manifest；记录追加不覆盖。coding agent 不得代填抽查或裁决。
- 结果交用户复核；用户可指出误判、裁决分歧，保留原判分、原证据与真实用户来源。
- 修复只限用户明确授权的代码／行为范围；修复后新建 attempt，禁止改 gold、删断言或题库特判来刷绿。
- 预算、模型调用、实机权限与数据清理均需当次授权；不擅自追加收费调用或修改真实用户数据。

## 边界

- 不新造 Agent runtime、HTTP API、评测网站或通用脚本 DSL。
- 不以 L4 Scene runner 代替完整桌面；L4 不创建正常原生 UI 与监控线程。
- 不把接口通过解释为原生绘制、焦点、声音或 UI 首显已验证。
- 不修改其他记忆评测的保留、双人 gold 与许可规则。
- 当前交付 rubric 已有 `reply.no-oracle-leak`、`chat.delivery-acknowledged`、`delivery.artifact-exists`／`delivery.artifact-content`，但还没有交付类 case；工具产物与真实交付运行尚未验收。
- 真实模型、平台与 Windows／macOS 未跑的一侧明确写未验证。
