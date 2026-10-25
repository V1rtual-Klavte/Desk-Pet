---
name: desk-pet-eval-authoring
description: 起草、修订和审阅 V1rtual-Desk-Pet 结构化聊天评测用例，向用户展示审阅包并收集 gold 批准。用户说“写评测用例”“审阅评测用例”“看看待审 case”“批准这个用例”“改一下评测题”时使用。只写数据集与审批，不启动 app、不跑评分；执行与判分用 desk-pet-eval-runner。
---

# 写与审阅聊天评测用例

## 这是什么

这个 Skill 只做两件事：把用户意图或已确认问题写成结构化 case，以及把候选完整展示给用户、收集真实批准。它不启动桌宠、不驱动聊天、不运行评分，也不把“框架通过”当成用例批准。

当前为 schema v3：case 是可跨会话的场景容器，探针（probe）是独立计分的最小断言。一个用户消息可以挂多条探针；case 通过要求全部关键 `required` 成立、非关键达到阈值且没有 `forbidden` 违规。每条探针必须带一个 `questionType`，case 的 `questionTypes` 必须等于其探针题型的并集；评审权威由 checker 决定，不由题型决定。

## 边界

- 代理只能起草 **silver**；**gold 必须由用户本人**针对当前 `specHash` 的真实会话消息批准。代理不得代填 `reviewer`、`feedbackSource` 或 `decision`。
- `actual` 实际输出不能当期望答案或 oracle；不要复制实际 trace 回填用例。
- 旧格式 `*.ideal.md` 只由用户编写；用例运行结果不能反写理想稿。
- 数据集只使用合成或经用户确认可用的 fixture，不读取真实 CONFIG、凭据或私人会话。
- 用例不携带任意 JS／Bash 代码；动作只用已登记的命令与 host 请求，真正的工具任务走产品正常授权通路。
- 未运行测试前，`dataset validate` 通过只证明格式、引用和哈希绑定，不证明执行、评分或聊天质量。
- 不修改产品代码、不启动 app、不调用模型、不提交代码。

## 数据位置

```text
test/ideal-traces/
  suites/<suiteId>/
    suite.json
    cases/<caseId>.case.json
    fixtures/<fixture>.json
    approvals/
```

- suite 是选择、审阅、运行与保留的单位；类别只是 case 的多标签，不按类别拆目录。
- 空套件只有 `.gitkeep`；没有 `suite.json` 就不进入数据集，不代表已覆盖该类别。
- 分类 id 的唯一真相源是 [`../desk-pet-chat/categories.json`](../desk-pet-chat/categories.json)。
- 题型 id 与家族的真相源是 [`../desk-pet-chat/question-types.json`](../desk-pet-chat/question-types.json)；每个分类至少被一个题型覆盖。
- 一个 case 只存一份；同一 `caseId` 跨套件重复是数据集错误。
- 当前只有 `daily-companionship/saturday-companionship` 一条 silver/pending 候选（27 条用户消息 + 2 个 host 步骤、21 条探针其中 9 条 critical、fixture 为 `direct-seed`、固定时钟），其他套件为空占位。

## case 必需内容

| 部分 | 规定 |
|---|---|
| 来源与意图 | 要验证的能力、原始 ideal 段落或已确认问题；不拿文件名充当需求 |
| 题型 | `questionTypes` 必须等于探针 `questionType` 的并集；题型表达认知／结构挑战，产品分类仍写在 `categories` |
| 前置条件 | Card、关系阶段、初始会话与记忆、资源、时间、权限、所需宿主能力 |
| 装载与时钟 | `fixture.loading` 选 `direct-seed`（只预置初始状态）或 `real-chain`（不 seed 会话/记忆）；`fixed` 时钟每个 driver 步骤带升序 `at`，case 起点不早于 `fixture.clock` |
| 用户角色包 | 用户知道的事实、目的、语气与允许动作；不得含隐藏探针、内部状态结果或背诵答案 |
| driver | 按顺序的用户消息与 host 步骤；`fixed` 模式下每步带 `at`；自然分支、追问应答、停止条件 |
| 检查点 | 可判定的事件或状态边界＋有限等待；不用固定 sleep 代替完成证据 |
| probes | 逐条绑定 `after` 驱动步骤，写清窗口、极性、critical、checker、`questionType`、`difficulty`、描述与证据 |
| oracle | 只放允许替代表达；不再使用 case 级 `required` / `forbidden` |
| 路径约束 | 必要先后、禁止副作用、合法工具替代；不锁死每一步工具序列 |
| 证据要求 | 消息、事件、来源、状态差异、真实产物；缺失时如何判定 |
| 质量规则 | 适用维度、正例／反例／边界例、合法静默或不适用 |
| 治理 | 标签按批准记录计算，开发／校准／留出／回归用途、版本与内容哈希 |

