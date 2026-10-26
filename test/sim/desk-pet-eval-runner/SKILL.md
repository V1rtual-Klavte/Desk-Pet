---
name: desk-pet-eval-runner
description: 执行 V1rtual-Desk-Pet 结构化聊天评测用例：冻结规格与预算，隔离驱动真实 app，采集证据，冻结判分包，交由独立 coding-agent judge 回填裁决并输出同源报告。用户说“跑结构化评测”“执行评测用例”“跑一次聊天评测”“判分”时使用。W2 隔离起停与 W3 采集／封存已验收（2026-10-25）；W4 判分包、独立 judge 裁决、可选抽查与同源报告已实现并通过快层反例验收（2026-10-25）；W5 授权、固定时钟、驱动／续跑／预算／同条件对照／修复与 L3 闭环测试已于 2026-10-26 集中验收，并按用户授权完成一次真实银标运行（`silver-20261026c`，结果 fail）。固定时钟只覆盖 Node 域时间；真实 Skill 自主运行与用户关口未执行，不得伪造运行结果。
---

# 结构化聊天评测运行与判分

## 现状（W2–W5）

W2 已实现并验收 **debug 隔离根 + 宿主所有权核验 + direct-seed 装载器**（2026-10-25）。W3a 的测试侧证据封存／同源报告／五回保留模块与 W3b 的产品 trace 采集、跨会话取证、采集生命周期和运行器封存接线已验收（2026-10-25）。W4 已实现：探针 schema v4 的 `rubric` 与声明式 `expectation`、判分包冻结、独立 coding-agent judge 的裁决回填与结构校验、可选用户抽查、四层同源报告；`judge prepare|apply`、`review show|spotcheck`、`report` 已接入 CLI。W3 定向单测、完整 unit、类型检查、Rust 单测、契约哈希与三次隔离封存冒烟已运行通过；真实隔离起停覆盖了 ready／装载核验、非法路径、跨进程单实例、E2E 互斥和停止后锁释放。

W5 已实现：授权文件（用例范围、用途、隔离数据、模型、预算、留出）校验、固定时钟写入运行根并在宿主 Node 引导早期安装、驱动包与同步点校验、`eval drive` 逐步推进、进度续跑（已开始但结果未知的步骤不重放）、预算到界在下一步副作用前停止、`eval compare` 同条件对照、`eval holdout` 留出使用记录，以及 `eval prepare --repair-of` 复用原条件创建新 attempt 并保留旧失败。固定时钟只覆盖宿主 Node 的 `Date`；Rust 调度器、OS 文件时间与跨进程时间戳仍是真实时间，不能据此声称真实跨天间隔已验证。

W5 的快层 `聊天驱动工作流.test.ts` 与 L3 [`聊天评测闭环.test.ts`](../../integration/evaluation/聊天评测闭环.test.ts) 已于 2026-10-26 验收轮通过；CE-01–CE-20 已逐项映射（见执行契约 W6 验收记录）。2026-10-26 经用户授权完成一次真实银标运行 `silver-20261026c`（被测 `deepseek-flash`，judge `deepseek-v4-pro`）：准备、驱动、封存、判分包、裁决回填与同源报告全链跑通，总判定 fail（3 条必需 + 2 条禁止规则 fail，1 条 critical inconclusive）；这证明链路能产生真实判分，不证明判分质量、gold 或用户关口已验证。真实 Skill 自主运行、用户 gold 审批与抽查仍未执行。用户要求“跑评测”时，先说明这些阻塞：没有当次授权就不能启动完整桌面、调用模型或 judge；测试通过不能替代真实运行；一次真实运行也不能当成质量结论。不要用聊天报告、coding agent 的自由评述、隔离起停或快层测试来冒充正式评测结果。

运行器**不调用模型 API、不读取 judge 凭据、不替 judge 作判断**：`judge prepare` 只冻结判分包，`judge apply` 只校验回填裁决并追加记录。判分由外部独立 coding-agent judge（另一个会话／异构模型）按本 Skill 的判分说明完成。

