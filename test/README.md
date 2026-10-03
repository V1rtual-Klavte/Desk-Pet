# V1rtual-Desk-Pet E2E 测试树（test/）

`test/` 是仓库唯一的测试根：三层测试、契约、宿主设施、场景与报告都在这一棵树下。L4 端到端（E2E）在独立 Tauri WebView 中执行真实前端服务、Rust IPC、临时数据根和 Agent/Tool 链路；测试数据不会写入正常用户数据根。L2 / L3 是不启动 Tauri 的快层（vitest · node）。

## 快速开始

macOS 14+ 测试窗口显式关闭 WebKit 后台挂起；其他系统若遇无进展，先恢复窗口可见状态并检查 trace 边界。系统整体睡眠仍会暂停执行。

```bash
pnpm test                              # 快层 L2 + L3，几秒，每 PR 必过的那一组
pnpm run test:e2e                      # 全量端到端，约 5 分钟；窗口里有实时进度
pnpm run test:e2e -- --module memory   # 只跑一个模块
pnpm run test:e2e -- --report html     # 顺便出一份可双击打开的 HTML
pnpm run test:mutation                 # 缺陷注入观测（先记录，不设阈值）
```

结果：**终端**给结论，**窗口**给实时进度，**报告**落在 `test/reports/`。

下面的章节是架构理由、分层判定与规则表 —— 只想跑测试的话到这里就够了。

- 测试域规则入口与维护义务（改了什么同步什么）：[AGENTS.md](./AGENTS.md)
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
| L5 发布门禁 | `test:release` | — | L0 + 纪律扫描 / FLAKY 棘轮 + L1 + L2 / L3（重试入口） + 严格 Contract 的 L4 | 与 CI 同源 |

层的硬边界：

- L2 / L3 一律朴素 vitest（`describe` / `it` / `expect`）；`SceneDef` DSL 只留在 L4 —— 只有 L4 需要在非 Node 宿主里声明式地枚举并执行场景。
- **L2 不得 import `@/services/engine/harness`、`@/services/session`、`@/services/tool`**（规则 6，可判，扫描器执行）。
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

可组合的筛选参数为 `--module`、`--scene`、`--case`、`--tag`、`--suite`、`--repeat`、`--strict`、`--report`、`--contracts`。`--repeat` 范围为 1–20，且不会低于 Scene 的 `meta.repetitions`。`test:release` 与 CI 同源：类型检查、纪律扫描与 FLAKY 棘轮、Rust 单测、经重试入口（`run-vitest-with-retry.mjs`）的 L2 / L3 与严格三次 E2E 试验；它也是唯一跑严格 Contract + 3 trials 的 L4 门禁（L4 不进 CI）。

### 缺陷注入观测（`test:mutation`，W7）

`pnpm run test:mutation`（`scripts/mutate.mjs`）把 `test/mutation-baseline.json` 列出的目标源码逐个注入缺陷（四个算子：条件反转 / 边界值偏移 / 分支删除 / 返回常数，各取文件里第一个可注入点），每注入一条跑一遍快层（L2 + L3），最后打印两样东西：**命中率**（多少注入被快层判红，即「这套测试有牙齿」的比例）与**漏掉的注入清单**（哪条注入、注入在哪个文件的哪一行、改成了什么）—— 漏掉的那几条就是测试没有区分力的具体位置。注入在同一进程内还原，运行前后 `git status --short src/` 应保持为空。`node scripts/mutate.mjs --dry-run` 只打印注入点（含被代码区掩码收窄的记录），不跑测试。

读法与边界：

- **当前有 3 个目标文件**：`variable-pool.ts`、`context/budget.ts` 与 `agent/memory/rerank.ts`。记忆重排解析已进入缺陷注入范围；历史 5/7 仅代表原两个文件，不能作为扩大目标后的结果。
- 结果先作为**观测**记录，**不设阈值**，不进每 PR 门禁；稳定后再按只缩不放的棘轮设阈值。
- 口径与已知收窄（语法解析不过的注入不计入分母、算子只在代码区匹配等）见[测试分层重构契约](../docs/history/implementation/测试分层重构契约-2026-09-29基线.md) 的「首轮观测」一节。