### 探针字段

| 字段 | 取值与约束 |
|---|---|
| `after` | 已存在的 driver 步骤 id；`last-assistant` 只能跟用户消息步骤，不能跟 host 步骤 |
| `window` | `last-assistant`（该步回复）、`state`（检查点处的产品状态）、`all-assistant`（跨会话全部助手回复） |
| `polarity` | `required`（checker 描述的行为必须出现）或 `forbidden`（checker 描述的错误行为必须不出现） |
| `critical` | 布尔值；标记 case 级必要条件，至少一个 critical 的 required 探针 |
| `checker` | 已登记 checker id；至少一个非 semantic 的 required 确定性探针 |
| `questionType` | 已登记题型 id；表达这条探针考的是哪种认知或结构挑战 |
| `difficulty` | 1–5 的整数；只用于报告分层与覆盖观察，不改变通过判定 |
| `description` | 具体可判定的行为；不等于把 checker id 复述一遍 |
| `evidence` | 可选，指向 case 已登记的证据 id |

同一 checker 不得同时被要求与禁止；探针 id 在 case 内唯一。修改任何探针都会改变 `oracleHash` 和 `specHash`，旧批准随即 stale。

## 题型与评审权威

题型是独立的第二坐标，不替代 `categories`：`categories` 表示 case 触及哪些产品能力，`questionType` 表示这道题以什么方式挑战模型。共 7 个家族、24 个题型，完整定义以 `question-types.json` 为准：

| 家族 | 题型 | 主要覆盖能力 |
|---|---|---|
| 记忆 memory | `fact` 单跳事实、`multi-hop` 多跳、`temporal` 时间、`correction` 纠正、`forgetting` 遗忘、`source` 来源、`preference` 偏好、`scope` 作用域、`cross-session` 跨会话 | memory、chat、safety、session、persona |
| 对话 conversation | `multi-turn` 多轮、`open` 开放话题、`adversarial` 对抗/无答案、`long-context` 长上下文 | chat、context、humanizer、safety |
| 执行 execution | `execution` 执行型任务、`tooling` 工具与扩展、`configuration` 配置变更 | plan、tasks、tools、extensions、settings |
| 互动 interaction | `interaction` 主动互动、`session-lifecycle` 会话生命周期 | proactive、tasks、surface、session、context |
| 感知 perception | `observation` 静默观察、`multimodal` 图片输入 | observation、memory、chat |
| 边界 boundary | `boundary` 安全边界、`recovery` 错误恢复 | safety、tools、settings、resilience、tasks |
| 表达 expression | `persona` 人格与 Card、`style` 表达风格 | persona、humanizer、chat |

评审权威按 checker 计算，不按题型计算：

| 权威 | 判定者 | 适用范围 |
|---|---|---|
| `deterministic` | runner 的确定性检查 | `result` / `path` / `source` / `temporal` / `delivery` |
| `api-judge` | 可替换的异构 API judge | 非 humanizer 的 `semantic` |
| `human` | **用户本人** | 所有 `humanizer.*` 语义探针与拟人化质量 rubric |
| `coding-agent` | 仅作建议，不产生 pass/fail | 附在 human 权威后的风格辅助路线 |

- 一个题型可以横跨两种权威。例如 `style` 的 humanizer 探针是 human，`temporal` 的确定性探针是 deterministic；不要看题型猜权威。
- 含 `human` 探针的 case，`quality.authority` 必须是 `human`，并且 `assistants` 必须包含 `coding-agent`。coding agent 只输出建议，不得替用户批准、判 pass 或产生 gold。
- 自动化运行遇到 human 探针必须停在 `pending`，等用户本人审阅；API judge 不能代判拟人化。
- 新题型要先加到注册表并给出覆盖分类；注册表缺分类、题型重复、case 声明与探针不一致都会让 `dataset validate` 失败。

## fixture 纪律

