---
name: test
description: V1rtual-Desk-Pet 测试树的 Contract 分析、测试生成与覆盖审查流程。
---

# 测试工作流（/analyze /generate /audit）

三层职责、「该写在哪一层」的判定顺序、完整规则表、命令与报告位置以 [README.md](./README.md) 为权威。本文件只定义代码代理在源码变更后如何分析 Contract、生成测试与审查覆盖；它不是 shell 脚本。

**编号有两套，不要混**：本文件的 D1–D10 是**断言缺陷分类法**（`/generate` 与 `/audit` 的自查口径）；README「测试纪律」的 1–10 是**行为纪律**（机制可判与只能 review 两档）。两套编号各自引用，不互相对应。

## 触发词

- `/analyze test [module]`：从当前源码重新分析 Contract。
- `/generate test [module]`：按 Contract 补充或修订测试。
- `/audit test [--strict]`：审查 Contract 与测试的引用和覆盖质量。

## 先选层，再动手

判定顺序固定（与 README「该写在哪一层」同一份判据）：

1. **需要真 Rust 边界吗**（Bash 硬基线、许可内核、桌面能力、真实 IPC 差值）？→ **L4**：`test/e2e/scenes/` 里的 Scene，跑真 Tauri。
2. 不需要 → **需要真 JSONL 落盘与 agent loop 吗**？→ **L3**：`test/integration/` 的朴素 vitest + 临时数据根 + fake Provider。
3. 都不需要 → **L2**：`test/unit/` 的朴素 vitest，纯逻辑。

写错层的代价是可测的：L2 import 带 IPC 的模块、L3 使用真实 Provider，都被扫描器判违规（规则 6 / 7）；把确定性逻辑写进 L4，则每次验证都要开桌面等几分钟。

caseId 的锚定方式随层不同，但同一字母表：L2 / L3 写在 vitest 测试名末尾的 `[caseId]` 标记里（`test/host/caseids.ts` 的 `extractCaseId`；不在末尾、或不是小写 kebab-case 的方括号一律不被认作锚点），L4 写在 `meta.caseId`。没有标记时不从文件名或描述猜——猜出来的 caseId 会让契约校验拿一个并不存在的 id 去核对，产生假通过。

## `/analyze test [module]`

1. 确定受影响模块和跨模块调用链；读取当前 `contracts/{module}.contract.ts`、其 `sourceFiles` 与相关测试（L2/L3 的 vitest 文件与 L4 的 Scene）。
2. 分析当前公开行为、状态转换、持久化、取消/错误分支、边界值和平台差异。不要把计划文档中的 P6 或未接通能力写成已实现。
3. 更新 `sourceFiles`，使其覆盖行为实际所在的源码；覆盖点描述当前可验证行为，不以文件名替代行为。
4. 为每个 coverage point 设置唯一 id、`depth` 与 `scenarios`。`scenarios` 填已存在或将创建的 **caseId**（L2/L3 的写在测试名末尾的 `[caseId]` 标记里，L4 的写在 `meta.caseId`）；caseId 空间**跨层唯一**：同层重复由 `assertNoDuplicates` 在快层 reporter 里直接抛出（后者会静默压掉前者，旧的那条不再跑而报告照样全绿）；跨层重复与「声明了没人实现 / 实现了没声明」由全量 L4 收尾的跨层对账核对（`scripts/contract-layers.mjs`：unit / integration 读 `test/reports/caseids-*.json`，e2e 读本次报告；带过滤参数或 `--bench` / `--quality` / `--performance` 的运行跳过）。
5. 根据实际风险设置 `minScenarios`、`minDeepScenarios`、`requireBoundary`、`requireErrorPath`。前两项的口径是 **L4 场景集**：只数 e2e 层覆盖点落地的场景（unit / integration 点由快层校验器负责，不在这里计数），按「当前实际 L4 场景数」校准、不许再少；没有 e2e 层覆盖点的契约写 0。值偏大会让全量严格运行在跑任何场景之前直接中止（报告 `scenes: []`）。只有确实无法经运行时入口触达时才声明 `unitOnly`，并写明 `unitOnlyReason`。
6. 按项目的 source hash 计算方式刷新 `sourceHash`。不能只改 hash 而不完成前述行为审查。

## `/generate test [module]`

