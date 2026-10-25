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

## 结构化聊天评测数据集（W1–W2）

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

`saturday-companionship` 合并自两份用户理想稿（原稿已删除），由代理起草，当前是 **silver / pending**，不是 gold。fixture 采用 `direct-seed`：只把初始会话和旧记忆写入隔离数据根，纠正、自动记忆抽取与跨会话召回全部由真实消息触发。它用 27 条用户驱动消息加 2 个 host 步骤（两次新会话）串成三个会话，覆盖纠正、技术梗、短确认、云吃、采购、错误前提与长程回忆；21 条探针逐题绑定驱动步骤、观察窗口、题型与难度（correction、source、style、multi-turn、cross-session、temporal、adversarial、boundary 共 8 种），其中 9 条 critical。时钟固定为 `2026-10-24` 起的三段会话，每个驱动步骤带 `at`。首轮 7 条用户消息来自用户理想稿，其余是代理扩写，必须逐条审阅。空套件目录只有 `.gitkeep`；没有 `suite.json` 就不会进入数据集，也不代表对应类别已经覆盖。一个用例只存一份，`categories` 是多标签；同一 `caseId` 跨套件重复会直接判数据集错误。

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
- 探针至少需要一个非 `semantic` 的 deterministic required 探针；semantic 判定在 W4 校准前不能单独作为通过依据。
- fixture 必须声明 `loading.mode`：`direct-seed` 只预置初始状态并要求 `seed_session`，`real-chain` 禁止同时 seed 会话或记忆；两种模式都必须让待测行为走真实产品入口。
- `fixed` 时钟要求每个驱动步骤带升序 `at`，case 起点不得早于 `fixture.clock`；runner 尚未实现时间注入，固定时钟目前只校验格式，不证明真实间隔行为。
- `difficulty` 是 1–5 的整数，只用于报告分层与覆盖观察，不改变 probe 或 case 的通过判定。
- 探针窗口限定 driver 步骤（`last-assistant` 只匹配 driver 消息步骤），fixture 预置的助手消息不能进入风格或泄漏判定。
- 记忆纠正后的自动抽取由真实消息触发；手动 `memory_dreaming_sweep` 不能证明定时 dreaming 调度，当前 case 不依赖手动 sweep。

### 题型与评审权威

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

评审权威由 checker 决定，而不是由题型决定：

| 权威 | 适用 | 谁能给出正式判定 |
|---|---|---|
| `deterministic` | 非 semantic checker（结果、路径、来源、时序、送达） | runner 直接判定 |
| `api-judge` | 非 humanizer 的 semantic checker | 与被测模型异构的 API judge |
| `human` | 全部 `humanizer.*` semantic checker，以及 humanizer 质量 rubric | 只由用户判定；`assistants: ["coding-agent"]` 仅提供建议 |

带 `human` 权威探针的 case，case 级 `quality.authority` 必须是 `human`；自动化运行只能停在该题的 `pending`，不能用 coding agent 的建议或平均分转成通过。W4 校准前，semantic 判定只作探索。

### 探针与计分单位

- case 是场景容器；probe 是一道可独立判定的题。一条用户消息可以挂多条 probe，case 分不按消息条数算。
- `after` 指定驱动步骤；`window` 决定看哪里：`last-assistant` 只看该步后的助手回复，`state` 看该检查点的产品状态（如记忆来源），`all-assistant` 扫描全部会话的助手回复。
- `polarity: required` 表示 checker 描述的行为必须出现；`forbidden` 表示 checker 描述的错误行为必须不出现。`critical` 表示 case 级通过的必要条件。
- 同一 checker 可以在不同步骤复用；probe id 必须唯一，同一 checker 不能同时 required 与 forbidden。
- case 级通过规则（W4 实现）：critical 探针全部通过、无 forbidden 违例、非 critical 达到用户确认的阈值；不能用平均分掩盖关键失败；human 权威探针未裁决时为 `pending`。
- 结构化探针按权威路由：deterministic 直接判定，非 humanizer 的 semantic 由 API judge 判定（judge 模型必须不同于被测模型），humanizer 的 semantic 只由用户判定。coding agent 只负责聊天驱动、自由评述和最终定性复核；它给出的 humanizer 意见是建议，不能替代用户裁决，也不能替代 API judge 产出结构化通过。

### 命令

```bash
node scripts/desk-pet-chat.mjs dataset validate
node scripts/desk-pet-chat.mjs dataset list
node scripts/desk-pet-chat.mjs dataset types
node scripts/desk-pet-chat.mjs dataset review saturday-companionship
node scripts/desk-pet-chat.mjs dataset driver saturday-companionship
```

这些命令只读数据集，不启动 app、不调用模型。`validate` 输出结构校验、题型分布、评审权威分布与难度分布；`types` 输出题型注册表、覆盖分类与当前探针／用例计数；`review` 输出给人审阅的完整候选、装载方式、题型与权威、难度分布、绑定哈希与旧审批差异；`driver` 输出隔离后的驱动包，不含题型与探针。

W2 的运行器另外提供隔离调试宿主的起停（只做装载，不聊天、不评分）：

```bash
node scripts/desk-pet-chat.mjs eval prepare --case saturday-companionship --card <card.md> [--run-id <id>]
node scripts/desk-pet-chat.mjs eval start --run-id <id>
node scripts/desk-pet-chat.mjs eval status --run-id <id>
node scripts/desk-pet-chat.mjs eval stop --run-id <id>
```

