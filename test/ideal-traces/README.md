# 理想线路稿与结构化聊天评测数据

本目录有两类用途不同的内容：

| 类型 | 文件 | 谁可以生成 | 用途 |
|---|---|---|---|
| 旧格式理想线路稿 | `*.ideal.md` | 只由用户本人 | trace 审阅的期望对照，正文原样保留 |
| 结构化聊天评测数据集 | `suite.json` / `cases/*.case.json` / `fixtures/*.json` / `approvals/*.json` | 代理可起草 silver；gold 必须用户审批 | 可执行、可评分、可审计的聊天用例池 |

下面「红线」只约束 `.ideal.md`；结构化数据集的审批与哈希规则见本文后半。

本目录存放**只由用户编写**的理想线路稿：对桌宠"应该怎么表现"的期望描述。
它是 [trace 审阅门禁](../README.md#trace记忆质量与性能门禁) 的对照基准，**不是测试产物**——不参与保留淘汰，也不由任何工具生成。

## `.ideal.md` 红线（防假成功条款）

- 理想稿**只由用户编写**：仓库工具与 AI 代理不生成、不修改、不覆盖它。
- **不要把实际 trace 复制或改写成理想稿**——那等于拿现状当期望，审阅必绿而毫无意义
  （`trace-evidence.mjs` 给修复代理的原文：*Never edit or regenerate the ideal trace or treat a previous actual trace as a new oracle*）。
- 修复循环的正确姿势：读差异与证据 → 改产品 → 重跑采集 → **重新审阅**。旧审阅不能批准新产物（哈希绑定）。

## `.ideal.md` 放哪、怎么隔离

- 推荐放本目录，命名约定 `<主题>.ideal.md`；命令接受任意路径，约定只为在 IDE 里一眼区分期望与实际。
- **与自动产物隔离**：本目录不在 `test/reports/` 下——报告与 trace 的保留策略（最近 5 份）不会碰到它。
- **与 git 的关系**：`test/reports/` 与 `test/.tmp/` 在 `.gitignore` 中，本目录**不在**——理想稿默认随仓库版本化（它是"期望规格"，像文档一样值得留痕）。
- **含隐私的理想稿**：移到仓库外任意位置，或自行加 ignore 条目；运行命令时直接传路径即可，目录只是推荐。
- 实际 trace 在 `test/reports/traces/trace-bundle-*.trace.jsonl`（bundle 组，gitignore；bench / quality 运行在各自子目录的 `traces/`，理想稿审阅只针对门禁 L4 trace）；后缀约定让两者一眼可辨：`.ideal.md` 是期望、`.trace.jsonl` 是实际。

## `.ideal.md` 怎么写

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

## `.ideal.md` 审阅工作流

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

## 结构化聊天评测数据集（W1–W5）

结构、哈希与审批绑定由 [`test/sim/desk-pet-chat/dataset.mjs`](../sim/desk-pet-chat/dataset.mjs) 单一实现；本目录只存放数据。分类 id 复用 [`categories.json`](../sim/desk-pet-chat/categories.json)，题型 id 复用 [`question-types.json`](../sim/desk-pet-chat/question-types.json)。

### 目录与首个候选

两份用户理想稿已合并进 `daily-companionship/saturday-companionship`，并按用户要求删除；git 历史仍可追溯。

```text
test/ideal-traces/
├── README.md
└── suites/
    ├── daily-companionship/
    │   ├── suite.json
    │   ├── cases/saturday-companionship.case.json
    │   ├── fixtures/saturday-relationship.json
    │   └── approvals/README.md       # 当前没有审批记录
    ├── memory-correction/.gitkeep    # 空套件占位，不含 suite.json
    ├── session-recall/.gitkeep
    ├── humanizer-expression/.gitkeep
    ├── chat-general/.gitkeep
    └── tool-and-plan/.gitkeep
```

`saturday-companionship` 合并自两份用户理想稿（原稿已删除），由代理起草，当前是 **silver / pending**，不是 gold。fixture 采用 `direct-seed`：只把初始会话和旧记忆写入隔离数据根，纠正、自动记忆抽取与跨会话召回全部由真实消息触发。它用 27 条用户驱动消息加 2 个 host 步骤（两次新会话）串成三个会话，覆盖纠正、技术梗、短确认、云吃、采购、错误前提与长程回忆；23 条探针逐题绑定驱动步骤、观察窗口、题型与难度（correction、source、style、multi-turn、cross-session、temporal、adversarial、boundary 共 8 种），其中 11 条 critical，难度 L1 4／L2 5／L3 6／L4 6／L5 2。时钟固定为 `2026-10-24` 起的三段会话，每个驱动步骤带 `at`。首轮 7 条用户消息来自用户理想稿，其余是代理扩写，必须逐条审阅。空套件目录只有 `.gitkeep`；没有 `suite.json` 就不会进入数据集，也不代表对应类别已经覆盖。一个用例只存一份，`categories` 是多标签；同一 `caseId` 跨套件重复会直接判数据集错误。

### 标签与审批

- 没有审批、最近一次匹配审批为拒绝、或审批绑定的是旧版本，都是 silver。
- 只有用户本人针对当前 `specHash` 的真实会话消息审批，才是 gold。
- 审批绑定 `contentHash` / `fixtureHash` / `driverHash` / `oracleHash` 与聚合 `specHash`；任一变化都会让旧审批变成 stale。审批历史保留，不覆盖、不删除。
- 框架层面的方案通过、代理起草、测试全绿、口头同意都不能转成用例审批；代理不得代填 `reviewer`、`feedbackSource` 或审批结论。
- 审批必须带 `reviewer.role = "user"` 与真实 `session_message` 来源（`sessionId` / `messageId` / `quote`）。工具只校验结构和哈希，不证明审批人身份或消息真实存在；这一信任边界由审阅流程保证。

### 内容规则

- `source.kind` 只能是 `ideal` / `confirmed-issue` / `requirement`；`actual` 实际输出不能充当期望答案或 oracle。
- 多标签用例在用例总数里只计一次，分类计数各自加一。
- case 的 `questionTypes` 必须恰好等于其探针 `questionType` 的并集：声明了却没探针、或探针用了没声明，都是数据集错误。
- 驱动包只含 `schemaVersion` / `caseId` / `revision` / `specHash` / `userRole` / `driver`；`questionTypes`、`probes`、`checkpoints`、`oracle`、`pathConstraints`、`evidence`、`quality` 只进审阅包，不能给驱动。
- fixture 只使用合成或经用户确认可用的数据；初始记忆的 `origin` 必须是 `user`，且来源指向初始会话中的用户消息，不能伪造派生行为记忆。
- 全部探针由独立 coding-agent judge 按 rubric 判定；runner 只校验运行有效性（证据完整、执行完成、窗口有效、oracle 未泄漏）与裁决结构，不产出内容分数，也不替 judge 作判断。
- 探针的内容词表、频率、时间关系、主语别名与跨会话来源只在 `expectation` 声明一次；rubric 注册表只保留通用判据，不维护单个 case 的产品规则。
- fixture 必须声明 `loading.mode`：`direct-seed` 只预置初始状态并要求 `seed_session`，`real-chain` 禁止同时 seed 会话或记忆；两种模式都必须让待测行为走真实产品入口。
- `fixed` 时钟要求每个驱动步骤带升序 `at`，case 起点不得早于 `fixture.clock`；W5 runner 写入 `clock.json` 并在 Node 引导早期推进 Node 域 `Date`，Rust／OS 时间不推进，因此不证明真实日程间隔或 Rust 定时行为。
- `difficulty` 是 1–5 的整数，只用于报告分层与覆盖观察，不改变 probe 或 case 的通过判定。
- 探针窗口限定 driver 步骤（`last-assistant` 只匹配 driver 消息步骤），fixture 预置的助手消息不能进入风格或泄漏判定。
- 记忆纠正后的自动抽取由真实消息触发；手动 `memory_dreaming_sweep` 不能证明定时 dreaming 调度，当前 case 不依赖手动 sweep。

### 题型与判分

题型是探针的认知维度，与产品分类（`categories`）正交：分类说“测哪个能力”，题型说“这道题怎么问”。注册表固定 7 个族、24 个题型，并要求每个已登记分类至少被一个题型覆盖：

| 族 | 题型 | 覆盖分类 |
|---|---|---|
| 记忆 | fact、multi-hop、temporal、correction、forgetting、source、preference、scope、cross-session | memory 为主，兼 chat／safety／session／persona |
| 对话 | multi-turn、open、adversarial、long-context | chat／humanizer／safety／context |
| 执行 | execution、tooling、configuration | plan／tasks／tools／extensions／settings |
| 互动 | interaction、session-lifecycle | proactive／tasks／surface／session／context |
| 感知 | observation、multimodal | observation／memory／chat |
| 边界 | boundary、recovery | safety／tools／settings／resilience／tasks |
| 表达 | persona、style | persona／humanizer／chat |

判分不由题型或规则类别分流，所有探针（含 `humanizer.*`）与 humanizer 质量规则都交给同一个独立 coding-agent judge：

| 环节 | 谁来做 | 产出 |
|---|---|---|
| 冻结判分包 | runner | 规则清单、驱动与证据引用、判分说明；不调用模型、不读凭据 |
| 逐条裁决 | 独立 coding-agent judge（必须与被测模型异构） | 每条规则 `pass` / `fail` / `inconclusive`、理由与证据引用；判分者平台／模型／prompt 版本随裁决记录 |
| 回填与校验 | runner | 校验覆盖、绑定、证据引用与异构性后追加 `grades/`；不合规硬失败 |
| 用户抽查（可选） | 用户本人 | `reviews/` 追加抽查记录；不阻塞、不改写判分 |

case 级 `quality` 只声明 `{ rubric, rubricVersion }`，不声明权威或建议位。judge 与被测模型同源时 `judge apply` 直接拒绝。

### 探针与计分单位

- case 是场景容器；probe 是一道可独立判定的题。一条用户消息可以挂多条 probe，case 分不按消息条数算。
- `after` 指定驱动步骤；`window` 决定看哪里：`last-assistant` 只看该步后的助手回复，`state` 看该检查点的产品状态（如记忆来源），`all-assistant` 扫描全部会话的助手回复。
- `polarity: required` 表示 rubric 描述的行为必须出现；`forbidden` 表示 rubric 描述的错误行为必须不出现。`critical` 用于报告分层。
- 同一 rubric 可以在不同步骤复用；probe id 必须唯一，同一 rubric 不能同时 required 与 forbidden。
- case 级通过规则：所有适用规则（含 quality 规则）均为 `pass` 才通过；任一 `fail` 判失败，任一非 `pass`（含窗口不可用）判 inconclusive；证据不完整或执行未完成时一律 inconclusive，已证实失败不会被缺证据洗掉。用户抽查不参与聚合。
- 判分者只按冻结的判分包与封存证据裁决；runner 只校验运行有效性与裁决结构。coding agent 的自由评述是另一种证据，不能写成 gold 审批或结构化通过。

### 命令

```bash
node scripts/desk-pet-chat.mjs dataset validate
node scripts/desk-pet-chat.mjs dataset list
node scripts/desk-pet-chat.mjs dataset types
node scripts/desk-pet-chat.mjs dataset review saturday-companionship
node scripts/desk-pet-chat.mjs dataset driver saturday-companionship
```

这些命令只读数据集，不启动 app、不调用模型。`validate` 输出结构校验、题型分布与难度分布；`types` 输出题型注册表、覆盖分类与当前探针／用例计数；`review` 输出给人审阅的完整候选、装载方式、题型与判分方式、难度分布、绑定哈希与旧审批差异；`driver` 输出隔离后的驱动包，不含题型与探针。

W2–W5 的运行器提供隔离起停、证据封存、判分包冻结、裁决回填、同源报告、Node 域固定时钟与驱动进度：

```bash
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

`prepare` 在 `test/.tmp/sim-eval-<id>/` 建隔离根，写入合成 CONFIG、Card、`seed.json`、`clock.json` 与授权；Card 必须由调用方显式给出，不读取真实配置或用户 Card；`--authorization` 冻结用例、用途、模型／数据范围、trial／修复预算与 holdout 一致性。`start` 只接受 debug 构建，核对时钟一致后拉起带 `DESKPET_SIM_EVAL=1` 的宿主，并核对 `ready.json`、控制通道 ready 与 `seed-report` 的所有权/装载一致；`drive` 按驱动包逐步推进并持久化进度，中断后从同一进度续跑、不重放未知副作用；`finish` 收口采集、封存 attempt 并生成同源报告，可标记中断及原因；`compare` 只在固定条件一致时对照 baseline 与候选，`holdout` 只报告留出使用；`prepare --repair-of` 新建沿用原 Case 哈希／Card／Profile／时钟的修复 attempt 并保留旧失败；`stop` 只写 `stop.request`，由宿主走产品退出序列并移除 ready，以进程退出且 ready 消失为停止条件；`.instance.lock` 文件按设计保留，锁由 OS 在退出时释放。`judge prepare` 只对已封存完整证据冻结判分包（规则、驱动与证据引用、判分说明），`judge apply` 只校验独立 coding-agent judge 回填的裁决并追加判分；runner 不调用模型 API、不读取 judge 凭据，判分者与被测模型同源时直接拒绝。`review show` 展示判分、证据引用与未抽查标记；`review spotcheck` 只记录用户本人的可选抽查，不阻塞、不改写判分；`report` 从同一证据重建四层报告。W2 已于 2026-10-25 验收（隔离启动、ready/装载、非法路径、跨进程单实例、E2E 互斥、真实数据根未变），证据保留在 `test/.tmp/sim-eval-w2-accept-*`；W3 证据／采集／封存已于 2026-10-25 验收；W4 已实施并通过快层反例验收（2026-10-25），2026-10-26 已跑过一次真实银标（结果 fail）；W5 已实现授权、Node 域固定时钟、驱动／续跑、同条件对照与修复，并于 2026-10-26 集中验收。固定时钟只推进 Node 域 `Date`，Rust 调度器与 OS 时间仍是真实时间。

### Skill 分工

三个 Skill 共用同一份数据集与 CLI 规则，不复制业务逻辑：

- [`desk-pet-chat`](../sim/desk-pet-chat/SKILL.md)：自然聊天、驱动真实产品、自由评述与最终定性复核；不产出结构化探针的正式通过。
- [`desk-pet-eval-authoring`](../sim/desk-pet-eval-authoring/SKILL.md)：写 case / fixture / probe，展示审阅包，收集用户审批；只做候选与审批，不自动评分。
- [`desk-pet-eval-runner`](../sim/desk-pet-eval-runner/SKILL.md)：结构化运行、判分包冻结、独立 judge 裁决回填与同源报告；W2–W5 已有隔离起停、装载、证据封存、独立 judge 判分、同源报告、授权、Node 域固定时钟、驱动／续跑与同条件对照；W6 集中验收已完成，真实 Skill 自主运行与用户关口待执行。

审阅入口在 authoring Skill：用户说「审阅评测用例」或「看看待审 case」后，Skill 先跑 `dataset list` 列出候选，询问要审哪条，再把 `dataset review <caseId>` 的审阅卡原样贴在聊天区，按批准 / 修改 / 暂缓收集决定。

看过审阅包的代理不得再驱动同一个 case；驱动必须换独立会话，只使用 `dataset driver`。
当前仍没有写 gold 审批文件的命令；`eval review spotcheck` 只记录用户对某次运行证据的抽查，不改变 case 的 silver/gold。聊天里的批准不会自动变成 gold，也不会生成 approval JSON。

### 规模与样本量

- 不设用户消息条数上限，也不要求凑固定轮数；长日常、干扰信息和跨会话优先，但每条消息都要服务于至少一个探针或必要上下文。
- 以 probe 为单位设计样本量：先让一个长 case 跑通，再按失败模式扩 case；case 数量不凑固定条数。
- 每个 probe 独立判分；case 级结论要求证据完整、执行完成、全部适用规则均为 `pass`，任一 `fail` 判失败、任一非 `pass` 判 inconclusive；`critical` 只用于报告分层。
- 可靠性用重复 trial 的 `pass^k` 观测，保留所有失败尝试，不挑最好一次。

### W1–W5 边界

- schema v4 已实现格式、题型引用、逐探针哈希、审批结构与金/银计算，探针内容词表统一放在 `expectation`；聊天驱动由 W5 的 `eval drive` 提供。
- W2 已实现 debug 隔离根、宿主 ready 与所有权核验、受控起停和 direct-seed 装载器；装载走产品真实 API，W6 已覆盖隔离启动与装载验收，真实 app 用户操作仍待验证。
- W3 已实现产品 trace 采集、跨会话取证、事务性封存、同源报告与五回保留，并已在 2026-10-25 验收。
- W4 已实现判分包冻结、独立 coding-agent judge 裁决回填、可选用户抽查与四层同源报告；快层反例已运行通过（2026-10-25）。2026-10-26 经用户授权完成一次真实银标运行 `silver-20261026c`（被测 `deepseek-flash`、judge `deepseek-v4-pro`）：全链跑通，总判定 fail（3 条必需 + 2 条禁止规则 fail，1 条 critical inconclusive）；该结果不改变 silver/pending，也不构成质量或 gold 结论。
- W5 已实现授权冻结、Node 域固定时钟、驱动进度与续跑、预算复核、同条件对照、holdout 记录与修复 attempt，并于 2026-10-26 集中验收；真实模型与 judge 已跑过一次银标，真实 Skill 自主运行与用户关口未执行。
- 题型注册表固定 7 族、24 型，并强制覆盖全部 16 个产品分类；当前 case 只用到其中 8 型，注册表存在不代表这些题型已有用例。
- 当前只有 1 条 case、23 条探针（11 条 critical；难度 L1 4／L2 5／L3 6／L4 6／L5 2）；其他套件为空占位，不代表已覆盖对应类别。
- fixture 为 `direct-seed`，固定时钟只推进 Node 域 `Date`；当前不能据此宣称真实跨天间隔、Rust 定时、自动抽取时序或桌面隔离已经验证。
- 没有写 gold 审批的命令；W4 的 `review spotcheck` 只记录用户抽查，不改变 case 标签。真实用户审阅会话的审批记录写入仍属后续批次。
- 不是 CI 门禁，`pnpm test` 不跑数据集；W6 集中门禁与 CE-01–CE-20 映射已于 2026-10-26 完成，真实模型／judge 已跑过一次银标，真实 Skill 自主运行、用户关口与 CI 门禁仍未执行。
- 已写的单元测试在实施期不运行，统一留到验收环节集中执行；W1–W3 曾在验收轮运行结构校验与相关快层，W4 快层已在 2026-10-25 运行通过，W5 已于 2026-10-26 集中验收；2026-10-26 的真实银标已跑通模型与独立 judge 各一次，但仍不代表真实 Skill 自主聊天、用户关口或质量结论已经验证。

## 边界（别误解）

- 哈希只证明"这份审阅绑定这份产物"，**不证明 AI 判断正确**；门禁只核对证据完整性、哈希与审阅覆盖，不冒充语义理解。
- trace 只采结构、数量与已有审计 hash，**正文与工具参数/结果不落 trace**——理想稿的期望不要建立在"trace 里能看到原话"上；要核对正文请回查会话文件。
- 结构化数据集的 `dataset validate` 只证明格式、引用、题型覆盖、时钟/装载约束和哈希绑定，不证明执行、评分或聊天质量；W2 的隔离起停只证明装载与所有权，W1–W3 的结构与证据校验不产生质量结论；W4 判分已有一次真实银标的流程与裁决记录（fail），但仍不能当成聊天质量或 gold 结论。
- 独立 coding-agent judge 的结构化裁决与 coding agent 的自由评述是两种证据，不能互相替代，也不能把后者写成 gold 审批。
- `.ideal.md` 的正文原样保留；不得用结构化用例的运行结果反写或替换用户理想稿。
