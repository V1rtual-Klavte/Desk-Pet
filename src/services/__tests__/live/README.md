# Desk-Pet Live Test

Live Test 是 Desk-Pet 的运行时验证入口。它在独立 Tauri WebView 中执行真实前端服务、Rust IPC、临时数据根和 Agent/Tool 链路；测试数据不会写入正常用户数据根。

Contract/Scene 的代码代理工作流见 [SKILL.md](./SKILL.md)。当前验证边界与证据索引见 [docs/current/testing.md](../../../../docs/current/testing.md)。

## 运行命令

在项目根目录执行：

```bash
# 编译与类型门禁；不替代运行时验证
pnpm run test:types

# 全部 Live Scene
pnpm test

# 模块、稳定 caseId、描述、标签或套件筛选
pnpm test -- --module memory
pnpm test -- --case memory-compaction-checkpoint
pnpm test -- --scene "压缩检查点"
pnpm test -- --tag boundary
pnpm test -- --suite safety

# 严格 Contract 门禁与重复试验
pnpm test -- --strict --repeat 3 --report json

# 生产入口 smoke 与发布门禁
pnpm run test:smoke
pnpm run test:release
```

可组合的筛选参数为 `--module`、`--scene`、`--case`、`--tag`、`--suite`、`--repeat`、`--strict`、`--report`。`--repeat` 范围为 1–20，且不会低于 Scene 的 `meta.repetitions`。`test:release` 执行类型检查与严格三次 Live 试验。

默认在启动时检查全部 Contract；聚焦单模块可用 `--module memory --contracts selected`，这不替代跨模块或发布前全量门禁。源码或 Contract 改动完成后再集中执行受影响模块和必要的全量验证；纯文档修改不运行 Live Test。

## Contract 与 sourceHash

`contracts/*.contract.ts` 是模块行为契约。每个 coverage point 的 `scenarios` 必须写 Scene 的稳定 **`caseId`**，不是文件名、描述或导出名。每个 caseId 只能归属一个 Scene，且 Scene 的 `meta.module`、`meta.contractId` 必须与其 Contract coverage point 一致。

Node 启动预检会校验 `sourceHash`；源码变更后应先按 SKILL 重新分析 Contract，再更新 hash 和场景。不要只替换 hash 来绕过门禁。`--strict` 还会拒绝 coverage、深度、边界、错误或入口规则的缺口。

浏览器侧不做也不假装做独立校验：预检通过时把「模块 → sourceHash」的证明交给运行中的测试窗口，契约声明与证明不一致、或根本没有证明（例如绕过启动脚本直接开 Tauri）时该 Contract 记为 `stale`，严格模式据此失败。

`sourceHash` 只覆盖 Contract 声明的 `sourceFiles`，不是依赖闭包；两者的差异清单与是否收紧门禁见[2026-09-20 收尾清单](../../../../docs/plans/active/2026-09-20收尾清单.md) L3。

## Scene 规范

每个 Scene 声明稳定的小写 kebab-case `caseId`、`module`、`contractId`、`suite` 和 `depth`。`suite` 取值为 `regression`、`capability`、`safety` 或 `stress`；需要满足 Contract 的边界/错误规则时，分别带 `boundary` / `error` tag。

入口按要验证的边界选择：

| `entry` | 执行内容 | 适用场景 |
| --- | --- | --- |
| `production` | 经过 `sendMessage()` 的真实聊天入口 | 验证预处理、队列、会话/UI 消息与完整产品链路 |
| `runtime` | 直接调用 Pi runtime，并镜像必要的会话消息生命周期 | 验证 Agent、上下文、工具、持久化等运行时适配 |
| `unit` | 不调用模型，只运行进程内断言 | 纯函数、注册表、解析与确定性状态边界 |

`runtime` 与 `production` 可使用真实 Provider，也可由场景安装 fake Provider：fake Provider 只替换模型响应，保留真实 Agent/Tool 执行路径；是否发生工具调用或 Rust IPC 由具体 Scene 的断言证明。`unit` 不证明模型、Provider 或桌面入口行为；非 `unitOnly` Contract 至少保留一个非 unit Scene。

场景断言应观察实际结果：工具要断言具体调用与状态，持久化要回读临时数据根，安全场景要区分“未调用”和“调用后被拒绝”。不要只以回复非空代替状态或副作用验证。

测试宿主没有 ChatPanel。涉及确认请求的 Scene 用 `meta.confirmPolicy` 声明 `deny`（默认）或 `approve`，由 `confirm-channel.ts` 确定性应答。

## 隔离、报告与失败

每个 trial 在 `standard-setup.ts` 中取消并等待已登记 Agent 回合，然后重置会话文件、UI index、工作记忆、变量池、聊天状态、预处理与 AI 锁。超时按固定顺序收尾：置取消位（框架在每个步骤边界停下，不再推进后续 setup 与断言）→ 取现场 → 取消已登记的 Agent 回合 → 最多等 `SCENE_CANCEL_GRACE_MS` 让被放弃的执行落地，没落地会写进超时 error。超时报告保留已完成轮次和在飞轮次已跑完的断言，并补一条失败的 `timeout` 断言；`status` 仍是 `timeout`，不进通过统计。

取消是协作式的：JS 不能强杀任意 await，Scene 自己发起、不经过框架边界的等待只能靠上述宽限时间收尾。Provider、网络、认证和断言等错误会分类，兜底回复不把失败改写为成功。

测试脚本在用户 Home 下创建 `.deskpet-live-test-*` 临时目录，退出时清理；清理前将报告复制到 `~/.deskpet-live-test-reports/`，按脚本保留数量淘汰。

JSON 报告使用 `desk-pet-live/v2`，包含数据集版本、筛选项、trial 指标、错误分类与 `pass@k`/`pass^k`。前者表示至少一次试验通过，后者表示全部已执行试验通过；回归或发布结论使用后者及严格 Contract 结果。`environment.seedHash` 由启动脚本生成：覆盖 `src-tauri/resources/defaults` 下的文本种子与开发构建实际加载的 CONFIG，凭据按 key 名脱敏后不参与摘要，二进制素材与摘要无关。

运行需要可用的 Tauri/Rust 环境与对应 Provider 配置。不要与占用同一 Vite/Tauri 端口的开发实例并行运行。

## 目录职责

```text
live/
├── README.md             # 命令、运行边界和 Scene 规范
├── SKILL.md              # Contract 分析、Scene 生成与覆盖审查流程
├── contracts/            # 模块行为 Contract 与 sourceHash
├── scenes/               # SceneDef 场景
├── standard-setup.ts     # 状态隔离
├── scene-runner.ts       # Scene 执行与断言
├── contract-checker.ts   # Contract 引用与覆盖规则
├── dataset.ts            # 数据集版本和 caseId 校验
└── reporter.ts           # terminal/json/markdown 报告
```