`prepare` 在 `test/.tmp/sim-eval-<id>/` 建隔离根，写入合成 CONFIG、Card 与 `seed.json`；Card 必须由调用方显式给出，不读取真实配置或用户 Card。`start` 只接受 debug 构建，拉起带 `DESKPET_SIM_EVAL=1` 的宿主并核对 `ready.json`、控制通道 ready 与 `seed-report` 的所有权/装载一致；`stop` 只写 `stop.request`，由宿主走产品退出序列并移除 ready，以进程退出且 ready 消失为停止条件；`.instance.lock` 文件按设计保留，锁由 OS 在退出时释放。W2 已于 2026-10-25 验收（隔离启动、ready/装载、非法路径、跨进程单实例、E2E 互斥、真实数据根未变），证据保留在 `test/.tmp/sim-eval-w2-accept-*`；仍不注入固定时钟，也不执行聊天、判分或报告。

### Skill 分工

三个 Skill 共用同一份数据集与 CLI 规则，不复制业务逻辑：

- [`desk-pet-chat`](../sim/desk-pet-chat/SKILL.md)：自然聊天、驱动真实产品、自由评述与最终定性复核；不产出结构化探针的正式通过。
- [`desk-pet-eval-authoring`](../sim/desk-pet-eval-authoring/SKILL.md)：写 case / fixture / probe，展示审阅包，收集用户审批；只做候选与审批，不自动评分。
- [`desk-pet-eval-runner`](../sim/desk-pet-eval-runner/SKILL.md)：结构化运行、确定性检查、API judge 判分与同源报告；human 权威探针停在使用者裁决；W2 只有隔离起停与装载核验，聊天驱动、评分与报告待后续批次。

审阅入口在 authoring Skill：用户说「审阅评测用例」或「看看待审 case」后，Skill 先跑 `dataset list` 列出候选，询问要审哪条，再把 `dataset review <caseId>` 的审阅卡原样贴在聊天区，按批准 / 修改 / 暂缓收集决定。

看过审阅包的代理不得再驱动同一个 case；驱动必须换独立会话，只使用 `dataset driver`。
W1–W2 没有写审批文件的命令，聊天里的批准不会自动变成 gold，也不会生成 approval JSON。

### 规模与样本量

- 不设用户消息条数上限，也不要求凑固定轮数；长日常、干扰信息和跨会话优先，但每条消息都要服务于至少一个探针或必要上下文。
- 以 probe 为单位设计样本量：先让一个长 case 跑通，再按失败模式扩 case；case 数量不凑固定条数。
- 每个 probe 独立判分；case 级结论按 critical 全过、非 critical 阈值和无 forbidden 违例计算。
- 可靠性用重复 trial 的 `pass^k` 观测，保留所有失败尝试，不挑最好一次。

### W1–W2 边界

- schema v3 已实现格式、题型引用、逐探针哈希、审批结构与金/银计算；没有聊天驱动、评分、证据采集与报告闭环。
- W2 已实现 debug 隔离根、宿主 ready 与所有权核验、受控起停和 direct-seed 装载器；装载走产品真实 API，但不注入固定时钟，也没有桌面隔离的集中验收。
- 题型注册表固定 7 族、24 型，并强制覆盖全部 16 个产品分类；当前 case 只用到其中 8 型，注册表存在不代表这些题型已有用例。
- 当前只有 1 条 case、21 条探针（9 条 critical；deterministic 11、api-judge 4、human 6；难度 L1 4／L2 4／L3 5／L4 6／L5 2）；其他套件为空占位，不代表已覆盖对应类别。
- fixture 为 `direct-seed`，固定时钟尚未由 runner 注入；当前不能据此宣称真实跨天间隔、自动抽取时序或桌面隔离已经验证。
- 没有写审批的命令；真实审阅会话的采集与回执写入属于后续批次，W1–W2 只校验已有记录的结构与哈希。
- 不是 CI 门禁，`pnpm test` 不跑数据集；W3–W6 的聊天驱动、证据、自动评分与集中验收仍未实施。
- 已写的单元测试在实施期不运行，统一留到 W6 集中验收；实施期只跑过 `dataset validate`／`types`／`list`／`review`／`driver` 结构校验与脚本语法检查，不代表单元断言或隔离起停已经运行。

## 边界（别误解）

- 哈希只证明"这份审阅绑定这份产物"，**不证明 AI 判断正确**；门禁只核对证据完整性、哈希与审阅覆盖，不冒充语义理解。
- trace 只采结构、数量与已有审计 hash，**正文与工具参数/结果不落 trace**——理想稿的期望不要建立在"trace 里能看到原话"上；要核对正文请回查会话文件。
- 结构化数据集的 `dataset validate` 只证明格式、引用、题型覆盖、时钟/装载约束和哈希绑定，不证明执行、评分或聊天质量；W2 的隔离起停只证明装载与所有权，W1–W2 都不产生任何质量结论。
- API judge 的结构化判定与 coding agent 的自由评述是两种证据，不能互相替代，也不能把后者写成 gold 审批。
- `.ideal.md` 的正文原样保留；不得用结构化用例的运行结果反写或替换用户理想稿。