```bash
node scripts/desk-pet-chat.mjs eval prepare --case <caseId> --card <card.md> --authorization <auth.json> [--baseline <evaluationRunId>]
node scripts/desk-pet-chat.mjs eval prepare --repair-of <runId> [--run-id <id>]
node scripts/desk-pet-chat.mjs eval start --run-id <id>
node scripts/desk-pet-chat.mjs eval drive --run-id <id>
node scripts/desk-pet-chat.mjs eval status --run-id <id>
node scripts/desk-pet-chat.mjs eval finish --run-id <id> [--interrupted --reason <text>]
node scripts/desk-pet-chat.mjs eval compare --run-id <id> [--baseline <evaluationRunId>] [--json]
node scripts/desk-pet-chat.mjs eval holdout --case <caseId> [--json]
node scripts/desk-pet-chat.mjs eval judge prepare --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval judge apply --run-id <id> --verdicts <file.json> [--json]
node scripts/desk-pet-chat.mjs eval review show --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval review spotcheck --run-id <id> --checks <file.json> [--reviewer-name <name>] [--notes <text>] [--json]
node scripts/desk-pet-chat.mjs eval report --run-id <id> [--json]
node scripts/desk-pet-chat.mjs eval stop --run-id <id>
node scripts/desk-pet-chat.mjs capture status
node scripts/desk-pet-chat.mjs capture sessions
```

- `prepare` 只在 `test/.tmp/sim-eval-<id>/` 建隔离根，写入合成 CONFIG、显式给出的 Card、`seed.json`、`clock.json`、授权文件与 `driver-package.json`；`--card` 与 `--authorization` 必须由调用方提供，不读取真实 CONFIG、凭据或用户 Card。授权文件声明用例范围、用途、`isolated` 数据范围、模型、预算（`trials > 0`、`repairs >= 0`）与是否留出，留出布尔必须等于用途。
- `start` 只接受 debug 构建，设置 `DESKPET_SIM_EVAL=1` / `DESKPET_SIM_EVAL_RUN_DIR` 拉起宿主，依次核对 `ready.json`、控制通道 ready 与 `seed-report`：pid 必须是本次子进程、`runDir`／`dataRoot`／`controlDir` 必须同源、运行模式必须是 development，控制通道时钟必须与运行根 `clock.json` 一致，fixture／会话／消息数／记忆数必须与 `runner.json` 一致；核对通过后建 attempt 并开始 trace 采集。
- `drive` 只按驱动包推进：每步先复核授权指纹与请求模型，再推进固定时钟、发送消息或执行 host 步骤、等待检查点；进度写入 `driver-progress.json`，中断后用同一命令续跑，已完成、已阻塞或有 in-flight 的进度拒绝续跑；消息／分钟／已知 token 预算在下一步副作用前到界阻塞，未知用量记 unknown 不记零。每个消息步骤生成唯一 `operationId`，回执必须原样回带 `caseId`／`trialId`／`sessionId`／`generation`／`stepId` 与 `requestId`；缺身份、错组或会话／代际不一致直接失败，排队回复按同一 `requestId` 的 run 分支取回，不回落到最后一条助手消息。采集期间手动写入的 `chat` 消息没有 drive 身份，会被拒绝。驱动失败写 blocked，不自动重放已完成副作用。
- `memory_extraction_end` 检查点在消息副作用之前抓取作业基线，只把基线之外的新抽取作业算作本步触发；新作业必须到达终态（`completed`／`failed`／`cancelled`）且 `pendingSources=0`、`activeJobs=0` 稳定后才满足。空水位 `0/0`（没有任何新作业）不算抽取结束，超时以“没有发现新抽取作业”或未收口作业明细收口。检查点只证明抽取作业发生并结束，不证明抽取内容正确——内容仍由状态探针与 judge 判定。
- `finish` 只按驱动结果收口：驱动未完成时必须显式 `--interrupted --reason <text>`，不能补写完成边界；随后结束试次、收口采集、写 dialogue、补声明会话、封存 attempt 并生成同源报告。
- `compare` 只比较两次运行的固定条件（case／fixture／driver／模型／宿主／版本），代码／Card／配置等目标变化只记录，缺失固定字段记为不可比；`holdout` 只报告某个 case 被哪些保留运行引用（含在途与待审），不产生质量结论。
- `prepare --repair-of` 只接受已封存 attempt，复核数据集哈希、Card、Profile 与时钟与原运行一致，并按授权修复次数在同一 evaluationRun 下创建新 attempt；旧失败、旧证据与旧判分保留，不能覆盖。
- `stop` 只写 `stop.request`，由宿主走产品退出序列并移除 ready，未完成采集以中断状态收口。停止条件是进程退出且 ready 消失。`.instance.lock` 文件按设计保留（OS 在进程退出时释放锁，删除文件会引入 unlink 竞争），无残留判据是无宿主进程、无 ready、锁未被持有且真实数据根未变。不要 kill 进程来“收尾”。
- `status` 只读现有证据，不修复、不重启、不清理失败现场；`capture status|sessions` 通过开发控制通道核对本次采集的范围与来源，不读取真实用户会话。
- `judge prepare` 只在证据完整、执行完成、数据集绑定未漂移且驱动无 oracle 泄漏时冻结判分包（规则、对话、状态、产物哈希与允许的证据引用）；不调用模型，也不写判分。
- `judge apply` 只接收外部 coding-agent judge 回填的 `verdicts` JSON，校验覆盖、绑定、证据引用、异构性与 prompt 版本后追加 `grades/`；不合规硬失败，不修正、不补写裁决。
- `review show` 展示判分、规则对照与“未抽查”标记；`review spotcheck` 只接受用户本人填写的抽查记录，追加 `reviews/`，不阻塞也不改写判分。
- `report` 从同一证据集合重建“结论卡→检查对照→时间线→原始证据”四层报告；报告不反向定义 oracle，也不成为业务真相。W5 驱动、固定时钟、续跑与对照已于 2026-10-26 验收；真实银标运行已产生一份 fail 报告，但仍不能把快层通过或单次真实运行当成质量验收。

