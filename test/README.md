# Desk-Pet E2E 测试树（test/）

`test/` 是仓库唯一的测试根：三层测试、契约、宿主设施、场景与报告都在这一棵树下。L4 端到端（E2E）在独立 Tauri WebView 中执行真实前端服务、Rust IPC、临时数据根和 Agent/Tool 链路；测试数据不会写入正常用户数据根。L2 / L3 是不启动 Tauri 的快层（vitest · node）。

- 分层目标、波次与诚实边界：[测试分层重构契约](../docs/history/implementation/测试分层重构契约-2026-09-29基线.md)（已归档；未完成项见[未完成工作与已知缺口](../docs/plans/active/未完成工作与已知缺口.md)）
- 当前验证边界与未验证项：[测试边界](../docs/current/testing.md)
- 代码代理的 Contract 分析、生成与覆盖审查流程：[SKILL.md](./SKILL.md)

## 该写在哪一层

判定顺序固定，按问句走：

1. **需要真 Rust 边界吗**（Bash 硬基线、许可内核、桌面能力、真实 IPC 差值）？→ 写 **L4**（`test/e2e/`，要起 Tauri）。
2. 不需要 → **需要真 JSONL 落盘与 agent loop 吗**（Pi runtime 走真 loop、会话文件真写盘，模型由 fake Provider 替换）？→ 写 **L3**（`test/integration/`）。
3. 都不需要 → 写 **L2**（`test/unit/`）：纯逻辑、解析、注册表、边界值。

| 层 | 命令 | 运行环境 | 覆盖 | 说明 |
|---|---|---|---|---|
| L0 静态 | `test:types` | — | `vue-tsc` + `cargo check` | 现状保留，不替代运行时验证 |
| L1 Rust 单测 | `test:rust` | cargo | `src-tauri/src/**` 内联单测 | 现状保留 |
| L2 单元 | `test:unit` | vitest · node | 纯逻辑：变量池 / 解析 / 注册表 / 边界 | 新增 |
| L3 集成 | `test:integration` | vitest · node + 临时数据根 + fake Provider | Pi runtime 走真 loop、真 JSONL 落盘 | 新增 |
| L4 端到端 | `test:e2e` | Tauri WebView · 真 Rust IPC | 需真 Rust 边界的场景 | 本地 / 发布 |
| L5 发布门禁 | `test:release` | — | L0 + L1 + L2 + L3 + 严格 Contract 的 L4 | 现状保留并扩展 |

层的硬边界：

- L2 / L3 一律朴素 vitest（`describe` / `it` / `expect`）；`SceneDef` DSL 只留在 L4 —— 只有 L4 需要在非 Node 宿主里声明式地枚举并执行场景。
- **L2 不得 import `@/services/engine/pi`、`@/services/session`、`@/services/tool`**（规则 6，可判，扫描器执行）。
  **这条的理由是「L2 不依赖 pi runtime / 工具系统 / 会话存储」，不是「L2 里 IPC 跑不了」** —— Node 适配层（`test/host/node-ipc.ts`）本来就能等价复现 31 条 IPC 命令。判层的实操口径是「这份测试需要真 agent loop / 真 JSONL 落盘吗」，需要就归 L3。
  清单常量在 `scripts/check-test-rules.mjs` 的 `IPC_MODULES`。**往清单里加一条 = 把受影响的 L2 测试改判 L3**，改前先确认它们确实需要该模块，而不是为了消一个扫描告警。
- **L3 不得使用真实 Provider**（规则 7，可判，扫描器执行）。
- L4 的 `entry: "unit"` 是分层前留在宿主里的化石：新的纯逻辑测试一律写 L2，不再新增 unit 场景；该枚举值只剩少数撞上 Rust 专属命令 / WebView 能力、无法迁出的存量场景在用（见「Scene 规范（L4）」的表），最后一个消费者消失后再删除。
- L2 / L3 的 **caseId 锚在 vitest 测试全名末尾的 `[caseId]` 标记上**（`test/host/caseids.ts` 的 `extractCaseId`），例如 `it("拒绝未注册变量 [variable-pool-unregistered]", …)`。标记形状与 L4 的 caseId 校验同一字母表；没有标记时返回 `undefined`，不从文件名或描述猜。
- Node 适配层（`test/host/node-ipc.ts`）遇到 Rust 专属命令抛 `UnsupportedInNodeError`，不返回 null 冒充成功；撞上它的场景留在 L4。适配层即自动分层器 —— 归属由跑起来的结果决定，不靠猜。
- 证据强度分层：L2 / L3 与 L4 + fake Provider 是**确定性证据**（同输入同结果，红了必须定位到产品回归或测试错误之一）；L4 + 真实 Provider 是**观测性证据**（`pass^k < 1` 本身不构成回归结论）。报告分开统计，不得混算。

