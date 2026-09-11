# Live Test 使用规范

Live Test 用于验证 Desk-Pet 的真实运行链路。它会启动独立的 Tauri WebView，调用真实 Provider、真实 Rust IPC、真实工具和真实状态模块，不使用 Tauri mock。

## 1. 两类入口

Live Test 有两个不同入口，不要混用。

### 代码代理工作流

以下内容发送给代码代理，不是在终端执行的命令：

```text
/analyze test variable-pool
/generate test variable-pool
/audit test --strict
```

- `/analyze test [module]`：重新分析源码，更新 Contract、覆盖点、`sourceFiles` 和 `sourceHash`。
- `/generate test [module]`：根据 Contract 补充或更新 Scene。
- `/audit test [--strict]`：审查覆盖缺口、边界路径、错误路径和断言质量。
- 这些工作流的具体约束定义在同目录的 `SKILL.md`。

不要尝试在 shell 中执行 `SKILL.md`。它是代码代理的工作说明，不是脚本。

### 终端执行入口

Contract 和 Scene 准备完成后，在项目根目录运行：

```bash
# 静态编译门禁（不替代真实运行）
pnpm run test:types

# 真实生产入口的严格 smoke，固定执行 2 次
pnpm run test:smoke

# 执行全部场景
pnpm test

# 执行指定模块
pnpm test -- --module variable-pool

# 按场景描述筛选，使用包含匹配
pnpm test -- --scene "越界值"

# 按标签精确筛选
pnpm test -- --tag runtime-data

# 按稳定数据集 ID 运行，或运行某个测试套件
pnpm test -- --case production-chat-entry
pnpm test -- --suite safety --repeat 3

# 在 CI/发布前将 Contract 缺口作为失败门禁
pnpm test -- --strict --report json

# 切换报告格式：terminal、json 或 markdown
pnpm test -- --module memory --report markdown

# 发布门禁：编译 + 全集 Contract 严格检查 + 每个场景 3 次真实试验
pnpm run test:release
```

筛选参数可以组合使用。`--repeat` 范围为 1-20；场景的 `meta.repetitions` 是该场景的最低试验次数，CLI 的 `--repeat` 只会提高而不会降低它。命令成功退出码为 `0`；场景失败、超时、Contract 过期、严格 Contract 门禁失败或测试宿主异常时退出码为非 `0`。

`test:release` 现在会如实因现有遗留 Contract 的 coverage 缺口失败，直到每个 coverage point 都有对应场景和可验证断言。不要把非严格 `pnpm test` 的结果用于发布结论。

## 2. 普通源码变更后的流程

修改已有模块源码后，按下面顺序处理：

1. 确定受影响的 Contract。查看 `contracts/*.contract.ts` 的 `sourceFiles`，调用链跨模块时需要处理所有受影响 Contract。
2. 在代码代理会话中执行 `/analyze test <module>`。即使你认为行为没有变化，也应让代理重新检查公开 API、分支、边界和错误路径。
3. 审查 Contract diff，确认 `sourceFiles`、coverage 和 rules 与当前代码一致。
4. 如果新增或改变了行为，执行 `/generate test <module>`，补充或更新对应 Scene；纯实现变化且合同未变时，可以保留原 Scene。
5. 执行 `/audit test --strict`，检查没有遗漏的覆盖点和无效断言；发布前使用 `pnpm test -- --strict --repeat 3 --report json` 留存真实运行证据。
6. 在终端先运行受影响模块：`pnpm test -- --module <module>`。
7. 模块测试通过后运行完整 `pnpm test`，检查跨模块回归。

`sourceHash` 是门禁，不是覆盖证明。禁止为了让测试启动而只手工替换 hash；必须先重新审视 Contract。当前 hash 算法是：按路径排序后拼接 `sourceFiles` 的 UTF-8 内容，再计算 SHA-256。

任意一个 Contract 过期都会在 Tauri 启动前阻断测试，即使本次使用了 `--module` 筛选。

## 3. 新增模块或能力

新增可测试模块时：

1. 在 `contracts/` 新增 `{module}.contract.ts`。
2. 在 `scenes/{module}/` 新增一个或多个 `.scene.ts`。
3. 将模块和主要源文件补入 `SKILL.md` 的覆盖表。
4. Contract 的每个 coverage point 通过 `scenarios` 关联实际 Scene；每个引用必须解析到已发现的 Scene，且 Scene 的 `module` 和 `contractId` 必须分别匹配 Contract 模块与 coverage point。
5. 至少覆盖正常路径、状态变化、边界值和错误路径。
6. 先执行模块测试，再执行完整测试。

Scene 会由 Vite 的 `import.meta.glob` 自动发现，通常不需要修改 Runner 或入口文件。每个 Scene 必须有全局稳定的 `caseId`（小写 kebab-case）、`suite`（`regression`、`capability`、`safety`、`stress`）和与 Contract 对应的 `contractId`；启动时会校验它们。Contract 要求边界或错误路径时，对应 Scene 必须分别带有 `boundary` 或 `error` tag，不能以中文描述文本代替。

## 4. Scene 编写要求