当前候选 `saturday-companionship` 为 27 条用户消息 + 2 个 host 步骤、3 个会话、23 条探针（11 条 critical；难度 L1 4／L2 5／L3 6／L4 6／L5 2），schema v4，fixture 为 `direct-seed`，时钟固定。W2 装载器会把 fixture 的初始会话/记忆写入隔离数据根，纠正、自动记忆抽取和跨会话召回仍应由真实消息触发；W5 runner 会写入 `clock.json` 并在宿主 Node 引导早期安装固定时钟，但只覆盖 Node 域时间，Rust 调度器、OS 文件时间与跨进程时间戳仍是真实时间，不能假装真实跨天间隔已经发生。自动抽取要等 Node 调度器按真实节拍命中抽槽并完成真实模型调用，因此消息时间需落在抽槽窗口内，检查点按新作业收口而不是按空闲水位判定。探针窗口只看 driver 步骤，fixture 预置的助手消息不参与判定。探针内容只在 `expectation` 声明，rubric 注册表只保留通用判据；当前 chat-only case 没有交付／工具结果 rubric，交付类反例只能由证据完整性与执行状态表达。

## 只读数据集入口

```bash
node scripts/desk-pet-chat.mjs dataset validate
node scripts/desk-pet-chat.mjs dataset list
node scripts/desk-pet-chat.mjs dataset types
node scripts/desk-pet-chat.mjs dataset driver <caseId>
```

`review` 是给用户审批看的，驱动方不得先读。隔离起停和结构校验通过都不产生质量结论。

## 流程（W5 运行器已于 2026-10-26 验收）

以下完整流程已有运行器入口：`prepare --authorization` 冻结规格、预算与固定时钟 → `start` 拉起隔离的完整桌面 → `drive` 按驱动包推进 → 崩溃或中断后从同一进度续跑 → `finish` 收口采集、封存与报告 → `judge prepare|apply` → 可选 `review spotcheck` → `report`；修复用 `prepare --repair-of` 新建 attempt，旧失败保留。真实模型与 judge 已于 2026-10-26 经授权跑通一次银标；再次真实运行仍需当次授权，真实 Skill 自主运行未执行，不能因测试通过或单次运行就声称质量已经验收。

```text
冻结 case 选择、运行意图、trial 数、预算、允许修复范围
  → 启动隔离的完整桌面 app（正常初始化，不是无 UI 的 L4）
  → 每个 trial 重建身份、会话、任务、许可与时间域
  → 只把 userRole + driver 交给聊天执行者
  → 声明检查点，等待真实完成事件或有限超时
  → 采集对话、事件、来源、状态 before/after 与实际产物
  → 封存证据；runner 核对证据完整、执行完成、窗口有效与 oracle 未泄漏
  → 冻结判分包，交给独立 coding-agent judge（异构模型）逐条裁决
  → judge apply 校验并追加判分；用户抽查可选、不阻塞
  → 生成同源报告
  → 授权修复后创建新 attempt，保留旧失败
```

一次实际执行是一个 evaluationRun；同一修复循环的所有 attempt、case、trial、报告、判分与抽查属于同一保留组。留最近五组，失败与成功同等保留，待审／在途组受保护。

## 判分边界