L2 / L3 可并行、不占端口；**L4 不能并行跑**（占用同一 Vite/Tauri 端口），也不要与 `pnpm tauri dev` 的开发实例同时运行。

**环境注意**：WebKit 默认会在锁屏或窗口不可见时挂起 JS。测试宿主现通过 Tauri 的 `BackgroundThrottlingPolicy::Disabled` 关闭 macOS 14+ 的后台挂起；只作用于 E2E 窗口，产品窗口保留资源策略。本机锁屏短批已有真实 trace 证据，其他系统与整机睡眠不得据此推断可持续运行；`always_on_top` / `caffeinate` 不能代替 WebView 调度策略。

**判据**：进程存活但 trace 边界与日志长时间不推进时，结合窗口可见性、锁屏状态、CPU 和当前 await 排查，不把低 CPU 单独当作挂起结论。中断运行先保留部分证据，再重新采集；未完整执行不能报通过。

窗口本身已经做了两层防护：E2E 时 macOS 的 `ActivationPolicy` 用 `Regular`（出现在 Dock 与 Cmd+Tab，随时能唤回；产品运行仍是 `Accessory` 不占 Dock），并且窗口**禁止最小化**。

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

规则落位：本文件持完整规则表；`SKILL.md` 写生成测试时的硬约束与禁令；[AGENTS.md](./AGENTS.md) 是测试域规则入口与维护义务表（改了什么必须同步哪份文档）。生成时的自查清单（D1–D10 缺陷分类法与本仓已确认的例子）在 [SKILL.md](./SKILL.md)。

## 波动与假绿（FLAKY）

纪律 8「跳过与超时不得计为通过」在快层由入口脚本机械保证，不靠自觉：

- **重试一次**：CI 门禁经 `scripts/run-vitest-with-retry.mjs unit|integration` 运行。首跑失败会原样重试一次：重试仍失败 = 真失败（退出码 1）；首跑以非零退出却没有可归因的失败用例（进程级 / 收集器错误）同样判失败 —— 这类失败没有名字可进棘轮，静默放行等于让它下次以同样方式消失。
- **重试才通过的测试标 `⚠ FLAKY`**，并**累计**写进 `test/reports/flaky.json`（`test/reports/` 已 gitignore）。恢复的唯一判据是重试运行里 `status === "passed"`：**被跳过（skipped / pending / todo）或被超时判失败的用例不算恢复**，重试逻辑不会把任何非通过洗成通过。
- **只缩不放的棘轮**：`test/flaky-baseline.json`（提交进仓库）是已接受清单；`node scripts/check-flaky-ratchet.mjs` 在 CI 里拦截「观测到基线之外的新 FLAKY」。新增项要么把波动修掉，要么在下一次提交里显式写进基线（把 `flaky.json` 里的条目抄进基线对象即可，值保留累计次数）—— 不允许「标了 FLAKY 就没人管」。基线条目在不再复现后可随下一次提交回收（脚本会提示，不判失败）。
- 重试只包 L2 / L3：L4 的重复试验与预期失败走它自己的 `--repeat` 与 `expectFailure` 机制。

## 报告在哪、怎么看