现状：L2（`test/unit/`）与 L3（`test/integration/`）都已可运行，并承载了 W1–W3 从 L4 逐批实测迁出的案例；L4 只留需要真 Rust 边界的场景。某层一个测试文件都没有时，vitest 会以「No test files found」非零退出 —— 那是空层信号，不是通过。

## 运行命令与过滤

在项目根目录执行。

```bash
# L2 + L3：每 PR 必过的那一组（不再指向 L4）
pnpm test

# 单层快层
pnpm run test:unit
pnpm run test:integration

# 波动重试入口（CI 门禁用的就是它）：首跑失败重试一次，重试才通过的标 ⚠ FLAKY；
# 本地也可以追加 vitest 过滤参数，如 node scripts/run-vitest-with-retry.mjs unit test/unit/variable-pool
node scripts/run-vitest-with-retry.mjs unit
node scripts/run-vitest-with-retry.mjs integration

# 快层过滤：追加 vitest 参数（文件路径，或 -t 按测试名）
pnpm run test:unit -- test/unit/variable-pool
pnpm run test:unit -- -t "拒绝未注册变量"

# L0 / L1（不替代运行时验证）
pnpm run test:types
pnpm run test:rust

# L4：全部 E2E 场景
pnpm run test:e2e

# L4 过滤：模块、稳定 caseId、场景名、tag 或 suite
pnpm run test:e2e -- --module memory
pnpm run test:e2e -- --case memory-compaction-checkpoint
pnpm run test:e2e -- --scene "压缩检查点"
pnpm run test:e2e -- --tag boundary
pnpm run test:e2e -- --suite safety

# 只校验 --module 选中的那一份 Contract（不替代跨模块或发布前全量门禁）
pnpm run test:e2e -- --module memory --contracts selected

# 严格 Contract 门禁与重复试验
pnpm run test:e2e -- --strict --repeat 3 --report json

# 生产入口 smoke 与发布门禁
pnpm run test:smoke
pnpm run test:release

# W7 缺陷注入观测（先记录观测值，不设阈值；不进每 PR 门禁）
pnpm run test:mutation
```

可组合的筛选参数为 `--module`、`--scene`、`--case`、`--tag`、`--suite`、`--repeat`、`--strict`、`--report`、`--contracts`。`--repeat` 范围为 1–20，且不会低于 Scene 的 `meta.repetitions`。`test:release` 执行类型检查、Rust 单测、L2 / L3 与严格三次 E2E 试验。

### 缺陷注入观测（`test:mutation`，W7）

`pnpm run test:mutation`（`scripts/mutate.mjs`）把 `test/mutation-baseline.json` 列出的目标源码逐个注入缺陷（四个算子：条件反转 / 边界值偏移 / 分支删除 / 返回常数，各取文件里第一个可注入点），每注入一条跑一遍快层（L2 + L3），最后打印两样东西：**命中率**（多少注入被快层判红，即「这套测试有牙齿」的比例）与**漏掉的注入清单**（哪条注入、注入在哪个文件的哪一行、改成了什么）—— 漏掉的那几条就是测试没有区分力的具体位置。注入在同一进程内还原，运行前后 `git status --short src/` 应保持为空。`node scripts/mutate.mjs --dry-run` 只打印注入点（含被代码区掩码收窄的记录），不跑测试。

读法与边界：

- **当前只有 2 个目标文件**（`src/services/personality/variable-pool.ts`、`src/services/context/budget.ts`）。首轮观测为 **5/7 = 71.4%** —— 这是这两个文件上的数字，**不代表快层整体命中率**；扩大目标面后才更新。
- 结果先作为**观测**记录，**不设阈值**，不进每 PR 门禁；稳定后再按只缩不放的棘轮设阈值。
- 口径与已知收窄（语法解析不过的注入不计入分母、算子只在代码区匹配等）见[测试分层重构契约](../docs/history/implementation/测试分层重构契约-2026-09-29基线.md) 的「首轮观测」一节。

