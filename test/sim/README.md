# test/sim — 开发期陪伴闭环演练

这不是一个 CI 测试层，也不进契约门禁。它是**真实 app 进程内**的开发期演练工具：
让 Claude Code 通过文件控制通道和桌宠聊天，并在同一个进程里触发静默了解、dreaming、
主动消息与定时任务。不启动 E2E 宿主，不替换模型，不伪造业务入口。

与桌宠聊天时先读 [`desk-pet-chat/SKILL.md`](desk-pet-chat/SKILL.md)。评测数据集另有两个 Skill：
写题与用户审批见 [`desk-pet-eval-authoring/SKILL.md`](desk-pet-eval-authoring/SKILL.md)，
结构化执行、判分包冻结、裁决回填与报告见 [`desk-pet-eval-runner/SKILL.md`](desk-pet-eval-runner/SKILL.md)。
三者共用同一份数据集与 CLI 规则；当前候选、最近运行与剩余验收项见
[未完成工作与已知缺口 §12](../../docs/plans/active/未完成工作与已知缺口.md)；实施批次与历史验收证据见
[聊天评测闭环执行契约（归档）](../../docs/history/implementation/聊天评测闭环执行契约-2026-10-26归档.md)。

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
node scripts/desk-pet-chat.mjs eval batch --case saturday-companionship --card <card.md> --authorization <auth.json> [--trials <n>] [--evaluation-run-id <id>] [--baseline <evalRunId>]
node scripts/desk-pet-chat.mjs eval compare --run-id <id> [--baseline <evalRunId>] [--json]
node scripts/desk-pet-chat.mjs eval holdout --case saturday-companionship [--json]
node scripts/desk-pet-chat.mjs eval judge prepare --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval judge apply --run-id <id> --verdicts <file.json> [--json]
node scripts/desk-pet-chat.mjs eval review show --run-id <id> [--attempt-id <id>] [--json]
node scripts/desk-pet-chat.mjs eval review spotcheck --run-id <id> --checks <file.json> [--reviewer-name <name>] [--notes <text>] [--json]
node scripts/desk-pet-chat.mjs eval report --run-id <id> [--json]
node scripts/desk-pet-chat.mjs eval stop --run-id <id>
node scripts/desk-pet-chat.mjs eval rescue --run-id <id> [--reason <text>]
```

`dataset` 命令只读 `test/ideal-traces/suites/`，不启动 app、不调用模型；当前候选与题型／难度分布以
`dataset list`／`dataset review` 输出为准，其他套件为空占位。
数据集为 schema v4：fixture 声明 `loading`（`direct-seed` 直接写隔离数据根 / `real-chain` 走真实导入），
`fixed` 时钟要求每个 driver 步骤带升序 `at`，每条探针带 `questionType` 与 1–5 的 `difficulty`，
每条探针声明 `rubric`，内容词表、频率、时间关系、主语别名与跨会话来源只在 `expectation` 声明一次，rubric 注册表只保留通用判据；
case 的 `questionTypes` 必须等于探针题型并集；探针观察窗口限定在 driver 步骤，避免 fixture 预置的助手消息污染。
需要真实交付的 case 可声明 `deliverables`（`id`／`role`／数据根内相对路径／可选 `maxBytes`，需 `tools` 宿主能力），
并配 `delivery.artifact-exists`（只判存在与完整，不带词表）或 `delivery.artifact-content`（至少声明包含或不包含之一）
探针，窗口固定为 `artifact`；交付路径只进 oracle 绑定，不进驱动包。消息步骤可用唯一占位符 `{{dataRoot}}`
指向隔离数据根：驱动包保留占位符原样，发送时渲染。声明 `precondition.toolApproval: "allow-once"` 时，
驱动在消息在飞期间轮询单槽确认并只允许一次，确认记录随进度持久化。
题型注册表是 [`desk-pet-chat/question-types.json`](desk-pet-chat/question-types.json)，共 7 个家族、24 个题型，
每个产品分类至少被一个题型覆盖。`review` 给人看完整候选、题型与判分方式、装载方式、难度分布与审批差异；`driver` 只输出
`schemaVersion`／`caseId`／`revision`／`specHash`／`userRole`／`driver`，不含题型、probes、oracle、检查点、证据或评分。
代理只能起草 silver；gold 必须由用户针对当前 `specHash` 的真实会话消息审批，代理不得代填审批或把框架通过当成用例审批。
authoring Skill 会先列候选、询问要审哪条，再把审阅卡贴到聊天区；gold 审批只由 `dataset approve` 写入，且只接受用户本人给出的真实来源，数据集校验通过不产生质量结论。

### 外部公开集适配

外部公开任务沿用同一 schema、fixture、driver、rubric、审批、隔离运行与独立 judge 流程；适配器把允许的上游输入转成现有 case，不另建评测框架，也不声称复现官方完整 benchmark。来源和固定版本见 [`external/catalog.json`](desk-pet-chat/external/catalog.json)，适配、安装和接线入口在 `external/`。长期数据位于忽略的 `test/sim/desk-pet-chat/external/.data/<dataset>/`：原始文件在 `raw/`，编译套件在 `dataset/`；临时验收可显式使用 `test/.tmp/external-eval/`。`fetch` 只取公开文件且不读账号凭据；固定版 `install` 会校验来源并复用有效缓存。GAIA 属 gated 数据，只有本机已有授权登录时才可安装；令牌只供下载子进程使用，不写入收据或日志。

```bash
node scripts/desk-pet-chat.mjs dataset external catalog
node scripts/desk-pet-chat.mjs dataset external install all
node scripts/desk-pet-chat.mjs dataset external status all
node scripts/desk-pet-chat.mjs dataset external verify all
node scripts/desk-pet-chat.mjs dataset external connect all --card-name <runtimeCardName>
node scripts/desk-pet-chat.mjs dataset external connect <dataset> --card-name <runtimeCardName>
node scripts/desk-pet-chat.mjs dataset external fetch multichallenge
node scripts/desk-pet-chat.mjs dataset external fetch memoryarena
node scripts/desk-pet-chat.mjs dataset external prepare <dataset> --input <local-path> [--revision <fixed-40-char-commit>] [--split <split>] [--limit N] [--output <path>]
node scripts/desk-pet-chat.mjs dataset external import <dataset> --input <local-path> [--revision <fixed-40-char-commit>] [--split <split>] [--limit N] [--output <path>] --card-name <runtimeCardName>
node scripts/desk-pet-chat.mjs dataset validate --dataset-root test/sim/desk-pet-chat/external/.data/<dataset>/dataset
node scripts/desk-pet-chat.mjs dataset list --dataset-root test/sim/desk-pet-chat/external/.data/<dataset>/dataset
node scripts/desk-pet-chat.mjs dataset review <caseId> --dataset-root test/sim/desk-pet-chat/external/.data/<dataset>/dataset
node scripts/desk-pet-chat.mjs dataset driver <caseId> --dataset-root test/sim/desk-pet-chat/external/.data/<dataset>/dataset
node scripts/desk-pet-chat.mjs eval prepare --case <caseId> --dataset-root test/sim/desk-pet-chat/external/.data/<dataset>/dataset --card <card.md> --authorization <auth.json>
node scripts/desk-pet-chat.mjs eval batch --case <caseId> --dataset-root test/sim/desk-pet-chat/external/.data/<dataset>/dataset --card <card.md> --authorization <auth.json>
node scripts/desk-pet-chat.mjs eval prepare --case <caseId> --dataset-root <suite-root> --card <card.md> --authorization <auth.json> --model-settings <settings.json>
node scripts/desk-pet-chat.mjs dataset external run memoryarena --config <config> --task <groupId> --card <card.md> --authorization <auth.json> [--model-settings <settings.json>]
node scripts/desk-pet-chat.mjs dataset external run lhtb --task <taskId> --card <card.md> --authorization <auth.json>
node scripts/desk-pet-chat.mjs dataset external smoke
```

`install <dataset|all>` 安装 catalog 固定版本的完整输入；`status` 查看安装与接线清单，`verify` 离线校验收据、文件字节与哈希，`connect` 编译 GAIA、MultiChallenge、BEAM 静态聊天套件并要求显式 Card 名称。首次安装只下载缺失文件，已安装缓存先校验并复用，内容不符时拒绝覆盖。GAIA 安装包含 2023 validation 与公开 test 文件；test split 的 `Final answer` 全为 `?` 占位符，只保存任务与附件，不编造答案或编译为可评分用例。GAIA 需用户本机已有获准的 Hugging Face 登录。`fetch` 仍用于 catalog 固定 revision 中的单个公开文件，默认最多 128 MiB、请求超时 30 秒；BEAM 可用 `--url` 选取固定版本的单个源文件。

需要网络代理的机器应为下载进程提供 `HTTPS_PROXY`／`HTTP_PROXY`，并使用项目固定的 Node 22.22.3 以 `node --use-env-proxy scripts/desk-pet-chat.mjs dataset external fetch …` 运行。Node 的普通 `fetch` 不会自动继承 macOS 系统代理；本入口不读取或修改系统代理配置。HTTP 重定向仅允许登记的上游与官方 CDN，下载后仍核对固定内容哈希。

`prepare` 只规范化本地输入；`import` 默认把新套件写到 `test/sim/desk-pet-chat/external/.data/<dataset>/dataset/`，也可用 `--output test/.tmp/external-eval/<dataset>` 指定临时根；已有输出拒绝覆盖。`connect` 以对话为组共享历史 fixture，完整记录任务清单、上游身份、固定 revision、源文件哈希和阻塞项。GAIA 附件在连接时核对来源和哈希；每次隔离运行的 `eval prepare` 再将附件复制进该 run data root，不会仅凭附件引用把缺失文件改成可运行。MemoryArena 的环境型任务保留顺序、多会话、原始依赖和状态，不压扁成互不相关的静态问题。`.data/` 不纳入 Git。所有导入用例保持 silver；运行或 judge 通过不能自动升为 gold，审批仍由用户按真实会话消息作出。驱动只含 userRole 与 driver；参考答案与判据进入 oracle／独立判分包。静态用例的目标回合排在固定时钟基准之后一小时：模拟时钟只前进不回退，宿主从 `start` 到 `drive` 之间已真实走过时间，步骤时间若贴着基准会在第一个驱动步骤就阻塞。改这条排期口径后 GAIA、MultiChallenge、BEAM 共用同一编译器，需各自重新 `connect` 才能运行。

输入格式取决于适配器：GAIA、MultiChallenge 接受本地 Parquet／JSON／JSONL，MemoryArena 接受 JSON／JSONL；GAIA 默认 validation，也可显式 `--split dev` 或 `--split validation`，不接受 gated test split。BEAM 接受 JSON／JSONL records 或含 `chats/<split>/<chatId>/chat.json` 与 `probing_questions/probing_questions.json` 的本地目录。LHTB 接受包含 `tasks-2.0/`（或指定版本目录）及 `task.toml`／`instruction.md` 的本地 checkout。Parquet 使用测试侧轻量解码器直接读取，保留嵌套结构并检查字节／行数上限；不能在转换时丢弃附件或环境文件。

安装与完整数据范围（固定 catalog revision）：GAIA 已安装 111 个文件，含 validation 165 题和 test 301 题；test 的 301 个答案值均为占位符。validation 引用 38 个附件，test 引用 71 个附件，均随原始数据保存。MultiChallenge 266 个对话已编译为 266 个 case；BEAM 的 100 个对话、2,000 个 probe 已编译为 2,000 个 case，按原对话共享 fixture。BEAM 10M 档的独立来源 revision 随记录保存。MemoryArena 已安装 701 个对话、4,850 个 probe 以及旅行、购物、搜索资源；LHTB 已安装完整的 77 个任务源码与 verifier/Harbor 输入。

适配范围与当前执行边界：

- **GAIA**：验证集文本题和附件题均可进入编译；附件在每次隔离运行前核对 SHA-256 并复制到 run data root。公开 test split 的占位答案不用于评分。仍不复现官方工具环境或官方评分。
- **MultiChallenge**：把原始 conversation 的最后一条 user 消息作为唯一 live 请求，之前的 user／assistant 消息作固定历史；上游 `target_question` 与 `pass_criteria`（通常为 YES）仅作为 judge criterion／oracle，不进入 driver。适配结果不声称重现官方排行榜评分。
- **BEAM**：保留完整角色历史，并按 probe 逐题生成 fixed-history case；只驱动一个目标 probe，不声称重现批量摄入、在线记忆更新或官方 benchmark execution。
- **MemoryArena**：完整任务与资源已安装。group travel 的 MCP / eval 路径已跑通，按原顺序执行多会话子任务并显式标出 dreaming；runner 在 `sim-eval` 根生成 `external-environment.json`，MCP 每次 `tools/call` 前按固定 config、group、subtask index 重置环境，所有会话共用隔离 data root。此重置由 runner 驱动，不依赖模型主动初始化任务。五个 config 均已接入统一运行入口：`bundled_shopping` 走 run-owned loopback 预热包装器，其余经环境 MCP 直接执行；`run` 在创建运行根前按 `verify` 的 per-config 环境就绪度拒绝未满足项。group travel 之外的 config 尚未在真机完成正式运行与验收。
- **LHTB 2.0**：完整任务源码、官方 verifier 与 Harbor 定义已安装，任务镜像按需拉取；已有原始 image、task.toml 与 verifier 的 Harbor smoke 执行记录，仍待最终门禁验收。单任务计划和 MCP 桥通过隔离 runner 执行，评分调用官方 verifier；Desk-Pet 外层报告标作适配执行，不宣称官方排行榜成绩。环境入口 run-id 限 3–39 个字符，为 Harbor 追加的 `-phase-<n>` 后缀保留 48 字符运行上限。

环境 runner 通过 `--mcp-server` 为单次隔离 run 合成 MCP 与超时覆盖；`--model-settings <JSON>` 只暂存为隔离副本的 `eval-models.local.json`，不会改根目录真实配置，可用于本地 scripted-provider 诊断。`environment-turn` 还可通过 `modelSettingsPath` 传同一隔离模型覆盖。MemoryArena 从首个 `chat_new_session` 起在 driver 绑定 config/group/subtask，普通 `eval prepare`／`batch` 缺少已启用的 stdio MCP 时也会在创建运行根前拒绝；`prepare` 写初始环境文件，`start` 传递路径，后续会话由 Node driver 切换，不增加 Rust IPC 命令。MemoryArena 通过 `dataset external run memoryarena` 执行，LHTB 通过 `dataset external run lhtb` 执行；这两类环境的官方判定和 Desk-Pet 外部适配判分必须分开报告。

外部 root 通过 `--dataset-root` 传给 dataset `validate`／`list`／`review`／`driver` 及 runner `eval prepare`／`batch`；运行状态会固定该数据集根，后续 repair、start、report、judge 等按运行状态读取同一根。长期原始文件和套件位于忽略的 `external/.data/<dataset>/`；显式临时输出位于 `test/.tmp/external-eval/`。两者都不得复制到 `test/ideal-traces/`。

#### Coding agent 接手顺序

1. 先读本节和 [运行与判分 Skill](desk-pet-eval-runner/SKILL.md)，执行 `dataset external status all` 与 `dataset external verify all`；`status` 允许查看缺项，`verify` 在任一数据集未装齐或校验失败时非零退出，不应忽略退出码。
2. 同一工作目录复用已经核验的缓存；新 clone／worktree 还须取得未提交的接线代码，并重新 `install all`、`connect all --card-name <名称>`。GAIA 需该机器自己的授权登录；不要复制账号令牌。环境安装包含机器相关的 Python 环境，不能只搬缓存就认为另一台机器可运行。
3. 静态题用 `dataset driver <caseId> --dataset-root <root>`；`driver`／`review` 只加载目标题的历史，避免 BEAM 单题操作载入整个长历史全集。MemoryArena 用 `dataset external tasks memoryarena --config <配置名>` 和 `dataset external plan memoryarena --config <配置名> --task <组id>`；LHTB 用 `dataset external tasks lhtb` 和 `dataset external plan lhtb --task <任务id>`。LHTB 不编译静态套件，因此不在 `connect all` 的输出内。
4. `dataset external smoke` 可用本地 scripted Provider 检查真实原生宿主 → Pi → MCP → 证据封存，不调用付费模型，不代表公开题目得分。正式运行前仍须用户指定 Card、模型、独立 judge 与预算，提供本次授权文件；`plan` 输出中的 caseId 用于授权范围，凭据只放测试侧本地配置，不进授权文件。
5. 运行、冻结判分包和独立 judge 分开执行；读取过 oracle／审阅包的会话不驱动同一题，驱动会话也不能替自己判分。尚未判分、环境失败和模型答错分别报告，不补写成功。

`eval` 命令在 `test/.tmp/sim-eval-<id>` 建隔离运行根，要求显式 `--card`，不读真实 CONFIG；
`prepare` 冻结授权与时钟，`start` 核验时钟一致并开始采集，`drive` 按驱动包逐步推进并持久化进度、中断后从同一进度续跑且不重放未知副作用，
`finish` 收口采集并封存，`stop` 只写 `stop.request`。`.instance.lock` 按设计保留，锁由 OS 在进程退出时释放。
封存时按 case 声明把数据根内交付产物复制成只读证据（`artifacts/deliverable-<id><ext>`），逐项记录
delivered／missing／oversized／invalid；符号链接与越过数据根的路径拒绝采集。产物缺失或超限不改变证据完整性，
由交付规则判失败；报告在原始证据列出交付状态。
宿主退出序列在 flush 之后把真实结果写进运行根的 `exit.json`（pid、Node flush、强杀／中断）；`stop` 核对它与本次宿主绑定、flush 完成且非强杀非中断，缺失或不干净都报问题并计入 `finish` 退出码。
宿主没走完退出序列（崩溃、被强杀）时用 `rescue` 把已落盘的 attempt 草稿按中断封存：宿主仍活着或 attempt 已封存都拒绝，缺对话、缺 trace 封口、缺 `exit.json` 进 issues，封存结果保持 incomplete/inconclusive，绝不冒充完成；封存后可按 `prepare --repair-of` 重新采集。
`batch` 在同一 evaluationRun 下串行执行冻结的 N 个试次：首次运行把 `trialIds`、计划总数与授权指纹写入 `trials.json`，`--trials` 是计划总数（含已有 attempt，默认授权预算），之后不可改写；每个槽位用确定性派生的子运行 id 走 `prepare → start → drive`，`drive` 失败按中断封存后继续，未封存或失败的槽位保持占位、不替换不自动判分。计划外 trialId、重放已有 trialId 或事后补建计划都会硬失败。
`judge prepare` 只对已封存完整证据冻结判分包（含 rubric、驱动、证据引用与判分说明），交给独立 coding-agent judge 逐条裁决；`judge apply` 只校验回填裁决并追加 `grades/`，缺项、重复、未知规则、证据引用无效、判分平台不在 coding-agent 白名单（`claude-code`／`codex`／`qoder`）、判分者与被测模型同源或 packet 哈希不符都会硬失败；平台不在白名单的历史判分不算权威，报告不据其声称独立 judge。runner 不调用模型 API、不读取 judge 凭据。`review show` 展示判分、证据引用与未抽查标记；`review spotcheck` 只记录用户本人的可选抽查，不阻塞也不改写判分。`report` 从同一证据重建四层报告；存在冻结计划或多个 attempt 时先给多 trial 聚合（试次表、规则矩阵、critical `pass^k`、非 critical 分布、judge 身份、证据引用齐备性），再按 attempt 展开。
判分包为 packet schema 3（`chat-judge@5`）：按 case 声明携带交付产物的封存状态与受限内容，单文件 4 KiB、整包 16 KiB 预算，超限截断并标注；二进制、哈希不符或预算耗尽只保留原因，`deliverable:<id>` 是可引用的证据，缺失产物仍可冻结判分包并由裁决判失败。
全部探针统一由独立 coding-agent judge 判定；用户抽查只用于核对，
不会产生或改写 pass/fail，也不能替代 case 的 gold 审批。
`--authorization` 冻结用例、用途、模型／数据范围、trial 与修复预算与 holdout 一致性；`drive` 调用前复核授权指纹与请求模型。
`compare` 只在固定条件一致时对照 baseline 与候选，漂移条件逐项列出；`holdout` 只报告留出使用，两者都不产生质量结论。
修复用 `--repair-of` 新建 attempt，沿用原 Case 哈希、Card、Profile 与时钟并保留旧失败。
驱动 host 步骤支持手工触发 `sim_proactive_tick`／`sim_task_deliver`：直接调用主动 tick 与任务投递的组件入口，
结果带 `manualPath=sim-component`，任务还要求创建与交付完成；报告注明这是组件路径，不代表自然受理、调度或实际 UI 显示。
采集器把活跃会话显式绑定到当前 attempt，主动 tick 的 `proactive_*` 事件才能归入本试次；未绑定会话的事件仍为 orphan。
真实 app／模型 Skill 运行仍需当次授权；固定时钟只推进 Node 域 `Date`，Rust／OS 时间仍是真实时间。

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