- **终端**：默认 `--report terminal`，全局结论与逐 case 结果直接打在运行终端；`--report markdown` 是终端文本的 markdown 版。
- **文件**：浏览器侧把结果经 `e2e_complete` 交给 Rust，写入数据根的 `e2e-result.txt`（首行 `PASS` / `FAIL`，也是启动脚本判断进程退出码的依据）；启动脚本在清理临时数据根之前把它复制进仓库内的 `test/reports/`（已在 `.gitignore` 排除），文件名是 ISO 时间戳。`--report` 决定副本的扩展名：`json`→`.json`、`html`→`.html`、其余（terminal / markdown）→`.txt`。保留最近 **5 份**日期戳报告，累计体积上限 **200 MiB**，最新一份始终保留；日期戳报告的审阅/评分包（`<报告名>.review.json`、`<报告名>.scored.json`）与父报告算**同一保留单元**：字节计入 200 MiB、组内最新时间作为排序时间、父报告被淘汰时一并删除，父报告已不在的孤儿包在下一次淘汰时清除；`caseids-*.json`（全量 L4 收尾的跨层对账输入）与 `flaky.json` 不参与淘汰。
  **临时数据根也在 `test/.tmp/e2e-<随机>/`** —— 它承载整个 data_root（sessions / logs / personality / …），跑完即删；启动时残留根按 `.pid` 判主人：`process.kill(pid, 0)` 仍存活（或 EPERM）说明另一个 L4 正在跑，直接拒绝启动并指名 pid 与根名（并发第二个 L4 不会再把在跑者的数据根当残留删掉）；无主（无 `.pid` 或进程已死）才抢救残留 trace（含未结束场景与半行）再清理，抢救失败保留该根留待人工处理、不中断启动。`test/.tmp/memory-perf-*` 残留在性能脚本下次启动时回收（前缀匹配 + 目录年龄 ≥3 小时 + 无存活 pid）；清扫只针对已知前缀的运行根，不碰人工放置的输入（如 `proactive-calendar/`），无归属的人工临时文件属可弃物、不设自动清理。**测试产物一律在 `test/` 下，不落仓库外。**
- **报告内容**：`desk-pet-live/v2` 结构，包含数据集版本、筛选项、trial 指标、错误分类与 `pass@k` / `pass^k`。前者表示至少一次试验通过，后者表示全部已执行试验通过；回归或发布结论使用后者及严格 Contract 结果。`environment.seedHash` 由启动脚本生成：覆盖 `src-tauri/resources/defaults` 下的文本种子与开发构建实际加载的 CONFIG，凭据按 key 名脱敏后不参与摘要，二进制素材与摘要无关。
- **宿主窗口**：`test-e2e.html` 提供**实时进度** —— 顶部 sticky 汇总条（已跑 / 通过 / 失败 / 预期失败 / 剩余 / 耗时），逐 case 一行；**失败行立即展开**，内含断言差异与该场景的事件序列。汇总条常驻显示报告的绝对路径与「打开结果目录」入口。
  **该页由 dev server 提供，不在 Vite `build.rollupOptions.input` 里**：L4 全程走 `tauri dev` 的 `devUrl`，Vite dev server 服务根目录下所有 HTML，加进 build input 只会把它打进发布产物（463 KB）—— release 下 `lib.rs` 的 `cfg!(debug_assertions) && is_e2e()` 恒假，e2e 窗口永不创建，那些字节一个都加载不到。历史契约里的「补进 build input」是误判，不要照抄。
  **窗口不驻留**：`e2e_complete` 后 Rust 直接 `app.exit(0)` 关窗，结束横幅实际可见时间极短 —— 这也是报告路径与打开入口被做成**运行期常驻**而非只在结束时出现的原因。要让它结束后长驻需改结果协议（Rust + 启动器），不在当前范围。
- **别拿文件名当证据**：归档文档引用报告时写可核对标识（runId / commit / dataset 版本 / cases 与 trials 计数），不写文件名 —— 报告目录的保留策略会淘汰旧文件，按路径引用会悬空。报告与 trace 是两条独立保留链，同一 stamp 一般成对存亡但允许单侧先淘汰（无 trace 运行、启动救援组、性能子运行都会让两侧计数漂移），引用一律以标识为准。

## Trace、记忆质量与性能门禁