1. 读取目标 Contract、`sourceFiles` 和相关实现，确认每个 coverage point 的输入、输出、状态和副作用。
2. 先按上面的判定顺序选层，再落文件：L2 → `test/unit/<模块>/<主题>.test.ts`，L3 → `test/integration/<模块>/<主题>.test.ts`（都是朴素 vitest，测试名末尾带 `[caseId]`），L4 → 新建或修改 Scene（`meta.module` 必须等于 Contract module，`meta.contractId` 必须等于 coverage point id，`meta.caseId` 为全局稳定的小写 kebab-case）。L4 落笔前先核实两件事：宿主能力对等（依赖的初始化在 E2E 宿主里是否真实存在）与 repeat 隔离（setup 每 trial 重跑：持久化身份每 setup 全新、消耗型配额用独立记账域），判据见 README「Scene 规范」。
3. L4 选择入口：完整聊天产品路径使用 `production`；运行时适配层使用 `runtime`。**不再新增 `entry: "unit"` 场景** —— 纯确定性逻辑一律写 L2，存量 unit 场景按迁移批次处理。
4. 需要可重复模型输出时使用 fake Provider；它仍应经过真实运行时和工具链。需要验证真实模型能力时使用真实 Provider，并把模型不稳定性与产品失败区分开。
5. 断言用户可见结果之外的真实证据：工具调用状态、确认记录、会话事件、文件回读、变量状态、取消或错误结论。安全场景不执行破坏操作，只验证实际调用被受控拒绝。
6. Contract 要求边界或错误路径时，在对应 Scene 加 `boundary`、`error` tag；不要仅在描述文字中声称覆盖。
7. 失败路径以 `turns[].expectFailure` 声明预期失败（分类 + 失败正文匹配器），让本回合以声明的分类与文案失败才算通过；不要用「不写断言」或「允许任何失败」的方式放过失败 —— 预期之外的失败必须照旧判失败。
8. Scene 集合改变后更新 `dataset.ts` 的版本。
9. 写下每条断言后，走一遍下面的「生成时自查清单」。
10. 新场景 / 场景改动的验收不是过滤运行：交付前必须跑到**全量严格 ×3 全绿**（`pnpm run test:e2e -- --strict --repeat 3 --report json`）。`--module` / `--case` 过滤只用于迭代排查，会跳过跨层 caseId 对账与全量校验；不要把新场景留到发布门禁才第一次全量跑。

## 生成时自查清单（`/generate` 必过）

**第一问：把产品实现改坏，这条断言还红吗？** 不会红 = 断言无区分力，不构成测试。断言必须能区分正确实现与错误实现。

### 缺陷分类法（D1–D10，审计口径）

| 编号 | 名称 | 判据（一句话） |
|---|---|---|
| D1 | 恒真断言 | 假设产品实现被改坏，这条断言仍然不红 |
| D2 | 断言对象错位 | 断言的是测试自己构造的期望值或 fixture，不是产品产出 |
| D3 | 只测调用不测结果 | 检查了「发生了」，没检查「发生得对不对」 |
| D4 | 期望值抄实现 | 期望值照实现写出来，是同义反复，不构成约束 |
| D5 | 前提失效 | setup 构造的输入与产品当前真实形态不符（真跑会红，但不是产品问题） |
| D6 | 超宽匹配 | 子串／正则匹配过宽，错误实现也能通过 |
| D7 | 时序脆弱 | 固定 sleep／无界等待，慢机器假红 |
| D8 | 跨场景污染 | 依赖其他场景留下的全局状态 |
| D9 | 事后合理化 | 断言是「只要不抛错就算过」，与其声称覆盖的行为无关 |
| D10 | 重复或近重复 | 同一断言在多处重复，制造覆盖假象 |

**判定方法**：读断言 → 读它断言的产品源码 → 问「把产品实现改坏（条件反转／常数替换／分支删除），这条断言还会红吗？」不会红即命中。**不允许只读断言就下结论**，必须读到产品侧。

### 本仓已确认的例子（可直接复核）