- 初始数据与待测动作分开：可以 seed 旧印象，不能 seed 纠正结果后声称纠错成功。
- `direct-seed` 只预置初始会话、记忆和资源；纠正、自动抽取、跨会话召回必须由真实消息触发。`real-chain` 是另一类导入用例，不得和本 case 的初始状态混写。
- `fixed` 时钟只是声明；runner 尚未注入时间前，不得声称“过了几天”的定时或间隔行为已验证。
- 探针窗口限定 driver 步骤，fixture 预置的助手消息不进入 `last-assistant` 或 `all-assistant` 判定。
- 通过正常产品入口建立的事实保留真实提交消息与来源；直接 seed 的初始状态明确标记 fixture。
- 每个 trial 重建持久化身份、会话、任务、许可、消耗配额与时间域，不依赖前一 trial 的状态。
- 跨会话是一个 case 内有意设计的步骤，不是跨 case 污染。
- 时间推进区分真实时钟、可控测试时钟与手动触发；没有相应能力时不得伪造“经过一天”或“定时命中”。
- 困难度靠干扰信息、纠错、跨会话与组合条件形成，不靠藏关键词或复写产品规则。

## 制作流程

```text
用户意图／原始 ideal／已确认失败／类别组合
  → 起草 case、合成 fixture、写 driver
  → 逐条写 probes 与证据引用
  → dataset validate 自查格式、引用、重复与反例
  → 银标试跑（另用 runner；W3 已有隔离采集与封存，聊天驱动尚未实现）
  → 用户审阅并修改预期
  → 冻结 gold 版本
```

试跑只用于发现题目和工具问题，不迎合产品错误。产品答错不会自动放宽探针；题目有歧义时向用户提交具体分歧，由用户裁定。

## 命令

```bash
node scripts/desk-pet-chat.mjs dataset validate
node scripts/desk-pet-chat.mjs dataset list
node scripts/desk-pet-chat.mjs dataset types
node scripts/desk-pet-chat.mjs dataset review <caseId>
node scripts/desk-pet-chat.mjs dataset driver <caseId>
```

这些命令只读数据集，不启动 app、不调用模型。`validate` 输出套件数、用例数、探针数（关键数）、题型分布、评审权威与 gold／silver 数；`types` 按家族列出全部题型、覆盖分类和当前探针／用例计数；`review` 给人看完整候选、绑定哈希与旧审批差异；`driver` 只输出 `userRole` + `driver`，不含题型、探针、oracle、检查点、证据或评分。

## 审阅模式（用户看候选，代理只展示）

用户说「审阅评测用例」「看看待审 case」「审一下 <caseId>」时：

1. 先跑 `dataset list`，把 silver / pending 的 case 按套件列出。只有一条时也要先确认“要审的是这条吗”，不替用户决定。
2. 用户选定后跑 `dataset review <caseId>`，把输出**原样贴在聊天区**；至少能看到来源、fixture、题型与评审权威、驱动步骤、检查点、探针、证据、未解决点与 `specHash`。
3. 请用户按三类决定回复：**批准当前版本 / 修改具体条目 / 暂缓**。修改意见落到 case 或 fixture，改完提升 `revision`，重新展示新的 `specHash`。装载方式、难度分布与固定时钟也属于审阅内容；不只口头说“改好了”。
4. 保留用户原话、`caseId` 与 `specHash`，作为后续写入审批的候选来源。不要把“框架可以”“测试全绿”或代理判断当成用户批准，也不要代填 `reviewer`、`feedbackSource` 或 `decision`。
5. W1–W3 没有写审批文件的命令。用户在聊天里批准后，当前 case 仍是 silver / pending；不要手写 approval JSON。
6. 看过审阅包的代理不得再驱动同一个 case。驱动要换独立会话／代理，只读 `dataset driver`，避免探针与 oracle 视野污染。

## 金标与信任边界

- 没有审批、最近一次匹配审批为拒绝、或审批绑定旧版本，都是 silver。
- 批准记录绑定 `contentHash` / `fixtureHash` / `driverHash` / `oracleHash` 与聚合 `specHash`；任一变化都会让旧审批 stale。审批历史保留，不覆盖、不删除。
- 工具只校验结构和哈希，不证明审批人身份或消息真实存在；这一信任边界由真实审阅流程保证，报告不得夸大机械校验能力。
- 金标争议保留本次 actual、原判分与待裁决项；用户裁定后创建新规格／评分版本，不直接覆盖旧预期。
- 结构化探针的判定由 runner 调用可替换的异构 API judge；coding agent 只评聊天记录与自由定性结果，不代替 API judge 判定探针成败。
- `humanizer.*` 探针与拟人化质量 rubric 只由用户本人判定。coding agent 可以按同一 rubric 提供建议，但只能附在 `assistants` 里，不能产生 pass/fail、不能写审批、不能让 case 变成 gold。