L2 / L3 可并行、不占端口；**L4 不能并行跑**（占用同一 Vite/Tauri 端口），也不要与 `pnpm tauri dev` 的开发实例同时运行。

**环境注意**：macOS 锁屏时 WebKit 会把窗口判为遮挡并挂起页面 JS（实测每个 scene 约 6 秒后整体停摆，进程存活但无进展）。跑 E2E 门禁前必须解锁屏幕并保持点亮；`always_on_top` / `caffeinate` 无效。

## 测试纪律（10 条规则）

「不乱写测试」不能只写在文档里。规则分两档：**机制可判**的进 CI，**只能靠 review** 的进 SKILL 与 README，并如实标注哪一档。

| # | 规则 | 档位 |
|---|---|---|
| 1 | 断言必须观察真实证据：工具调用状态、持久化回读、确认记录、变量状态、文件回读。禁止用「回复非空」「未报错」代替 | review |
| 2 | 禁止 change-detector 测试（因为「期望改变的数据」而失败） | review |
| 3 | 禁止在测试里读源码文本并断言其内容 | 可判 |
| 4 | 禁止手写 `throw new Error` 充当断言；用 `expect` | 可判 |
| 5 | 禁止无断言的 `it` 块 | 可判 |
| 6 | L2 单元层不得 import 带 IPC 的模块 | 可判 |
| 7 | L3 集成层不得使用真实 Provider | 可判 |
| 8 | 跳过与超时不得计为通过 | 机制已保证 |
| 9 | 新增用户可见行为必须先在本层契约加 coverage point 与 caseId | 机制已保证 |
| 10 | 预期失败用显式声明，不得用「不写断言」或「允许任何失败」放过 | 机制已保证 |

可判项由 `scripts/check-test-rules.mjs` 扫描 `test/` 实施，命中即失败。它是守卫，因此**守卫自身要有测试**（照 hermes 的做法：断言「访问真实网络／真实 Provider 会抛错」这类守卫真的生效，而不是假定生效）。

规则落位：本文件持完整规则表；`SKILL.md` 写生成测试时的硬约束与禁令；`AGENTS.md` 的测试段落指三层入口与扫描器。生成时的自查清单（D1–D10 缺陷分类法与本仓已确认的例子）在 [SKILL.md](./SKILL.md)。

## 波动与假绿（FLAKY）

纪律 8「跳过与超时不得计为通过」在快层由入口脚本机械保证，不靠自觉：

- **重试一次**：CI 门禁经 `scripts/run-vitest-with-retry.mjs unit|integration` 运行。首跑失败会原样重试一次：重试仍失败 = 真失败（退出码 1）；首跑以非零退出却没有可归因的失败用例（进程级 / 收集器错误）同样判失败 —— 这类失败没有名字可进棘轮，静默放行等于让它下次以同样方式消失。
- **重试才通过的测试标 `⚠ FLAKY`**，并**累计**写进 `test/reports/flaky.json`（`test/reports/` 已 gitignore）。恢复的唯一判据是重试运行里 `status === "passed"`：**被跳过（skipped / pending / todo）或被超时判失败的用例不算恢复**，重试逻辑不会把任何非通过洗成通过。
- **只缩不放的棘轮**：`test/flaky-baseline.json`（提交进仓库）是已接受清单；`node scripts/check-flaky-ratchet.mjs` 在 CI 里拦截「观测到基线之外的新 FLAKY」。新增项要么把波动修掉，要么在下一次提交里显式写进基线（把 `flaky.json` 里的条目抄进基线对象即可，值保留累计次数）—— 不允许「标了 FLAKY 就没人管」。基线条目在不再复现后可随下一次提交回收（脚本会提示，不判失败）。
- 重试只包 L2 / L3：L4 的重复试验与预期失败走它自己的 `--repeat` 与 `expectFailure` 机制。

## 报告在哪、怎么看