- **D4 期望值抄实现**：`test/unit/memory/摘要分片规划.test.ts:362-371`（W2 从 `test/e2e/scenes/memory/摘要分片规划.scene.ts` 迁到 L2，原场景文件已删除）—— 原场景用 `formatStructuredSummary(parseStructuredSummary(同段脚本正文))` 当期望值，期望与实现共用同一条解析 + 格式化链路，`formatStructuredSummary` 退化成只回显则两边一起绿；迁移时按本分类修正，期望值改取场景脚本自写的正文（独立见证），`formatStructuredSummary(outcome.summary)` 只留作两个输出字段之间的同源核对。同形见 `test/e2e/scenes/memory/压缩分片.scene.ts:693-698`（`previousSummary` 的期望由 `formatStructuredSummary(parseStructuredSummary(...))` 现算）。兄弟形态见 `test/e2e/scenes/memory/阶梯投影.scene.ts:278-284` 的 `projectionLevelOf`：级 1 / 级 2 的期望形态由被测的 `projectToolResultText` 自身产出，场景只能再补一条独立判据（地址归属）才让判据成立。
- **D2 断言测试自己构造的值**：`confirm.approved` 由**测试宿主**的 `policy` 写入（`test/host/confirm-channel.ts:34` 的 `const approved = policy === "approve"`，默认 `deny`），产品碰不到这个字段。它只在显式走 approve 策略的用例里才有区分力 —— 现存 **3 处断言、2 个文件**：`test/unit/safety/确认放行.test.ts:40`（W3 从 `safety/确认通道.scene.ts` 的 `确认放行` 迁入 L2，`resetConfirmChannel("approve")` 是「声明 approve 即放行」这条声称的直接证据）、`test/e2e/scenes/safety/子代理授权范围.scene.ts:201,275`（`meta.confirmPolicy: "approve"` 在 `:313`）。默认 `deny` 下的 `approved` 恒为 false —— 看起来在断言「不该被放行」，实际恒不触发；这类子句 W2/W3 已按本条统一删除（`safety/危险拦截` 已迁 `test/integration/safety/危险拦截.test.ts`，`safety/凭据路径.scene.ts`、`safety/确认通道.scene.ts`、`safety/权限策略冻结.scene.ts`、`tool-execution/MCP大结果回读.scene.ts` 的原地删除都留了说明注释）。
- **D1 恒真断言**：`test/unit/tool-execution/Skill渐进加载.test.ts:103-105`（W2 从 `test/e2e/scenes/tool-execution/Skill渐进加载.scene.ts` 迁到 L2，原场景文件已删除）—— 原场景的 `block.length >= LONG_BODY.length` 永远不红（披露块上限 8192 字符（`src/services/skill/loader.ts:32` 的 `MAX_PROMPT_CHARS = 8 * 1024`），`LONG_BODY` 长 156,040 字符），子句恒假、守卫永不触发；迁移时删掉恒假子句，换成两段真断言：正文比整块预算长（独立前提）＋正文头/尾各 256 字符都不在披露块里。

### 硬禁止

- 禁止把被测函数的输出当期望值（D4）：期望值必须来自独立见证（常量、从需求推导的边界、产品之外的第二条链路）。
- 禁止断言测试自己构造的值（D2）：先问「这个值是谁写的」—— fixture、宿主策略或上一步断言的产物，都不能当产品断言。
- 禁止恒真子句（D1）：`.length >= 0`、同一对象字面量里 `requested: used` 这类，写下来就该能构造出使它为假的产品改动。
- `includes` 不是断言（D6）：产品在期望值之后追加任何内容都仍为真；子串匹配必须另配能钉住边界的判据。
- 10 条纪律（README「测试纪律」）对生成同样有效：可判项由 `scripts/check-test-rules.mjs` 扫描，命中即失败。

## `/audit test [--strict]`

1. 检查每个 Contract 的 `sourceFiles` 是否仍覆盖当前实现，并确认 `sourceHash` 与审查后的源码一致。
2. 检查每个 `coverage.scenarios` 是否是已发现的 caseId，且其 module/contractId 精确匹配。
3. 检查深度、边界、错误与非 unit 入口要求是否由真实测试 metadata 满足；审查 `unitOnly` 是否仍有充分理由。
4. 审阅断言是否真正观测目标状态或副作用，避免“回复非空”“未报错”之类无法证明能力的断言；逐条走 D1–D10 的判定方法（读断言 → 读产品源码 → 问「改坏产品它还红吗」）。
5. **迁移或搬运任何存量测试前**，先对目标逐条出审视结论（`照搬` / `修正后搬` / `删除`，后者写清为什么它不构成测试），并登记到契约的审视记录；不允许「先搬过去、以后再审」—— 搬过去的错误断言会立刻获得快层的可信度，之后再没有人回头看它。
6. 输出缺口、风险、建议补充的测试与尚不可验证的能力。严格审查时，任何 GAP 都不能报告为已通过。

## 当前 Contract 模块

当前目录包含以下 Contract：

- `chat-images`
- `humanizer`
- `observation`
- `proactive`
- `behavior`
- `evaluation`
- `agent-runtime`
- `harness-storage`
- `humanizer`
- `memory`
- `memory-bench`
- `personality-card`
- `planner`
- `safety`
- `tool-execution`
- `variable-pool`

新增模块时先新增 Contract 和至少一个关联测试（L2/L3 或 L4），再把它加入此列表；不因历史通过记录或计划阶段名称推断其已验证。