**测试侧模型配置**：被测模型默认继承仓库 Provider 配置（启动器拷贝隔离副本，凭据不被写回）；显式覆盖分两层——[test/eval-models.json](eval-models.json)（进 git，**不得含 apiKey**，出现即显式报错）与本地专属 `test/eval-models.local.json`（已 gitignore、不进 git，可含 `underTest.apiKey` / `underTest.endpoint` / `underTest.reviewMaxTokens`（reasoning 模型的评审输出上限）等字段）。解析优先级：环境变量 `DESKPET_EVAL_PROVIDER` / `DESKPET_EVAL_MODEL` / `DESKPET_EVAL_JUDGE_MODEL` > 本地文件 > 进 git 文件 > 内置默认；bench 的 `--bench-judge-model` 参数仍最高。`underTest` 覆盖经 `setOverrides` 只写隔离副本（含 endpoint / apiKey）；judge 继承测试侧网关的 endpoint / apiKey，只换模型。**judge 必须不同于被测模型**（同模型在开跑前报错）。

```bash
pnpm run test:e2e -- --module evaluation --repeat 3 --report json
pnpm run test:trace-review -- <你的理想稿> <实际.trace.jsonl> <manifest.json> <AI审阅.json>
pnpm run test:memory-quality                            # 80题 × 3trial，真实Provider；会消耗token
pnpm run test:memory-quality -- --case mq-address-preference-01           # 定向采集，不能代替完整质量验收
pnpm run test:memory-quality-review -- prepare --report <采集报告.json>
pnpm run test:memory-quality-review -- apply --report <采集报告.json> --review <审阅.json>
pnpm run test:memory-bench:prepare                      # 外部记忆基准安装（锁定版本 → data-dir；数据集不进 git）
pnpm run test:memory-bench:smoke                        # 分层命令 smoke / regression / zh / difficulty / external：见 memory-bench/README §8
pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-limit 5  # 任意参数观测运行；不进 CI / test:release
pnpm run test:memory-performance                        # release存储 + debug IPC；off/light/full
pnpm run test:memory-performance -- --native-only
```

**线路理想稿只由用户编写**，可用任意 UTF-8 文本表达；仓库不生成、不复制实际 trace 作为理想稿，也不要求理想稿遵守固定事件语法。后续 AI 阅读理想稿、manifest 与实际 trace，另交审阅 JSON。门禁只核对证据完整性、文件哈希和审阅覆盖，不冒充语义理解：缺理想稿/审阅为 `pending`，文件变化、缺 trial、丢事件或未完成为 `inconclusive`，两者退出码 2；审阅结论失败退出 1，完整且结论通过才退出 0。自动修复代理应先读差异和证据，再修改产品、重跑采集与重新审阅；旧审阅不能批准新产物。理想稿建议放在 [`test/ideal-traces/`](ideal-traces/README.md)（编写指引、工作流与审阅 JSON 字段表见该目录 README）。

审阅记录包含 `idealSha256 / actualSha256 / manifestSha256`、`verdict`、`reviewedTrials`、`differences`、`evidence`、`reviewedOrphans`。每个 trial 都须有实际引用：事件 `{chunkId,eventSeq,sceneId,trialId}`，或合法静默线路的边界 `{chunkId,boundaryKind,sceneId,trialId}`；孤儿事件须逐条明确审阅。失败必须写差异，通过必须无差异。哈希只证明审阅绑定这份产物，不证明 AI 判断正确。

Trace 默认 `full`；`light` 省略 payload/snapshot 事件，`off` 只用于性能对照，不能通过线路完整性门禁。事件保留宿主/Pi 的运行映射、request/turn/tool/entry/span 身份、单调序号和时钟域。`message_end` 与真实 `entry_added` 提交分开；首文本生成、流事件投递与实际 UI 显示不同口径，当前宿主不测 ChatPanel 首显。只采结构、数量和已有审计 hash，正文与工具参数/结果不落 trace。

宿主缓冲有事件数和字节上限，周期与场景边界都落盘；只有 Rust fsync 后的 ACK 才释放待写块。每行是 `{chunk,contentSha256}`，chunk 内有边界、丢弃计数与逐事件 scene/trial；按事件的 sceneId 读取线路，不能把一个物理 chunk 当作只有一个场景。未匹配的迟到事件保留为 orphan。启动器在清理前流式核对 hash、序号、所有预先声明的 trial 和 complete 边界；丢弃/写盘失败不洗成通过。`test/reports/traces/` 按 trace、manifest、逐 cell 质量 / 外部基准 checkpoint（成员名 `.quality.jsonl` / `.memory-bench.jsonl`）与完整性 sidecar 整组保留最近 5 份且累计不超过 200 MiB（组键覆盖未完成写入的 `.manifest.json.pending` 残片），超过单组限制保留源临时根并失败。正常路径的 bundle 不再包含结果副本（根报告已是同一份字节）；只有中断抢救（`salvageTempTrace`）还带 `result.*` —— 中断时它是唯一留存。