- **终端**：默认 `--report terminal`，全局结论与逐 case 结果直接打在运行终端；`--report markdown` 是终端文本的 markdown 版。
- **文件**：浏览器侧把结果经 `e2e_complete` 交给 Rust，写入数据根的 `e2e-result.txt`（首行 `PASS` / `FAIL`，也是启动脚本判断进程退出码的依据）；启动脚本在清理临时数据根之前把它复制进仓库内的 `test/reports/`（已在 `.gitignore` 排除），文件名是 ISO 时间戳。`--report` 决定副本的扩展名：`json`→`.json`、`html`→`.html`、其余（terminal / markdown）→`.txt`。保留策略按**体积**：按 mtime 从新到旧累加，超过 200 MB 即淘汰更旧的，最新一份始终保留。
- **报告内容**：`desk-pet-live/v2` 结构，包含数据集版本、筛选项、trial 指标、错误分类与 `pass@k` / `pass^k`。前者表示至少一次试验通过，后者表示全部已执行试验通过；回归或发布结论使用后者及严格 Contract 结果。`environment.seedHash` 由启动脚本生成：覆盖 `src-tauri/resources/defaults` 下的文本种子与开发构建实际加载的 CONFIG，凭据按 key 名脱敏后不参与摘要，二进制素材与摘要无关。
- **宿主窗口**：`test-e2e.html` 提供**实时进度** —— 顶部 sticky 汇总条（已跑 / 通过 / 失败 / 预期失败 / 剩余 / 耗时），逐 case 一行；**失败行立即展开**，内含断言差异与该场景的事件序列。汇总条常驻显示报告的绝对路径与「打开结果目录」入口。
  **窗口不驻留**：`e2e_complete` 后 Rust 直接 `app.exit(0)` 关窗，结束横幅实际可见时间极短 —— 这也是报告路径与打开入口被做成**运行期常驻**而非只在结束时出现的原因。要让它结束后长驻需改结果协议（Rust + 启动器），不在当前范围。
- **别拿文件名当证据**：归档文档引用报告时写可核对标识（runId / commit / dataset 版本 / cases 与 trials 计数），不写文件名 —— 报告目录的保留策略会淘汰旧文件，按路径引用会悬空。

## Contract 与 sourceHash

`contracts/*.contract.ts` 是模块行为契约。每个 coverage point 的 `scenarios` 必须写场景的稳定 **`caseId`**，不是文件名、描述或导出名。每个 caseId 只能归属一个场景，且场景的 `meta.module`、`meta.contractId` 必须与其 Contract coverage point 一致。

Node 启动预检会校验 `sourceHash`；源码变更后应先按 SKILL 重新分析 Contract，再更新 hash 和场景。不要只替换 hash 来绕过门禁。`--strict` 还会拒绝 coverage、深度、边界、错误或入口规则的缺口。

浏览器侧不做也不假装做独立校验：预检通过时把「模块 → sourceHash」的证明交给运行中的测试窗口，契约声明与证明不一致、或根本没有证明（例如绕过启动脚本直接开 Tauri）时该 Contract 记为 `stale`，严格模式据此失败。

`sourceHash` 只覆盖 Contract 声明的 `sourceFiles`，不是依赖闭包；两者的差异清单与是否收紧门禁见[未完成工作与已知缺口](../docs/plans/active/未完成工作与已知缺口.md) 的「不修/暂不修边界」小节。

分层**不会**缩小「改一个共享文件判多个契约 STALE」的爆炸半径；真正的改善是检查变便宜（从「开桌面等几分钟」变成「几秒重跑」）。

## Scene 规范（L4）

每个 Scene 声明稳定的小写 kebab-case `caseId`、`module`、`contractId`、`suite` 和 `depth`。`suite` 取值为 `regression`、`capability`、`safety` 或 `stress`；需要满足 Contract 的边界/错误规则时，分别带 `boundary` / `error` tag。

入口按要验证的边界选择：

| `entry` | 执行内容 | 适用场景 |
| --- | --- | --- |
| `production` | 经过 `sendMessage()` 的真实聊天入口 | 验证预处理、队列、会话/UI 消息与完整产品链路 |
| `runtime` | 直接调用 Pi runtime，并镜像必要的会话消息生命周期 | 验证 Agent、上下文、工具、持久化等运行时适配 |
| `unit` | 不调用模型，只运行进程内断言 | 只在无法迁出的存量场景上残留 —— 现为 5 个：`图片读取处理`、`执行许可`、`工具超时判定`、`窗口信息三态`、`凭据路径` 的 Rust 终判（都撞 Rust 专属命令 / WebView 能力，`窗口信息三态` 另依赖 Live 宿主没有的窗口监听初始化）；**新增纯逻辑测试一律写 L2**。枚举值暂不删除，因为上述场景仍占着它 |