每个场景应验证行为结果，而不是只验证“模型返回了文字”。`entry: "runtime"` 验证 Pi 运行时；`entry: "production"` 必须走 `sendMessage()`，用于覆盖预处理、会话和 UI 消息写入。根据合同至少组合以下断言：

- `output.reply`：最终用户可见回复有效。
- `pool`：Card、interaction 等变量状态及 `VariableState` 元数据正确。
- `session`：状态回到 `WAITING`，消息数和工具调用数符合预期。
- `memory`：会话轮数、条目数量、分类或已保存的工作记忆内容正确。长期记忆的自动检索未闭环时，不能把模型复述当作长期召回通过。
- `toolHistory`：目标工具实际被调用，并具有预期的 `done`、`blocked`、`denied` 或 `error` 状态。
- 副作用：需要持久化的内容确实通过真实 IPC 写入测试数据目录。

工具场景必须断言具体工具及状态。仅断言回复非空不能证明工具链成功。安全场景不能通过执行真实破坏操作验证，应断言模型实际发起目标调用且该调用被拒绝、拦截或以受控错误结束；没有调用不构成通过。

真实 LLM 输出存在波动。场景应断言稳定的产品合同和状态，不应依赖固定措辞、标点或完整字符串相等。

## 5. 运行环境和数据隔离

执行 `pnpm test` 时会：

1. 在 Node 侧校验全部 Contract 的 `sourceHash`。
2. 在用户目录创建临时的 `.deskpet-live-test-*` 数据根。
3. 只读复制现有 `data/desk-pet/personality/stages` 作为测试种子（若存在）。
4. 启动 Vite 和 debug Tauri 测试窗口。
5. 每个 trial 先等待前一个场景的异步会话写入，再重置会话工作记忆、轮次计数、session 文件与 UI index、变量池、聊天记录、长期记忆、预处理去重状态和 AI 锁。
6. 在真实 WebView 中执行 Contract、Scene 和断言；每个 Scene 可声明超时，超时不再伪装成普通失败。
7. 写出测试结果、关闭应用并删除临时数据根。Node 侧会处理 SIGINT/SIGTERM 和 10 分钟宿主超时。

正常运行不会修改 `data/desk-pet` 中的用户 Memory、Session、Card 或变量状态。异常强制终止时，可以检查用户目录是否遗留 `.deskpet-live-test-*`；确认没有测试进程使用后再手工清理。

运行前需要：

- 已安装项目依赖和 Rust/Tauri 构建环境。
- `CONFIG-DEV.yaml` 或默认配置中存在可用的 Provider 配置。
- Provider 支持待测能力；例如工具场景要求模型和兼容接口支持 tool calls。
- 本机端口 `1420` 未被其他 Vite/Tauri 开发进程占用。

不要并行执行多个 Live Test，也不要在 `pnpm tauri dev` 占用同一端口时启动 Live Test。

## 6. 如何判断失败

失败报告需要按证据分类，不要为了通过而放宽断言：

| 现象 | 首先检查 |
|---|---|
| `[STALE]` | 源码已变化，执行 `/analyze test <module>`，不要只改 hash |
| Provider 401/403 | API key、权限和 endpoint |
| Provider 429/503/超时 | Provider 可用性、限流和网络，不得声明业务通过 |
| 有回复但没有工具历史 | 模型/Provider 未发起 tool call，或工具声明未送达 |
| 工具状态为 `error` | Rust IPC 返回值、参数、路径和平台实现 |
| 工具状态为 `blocked/denied/error` | Safety 规则、确认策略及工具 handler 的拒绝路径是否符合合同 |
| 变量未变化 | RUNTIME_DATA、Card 注册表、类型/范围和 `updateBy` |
| Memory/Session 写入失败 | 临时数据根、Rust 路径校验和初始化顺序 |
| Setup 失败 | 测试基础设施失败；会以 fail 结束，不能把它算成 skip |

测试通过只证明当前 Provider、当前配置和已覆盖 Scene 下的合同成立，不代表所有未覆盖行为都正确。

## 7. 目录职责

```text
live/
├── README.md             # 本使用规范
├── SKILL.md              # 代码代理的分析、生成和审查工作流
├── contracts/            # 当前模块行为合同和源码 hash
├── scenes/               # 真实多轮场景与断言
├── dataset.ts            # 数据集版本与 caseId/Contract 完整性校验
├── live-test-main.ts     # Tauri WebView 执行入口
├── standard-setup.ts     # 场景状态隔离和标准初始化
├── scene-runner.ts       # 场景执行、状态快照和断言
├── contract-checker.ts   # 覆盖完整性检查
├── reporter.ts           # terminal/json/markdown 报告
├── cli.ts                # 筛选参数解析
└── types.ts              # Contract、Scene 和报告类型
```

测试报告采用 `desk-pet-live/v2` schema。JSON 报告包含数据集版本、Git commit、Card 种子 hash、筛选项、每个 trial 的工具/重试/回复长度/浏览器堆指标、错误分类和 `pass@k`/`pass^k`。它们分别表示“至少一次试验通过”和“所有已执行试验都通过”；不能用 `pass@k` 替代回归门禁。

测试宿主脚本位于项目根目录的 `scripts/live-test.mjs`，Tauri 测试页为 `live-test.html`，Rust 测试窗口和退出命令位于 `src-tauri/src/lib.rs`。