**记忆质量**复用 Live Test、真实 `sendMessage` 与 Rust IPC；不引入通用 eval 框架。80 题是 AI 起草的待审标注集，双人独立审计和 judge 校准未完成前不能通过质量门禁。覆盖称呼/偏好、经历/时效、纠正、遗忘及来源/scope 反例；真实 dreaming 提取单独采集。Provider长度截断等已观测模型输出失败保留为失败cell，继续其他对照；三次连续基础设施失败才中止。失败cell不能判质量通过。对照为无记忆、本地、每次重排、adaptive、gold evidence，每题至少三次随机配对试验。所有质量cell统一撤下模型工具并在结束后恢复，防止无记忆组通过memory_query、文件读取或Bash获取fixture；fixture/治理操作仍走真实Rust IPC。此专项比较MemoryProvider投影，不代表工具搜索能力评测。每个 cell 取消旧运行、清会话、通过受守卫的 Rust 评测命令关闭并重建同一所有者的 SQLite 库；记录 store generation 和规范化 fixture 指纹，禁止沿用上一策略的治理状态。各 cell 共用一次隔离宿主数据根，数据库实例和会话逐 cell 新建，不宣称每个 cell 都启动独立进程。

报告保留原始 outcome、回答与提取候选（仅合成测试材料），完整事件只在 trace sidecar 保存，避免在报告和每 cell checkpoint 重复整份 trace。提取结果分别记录 `processedSourceCount`（已完成处理）和 `pendingSourceCount`（作业剩余来源），不把完成后的空队列解释为没有提取输入。选择指标取最后真正送进请求的 `memory_recall_rendered` 证据；候选报告每 scope 的 Recall@50 与合并池 recall，不把最多 150 条的合并池擅自截前 50。所有模型请求按 span 去重计 token；总输入包含 Pi 分列的缓存 token，另报未缓存输入和缓存计数。零初始化 usage 视为缺失；Pi 默认缓存零值不证明未命中，没有可证实的计数时为未知。额外 token 与首文本延迟按相同 case/trial 相对本地策略配对；正确率收益按题目聚合三次 trial 后 bootstrap 95% 区间，避免把重复 trial 当独立题目。未审阅的提取语义指标为未知。gold 标注须由两名人工完整审计；回答/提取评分可由经人工校准且不同于被测模型的 AI judge 或人工 judge 盲审。语义评分必须绑定 dataset 与完整采集报告 hash 提交（报告 hash 已覆盖 outcomes），不能让被测模型自评。门槛见[未完成总表 §3.2](../docs/plans/active/未完成工作与已知缺口.md#32-尚未完成的验收口径)。定向采集不能宣布全套 80 题验收通过；采集成功但尚未审阅会输出 `pending_review` 并非零退出。

**外部记忆基准（memory-bench）**是观测层，与自建 80 题物理隔离：数据、运行、判分、门禁四处分开，**不进 CI / `test:release`、默认不跑**。三个开源集（LongMemEval / LoCoMo / MemoryBank cn）的数据集文件**不进仓库**——仓库只保留版本锁（`test/memory-bench/upstream-lock.json` 的固定 revision + SHA-256、`licenses/` 许可原文与移植的判分/导入代码），`pnpm run test:memory-bench:prepare [-- --data-dir <目录>]` 把原始文件与转换后的案例装进 data-dir（默认 `test/memory-bench/.data/`，已 gitignore；也可用 `DESKPET_BENCH_DATA_DIR`），运行期不做下载。判分为官方模板的自适配移植（LoCoMo 词面 F1 不用 judge；judge 走配置网关且必须异构于被测模型），报告 `desk-pet-memory-bench/v1` 顶层 `source: external` / `status: observational`、质量阈值字段恒 `null`——宿主 `PASS` 只表示完整跑完。来源、许可（LoCoMo 非商用）、子集口径与全部偏差、以及**按消耗分层的运行节奏**（默认只跑 LongMemEval oracle 常规层，S 变体 / 中文 / 对外各按触发条件跑）见 [memory-bench/README](memory-bench/README.md)。

**性能**测 1k/10k 合成库，查询包含短中文、别名/长词、组合条件和无关词，分别逐次记录 query + get_items 和真实 MemoryProvider 端口调用（off重排；绑定实际会话与测试操作来源），报告 P50/P95 与原始样本。10k 的四条代表查询都须热路径 P95≤500ms，任一超标都失败（用户于2026-10-02放宽原50ms目标）。普通L4场景默认等5分钟、显式场景时限优先；整批截止至少30分钟，三trial批为30分钟，质量采集8小时，超时仍失败并保全证据。release Rust 存储和 debug WebView IPC 分列；连接重开不等于 OS 冷缓存。另记录建库、FTS 重建、发布、备份、磁盘、后台查询争用下的前台真实回合，以及按 idle/运行区间区分的进程树 RSS/CPU 样本。进程树可能遗漏 launchd 持有的 WebKit helper；完整产品 RSS、release IPC、二进制增量与 ChatPanel UI 延迟仍需相应实机验收，不能由编译进程样本或 debug 结果替代。性能报告位于 `test/reports/performance/`，按与日期戳报告一致的口径淘汰：最近 5 份、累计不超过 200 MiB、最新一份始终保留。

## Contract 与 sourceHash

`contracts/*.contract.ts` 是模块行为契约。每个 coverage point 的 `scenarios` 必须写场景的稳定 **`caseId`**，不是文件名、描述或导出名。每个 caseId 只能归属一个场景，且场景的 `meta.module`、`meta.contractId` 必须与其 Contract coverage point 一致。

**跨层 caseId 对账在全量 L4 的收尾路径真实执行**：启动脚本（`scripts/contract-layers.mjs`）把三层实际收集到的 caseId 汇总 —— unit / integration 读最近一次整层快层运行落盘的 `test/reports/caseids-*.json`，e2e 读本次报告的场景集（skip 不算）—— 与全部 Contract 声明的 `scenarios` 对比：声明了没有任何层携带（MISSING）、携带了没有任何声明（ORPHAN）、同一 caseId 被两层同时携带（CROSS-LAYER，违反跨层唯一）任一命中即打印明细并非零退出。带 `--module` / `--scene` / `--case` / `--tag` / `--suite` 过滤、或 `--bench` / `--quality` / `--performance` 特殊模式的运行跳过（集合残缺会误报），所以全量 L4 前要先跑过快层（`test:release` 的顺序保证）。快层逐层运行时 `test/host/caseid-reporter.ts` 只判自己那层并把整层集合落盘 —— 落盘文件正是这份对账的输入。

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

### 每个 trial 都是独立的一生：repeat 隔离纪律

`--repeat N` 在**同一个 app 实例**里把 Scene 连跑 N 次，每次调用 `setup()`，期间共享同一份隔离数据根（SQLite、会话、文件）。因此：

- **setup 必须可重复执行**：所有持久化身份（attempt / request / occurrence / 指纹 / 自定义 id）在每次 setup 里重新生成，绝不跨 trial 复用固定值——已结算的身份会被产品守卫（去重、幂等、冷却）合法拒绝，表现为后续 trial 卡在 setup。
- **消耗型共享资源要用独立记账域**：按日 / 按槽计数的配额（如 proactive 的每日 expression 尝试）在同一记账键下被所有 trial 与场景共享；每个 setup 取一个未用过的记账键（模式见 `test/e2e/scenes/proactive/quota-day.ts`），否则 `repeat>1`（或后跑的场景）会撞产品配额——那是产品正确行为，不是缺陷。
- **模块级变量跨 trial 存活**：外层只放声明，值一律在 `setup` 内赋值；不要假设上一个 trial 留下的状态是干净的。

### 宿主能力对等：能用什么，先核实

Scene 跑在 **E2E 宿主**里，它是产品的一个子集：不创建主窗口 / 系统托盘 / 光标追踪；`lib.rs` 的 `if e2e` 分支提前返回，**只在该分支之后、或只在产品窗口路径（App.vue 等）触发的初始化不存在**。已知对账：监控线程两种宿主都会跑（bh-06 依赖它）；`initWindowListener` 只在 App.vue 调用，宿主里窗口快照恒为 null（`窗口信息三态` 因此只覆盖两态，并把「快照必须为 null」断言成前置）。写场景前，对它依赖的每个子系统先读 `lib.rs` 的 e2e 分支与 `standard-setup.ts` 核实宿主是否拉起；确实造不出的状态按「可验证性边界」模式处理：断言前置 + 注释写明为什么与何时重写，不允许假装覆盖。

### 交付前的自证：全量严格 ×3

新增或修改 Scene 后，迭代期可以用 `--module` / `--case` 过滤快速跑单场景；但**交付前必须完整跑一次严格 + 3 trials 的全量套件并要求全绿**：

```bash
pnpm run test:e2e -- --strict --repeat 3 --report json
```

过滤运行会跳过多项只有全量才做的校验（跨层 caseId 对账、完整严格契约集合、共享状态的真实上下文），**不构成自证**。把新场景留到发布门禁才第一次全量跑，就是把问题攒到最贵的时间点才被发现。

## 隔离、超时与失败

测试配置默认关闭本机外部 MCP 连接；需要 MCP 的场景在自己的 setup 声明前提或替换传输边界，模型认证仍读取隔离副本。本机配置不被写回。

每个 trial 在 `standard-setup.ts` 中取消并等待已登记 Agent 回合，然后重置会话文件、UI index、工作记忆、变量池、聊天状态、预处理与 AI 锁。超时按固定顺序收尾：置取消位（框架在每个步骤边界停下，不再推进后续 setup 与断言）→ 取现场 → 取消已登记的 Agent 回合 → 最多等 `SCENE_CANCEL_GRACE_MS` 让被放弃的执行落地，没落地会写进超时 error。超时报告保留已完成轮次和在飞轮次已跑完的断言，并补一条失败的 `timeout` 断言；`status` 仍是 `timeout`，不进通过统计。

取消是协作式的：JS 不能强杀任意 await，Scene 自己发起、不经过框架边界的等待只能靠上述宽限时间收尾。Provider、网络、认证和断言等错误会分类，兜底回复不把失败改写为成功。

E2E 启动脚本在 `test/.tmp/e2e-*` 创建隔离数据根，复制完整开发配置到其中的 `settings/CONFIG.yaml`。测试中的配置修改只写该副本；真实 `CONFIG-DEV.yaml` 和用户数据不被写入。退出/超时先停止隔离进程组、留存证据，再清理临时根；复制失败保留原根。

## 目录职责

```text
test/
├── README.md             # 分层入口、规则表、命令、报告与 L4 Scene 规范（本文件）
├── SKILL.md              # Contract 分析、测试生成与覆盖审查流程（/analyze /generate /audit）
├── contracts/            # 模块行为契约与 sourceHash（跨层）
├── host/                 # 宿主与共享设施（L2–L4）：状态隔离、确认通道、断言辅助、契约校验、
│   │                     #   caseId 收集、Node IPC 适配层
│   └── shims/            # node:assert/strict 的别名目标（evaluation 的 L4 场景经 vite 别名真实消费；删除会破坏 L4）
├── unit/                 # L2：朴素 vitest，纯逻辑
├── integration/          # L3：朴素 vitest + 临时数据根 + fake Provider
└── e2e/                  # L4：宿主入口 e2e-main 与执行器 scene-runner / dataset / reporter / cli，
                          #   以及 scenes/ 下的场景
```