- **全部规则统一由独立 coding-agent judge 判定**：探针（含 `humanizer.*`）与 humanizer 质量规则没有权威分流，也不存在 runner 自带的确定性内容判定。题型（`questionType`）、`critical` 与 `difficulty` 只用于报告分组、覆盖统计与分层，不决定由谁判分。
- **runner 只核运行有效性**：证据完整、执行完成、探针窗口可用、oracle 未泄漏进驱动、数据集绑定未漂移。这些前置条件只决定“能否判分”，不产生任何探针分数。
- **声明式期望，通用 rubric**：事实、频率、时间关系、主语别名、跨会话来源与禁止项只在探针 `expectation` 声明一次；rubric 注册表不复制单个 case 的内容词表。未知 rubric、缺失或多余的 expectation 直接失败，不静默通过。
- **判分包是判分唯一输入**：包含规则、对话、状态、产物哈希与允许的证据引用，不包含仓库源码、测试期望、历史判分或 gold。judge 不得修改证据或判分包。
- **异构性**：`judge.identity` 记录执行裁判的平台、模型与 prompt 版本；judge 模型去标签归一化后必须不同于 manifest 中记录的请求模型与实际模型。judge 与被测模型同源或被测身份未知时拒绝。
- **裁决格式**：每个 `ruleId` 恰好一条 `pass` / `fail` / `inconclusive`，理由非空；`pass` / `fail` 至少引用一条 `allowedEvidenceRefs`，`inconclusive` 可说明缺失或冲突证据。漏项、重复、未知规则、引用越界、packetId／packetSha256／caseId／promptVersion 不匹配都硬失败。
- **聚合规则**：所有适用规则（含 quality 规则）均为 `pass` 才通过；任一 `fail` 判失败，任一非 `pass`（含窗口不可用）判 inconclusive；证据不完整或执行未完成时一律 inconclusive。用户抽查不参与聚合。
- **跳过规则由 runner 记录**：窗口不可用的规则不交给 judge，运行器直接记为 inconclusive 并说明原因。
- **抽查可选**：用户想看结果时才抽查；抽查记录只用于核对与保留分歧，不阻塞运行、不改写判分、不会把 inconclusive 变回 pass。
- **快层通过不等于正式评测**：W4 快层反例已运行通过（2026-10-25），W5 驱动／续跑／对照测试已于 2026-10-26 通过；真实模型与真实 judge 已完成一次银标运行（`silver-20261026c`，fail），真实 Skill 自主运行与用户关口仍未验证，不能把判分流程测试或单次运行当成质量结论。
- **证据冻结**：grades／reviews 每次新增版本，绑定原始证据与规则；不得覆盖旧判分、旧证据或用户抽查。

## 驱动与隔离

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

- 人读与机读报告从同一证据集合派生；`report` 按“结论卡→检查对照→时间线→原始证据”四层重建，不反向定义 oracle，也不成为业务真相。
- 分开显示“声明覆盖”“实际触达”“有证据验证通过”；多标签不增加 case 数，主动作未发生时不宣称验证了主动引用。
- 执行／证据／检查状态分离；缺证据或执行未完成时显式阻断结论，不输出掩盖问题的单一总分。
- 结论卡展示判分者平台／模型／prompt 版本、聚合规则与`未抽查`／抽查覆盖；检查对照逐条列出规则、判分理由与证据引用，未抽查的规则明确标注。
- 抽查只由用户本人记录（`reviewer.role = "user"`），绑定当前 manifest；记录追加不覆盖。coding agent 不得代填抽查或裁决。
- 结果交用户复核；用户可指出误判、裁决分歧，保留原判分、原证据与真实用户来源。
- 修复只限用户明确授权的代码／行为范围；修复后新建 attempt，禁止改 gold、删断言或题库特判来刷绿。
- 预算、模型调用、实机权限与数据清理均需当次授权；不擅自追加收费调用或修改真实用户数据。

## 边界

- 不新造 Agent runtime、HTTP API、评测网站或通用脚本 DSL。
- 不以 L4 Scene runner 代替完整桌面；L4 不创建正常原生 UI 与监控线程。
- 不把接口通过解释为原生绘制、焦点、声音或 UI 首显已验证。
- 不修改其他记忆评测的保留、双人 gold 与许可规则。
- W4 当前没有交付／工具结果 rubric；交付类反例只能由证据完整性与执行状态表达，不能声称已覆盖真实工具产物。
- 真实模型、平台与 Windows／macOS 未跑的一侧明确写未验证。