`runtime` 与 `production` 可使用真实 Provider，也可由场景安装 fake Provider：fake Provider 只替换模型响应，保留真实 Agent/Tool 执行路径；是否发生工具调用或 Rust IPC 由具体 Scene 的断言证明。`unit` 不证明模型、Provider 或桌面入口行为；非 `unitOnly` Contract 至少保留一个非 unit Scene。

场景断言应观察实际结果：工具要断言具体调用与状态，持久化要回读临时数据根，安全场景要区分“未调用”和“调用后被拒绝”。不要只以回复非空代替状态或副作用验证。

要验证「本回合以某类失败结束」时用 `turns[].expectFailure` 声明，而不是删掉断言：`kind` 必须命中 `output.failure.kind`（允许声明一组），`message` 是失败正文的匹配器（字符串按子串、正则按 `test`，空匹配器在数据集校验时被拒绝），两者都命中才算预期失败，回合的其余断言照常执行。回合正常完成、以别的分类失败或文案不匹配都判失败 —— 它只覆盖 `output.failure`，回合抛出异常仍是系统错误。报告把这类回合标为 `expected failure`（errorKind 照常记录真实分类）。

测试宿主没有 ChatPanel：应用启动时由 UI 壳完成的服务级初始化由 `standard-setup.ts` 补齐 —— slash 命令注册表也在其中（应用里它挂在 ChatPanel 的模块副作用上；宿主不补的话 `/compact`、`/clear` 会按「未注册的 slash 文本透传 AI」，被当成普通回合发给模型）。涉及确认请求的 Scene 用 `meta.confirmPolicy` 声明 `deny`（默认）或 `approve`，由 `confirm-channel.ts` 确定性应答；涉及计划确认或逐步门的 Scene 用 `meta.planPolicy` 声明 `auto`、`stepByStep` 或 `deny`（默认），由 `plan-confirm-channel.ts` 确定性应答（`deny` 下确认按用户取消、门按中止结算）。计划通道同时把本场景的确认、进度与终态事件记成可读记录：确认经 `AssertContext.plans`（`plan-confirm-channel.ts` 的 `planRecords()`），进度与终态查 `planProgressRecords()` / `planEndRecords()`（事件回环是异步投递，断言按状态有界等待）；这些记录每个场景在隔离点清空。

## 隔离、超时与失败

每个 trial 在 `standard-setup.ts` 中取消并等待已登记 Agent 回合，然后重置会话文件、UI index、工作记忆、变量池、聊天状态、预处理与 AI 锁。超时按固定顺序收尾：置取消位（框架在每个步骤边界停下，不再推进后续 setup 与断言）→ 取现场 → 取消已登记的 Agent 回合 → 最多等 `SCENE_CANCEL_GRACE_MS` 让被放弃的执行落地，没落地会写进超时 error。超时报告保留已完成轮次和在飞轮次已跑完的断言，并补一条失败的 `timeout` 断言；`status` 仍是 `timeout`，不进通过统计。

取消是协作式的：JS 不能强杀任意 await，Scene 自己发起、不经过框架边界的等待只能靠上述宽限时间收尾。Provider、网络、认证和断言等错误会分类，兜底回复不把失败改写为成功。

E2E 启动脚本在用户 Home 下创建 `.deskpet-e2e-*` 临时数据根，退出时删除；删除前把结果文件复制到仓库内的 `test/reports/`（保留策略见「报告在哪、怎么看」）。

## 目录职责

```text
test/
├── README.md             # 分层入口、规则表、命令、报告与 L4 Scene 规范（本文件）
├── SKILL.md              # Contract 分析、测试生成与覆盖审查流程（/analyze /generate /audit）
├── contracts/            # 模块行为契约与 sourceHash（跨层）
├── host/                 # 宿主与共享设施（L2–L4）：状态隔离、确认通道、断言辅助、契约校验、
│   │                     #   caseId 收集、Node IPC 适配层
│   └── shims/            # node:assert/strict 的别名目标（浏览器构建必需，无本仓源码消费者）
├── unit/                 # L2：朴素 vitest，纯逻辑
├── integration/          # L3：朴素 vitest + 临时数据根 + fake Provider
└── e2e/                  # L4：宿主入口 e2e-main 与执行器 scene-runner / dataset / reporter / cli，
                          #   以及 scenes/ 下的场景
```
