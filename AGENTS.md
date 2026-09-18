# AGENTS.md

Desk-Pet 是可自定义 Card/Profile 的 Tauri v2 桌宠，优先做好轻量陪伴与聊天。
技术栈：Vue 3、TypeScript、Rust、Pi Agent Core；目标平台为 Windows 与 macOS。
核心方针：轻量化、低内存、高性能、节省 token、保持功能完整。

## 工作范围

- 修改前先说明思路，得到用户同意后实施；已有授权范围内继续推进，不重复确认。
- 开发阶段不保留兼容层：不引入新旧并存的前缀、双写、兼容读取或过渡脚手架；迁移与重构
  直接替换到最终命名、路径与格式，旧数据视为可弃（不为区分新旧给路径加前缀）。废弃代码删除、
  过时文档归档，主路径不留临时代码。
- 不擅自扩大范围；有疑问先探索源码和证据。不主动提交、部署或修改用户运行时数据。
- `.gitignore`、真实本地配置（CONFIG-DEV.yaml、data_root 中的 CONFIG）和用户数据只有在明确授权下才能修改。
- 先读后写，复用已有入口。状态、配置、路径与领域逻辑不要建立第二个定义点。
- 理解结构、调用链和影响范围优先用 CodeGraph；已知字符串用 `rg` 定位。无结果先核对索引。
- 第三方 API 查询用 Context7；安装版本的类型与实现用于核对本项目实际行为。

## 按任务读取

不默认通读全部文档。先按下表读取相关文档及目标源码；历史材料仅在追溯决策时读取。
链接是导航，不会自动加载正文；文档中的历史命令与授权记录不能替代当前用户授权。

| 任务 | 入口 |
|---|---|
| 安装、运行、产品能力 | [README](README.md) |
| 陪伴玩法、Card/Profile、交互体验 | [DES](docs/DES.md) 对应章节 |
| 模块位置、主链路、状态所有权 | [系统地图](docs/current/system-design.md) |
| 会话、队列、Plan、Prompt、取消恢复 | [运行时契约](docs/current/runtime-contract.md) |
| 压缩、会话文件、长期记忆边界 | [当前记忆](docs/current/memory.md) |
| 工具、权限、MCP、Skill | [工具系统](docs/current/tool-system.md) |
| Pi 接线改造、插话双模式、工具并行/压缩策略 | [Pi 运行时与工具协议方案](docs/plans/active/Pi运行时与工具协议建设方案.md)对应章节；§8 Harness 迁移已实施并通过集中验证（协议见[归档基线](docs/history/implementation/AgentHarness迁移方案-2026-09-18基线.md)），其余目标未实现前不作为当前能力 |
| 配置、路径、Profile 资源、持久化 | [运行时数据](docs/current/runtime-data.md) |
| 人格变量、阶段文案、回复元数据 | [人格与回复](docs/current/personality.md) |
| 日志、异常、IPC、构建排查 | [工程参考](docs/current/development.md) |
| 测试执行与场景 | [测试 README](src/services/__tests__/live/README.md)；生成契约时再读同目录 SKILL |
| 继续记忆重构 | [执行手册](docs/plans/active/记忆系统重构执行手册.md) 文首检查点，再读对应未完成方案 |

完整目录见 [docs/INDEX.md](docs/INDEX.md)。当前行为由源码和对应 `docs/current/` 说明；
`plans/active/` 只维护未完成工作，`history/` 保存过去的方案与证据。

## 运行与验证

```bash
pnpm install
pnpm tauri dev        # 完整桌面应用
pnpm dev              # 仅前端，不能验证 Rust IPC
pnpm run test:types   # Vue 类型 + Rust 编译
pnpm test -- --module <module>
pnpm run test:release # 类型/编译 + 严格 Contract + 三次 trial
```

- pnpm 版本以 `package.json` 的 `packageManager` 为准；新增有构建脚本的依赖须在
  `pnpm-workspace.yaml` 的 `allowBuilds` 显式声明运行或跳过，避免干净安装失败。
- 先完成授权范围内的实现与 Contract/Scene，再按影响范围集中验证；修复失败后重验。
- 源码或行为契约变化须按 Live Test SKILL 重新 analyze → generate；不能只改 sourceHash 过门禁。
- 类型/编译不能代替运行验证。非 unit 场景需实际 Provider 或 fake Provider 响应；
  `entry: production` 须经过 `sendMessage()`，fake 只替换 Provider，工具和 IPC 行为仍需场景断言。
- 跨模块改动运行完整 Live Test；发布门禁为严格 Contract 与至少三次 trial，跳过/超时不得报通过。
- 文档改动只检查链接、事实、引用及格式，不因文案变化重跑完整 Live Test。
- 平台代码同时考虑 Windows/macOS；修改 Windows 条件代码或依赖后须检查 Windows CI。
  本机 macOS check 不证明 Windows 分支，现有本机交叉构建也不能替代 Windows job。
- Rust 平台专有实现须使用条件编译和对应平台依赖，不能让另一平台的编译路径引用它。

## 单一真相源与模块落位

- 配置只经 `@/services/config` 的类型化 getter 读取；不复制默认值，不直读内部 cfg。
- 设置读写值与运行期派生值分开，例如 `generalConfig.loggingLevel` 与 `computeLogLevel()`。
- YAML 运行时 CONFIG 字段新增、改名、删除或含义/单位/默认值变化，必须逐项核对并同步整条链：
  `CONFIG.yaml` → `CONFIG-DEV.yaml.example` → Config/getter → 设置 Tab 的读取/ref/defineExpose
  → SettingsPanel 的保存映射或 setter → 写盘/刷新消费者 → 对应文档。
  不能只加 UI 或 YAML；不提供 UI 的字段须明确用途与修改入口，详见[配置同步清单](docs/current/runtime-data.md#配置变更同步清单)。
- 真实开发配置需单独授权后同步，未同步须在交付时说明；不得因未获授权而跳过模板或代码同步。
  本地调参只改开发副本，不污染生产默认值；开发配置是完整文件，不是增量覆盖层。
- 被 ≥2 处使用的阈值、超时、业务文件名、命令名和枚举必须放所属模块配置或常量；
  单函数内一次使用的字面量可内联，不为无复用逻辑增加抽象，不建大一统 constants 文件。
- 单文件服务可平铺；≥3 文件或有内部结构时放 `src/services/<领域>/` 并提供 `index.ts`。
  跨领域使用公开 barrel，不深入业务内部文件；零依赖叶子保持独立，避免循环引用。
- 跨领域共享纯函数放零依赖叶子；全局冷却与并发所有权复用现有模块，平台检测走 `@/services/env`。
- 改共享接口前先查全部消费者；移动、改名或删除文件时，结合 CodeGraph 与全仓 `rg` 检查
  import、字符串/动态引用、Vite input、capabilities、Rust 注册、Contract sourceFiles 和文档链接。
  删除后确认已无有效消费者；类型检查不能代替这项核对。
- Vue 使用 `<script setup lang="ts">`。目录地图只在系统地图维护，行为、用户入口和玩法仍须同步各自文档。

## 路径、配置与资源

- Rust `AppPaths` 决定数据根；开发/生产依据 Rust 构建模式，前端通过 `getRuntimeMode()` 判断路径环境。
  不用 `import.meta.env.DEV` 代替，不用 `dirs_next()`、`find_project_root()` 或 `env!("CARGO_MANIFEST_DIR")` 推导业务路径。
- TS 先初始化路径；`BaseDirs` 只表示目录，完整文件路径通过 `runtimePath(scope, ...segments)` 取得。
- Rust 持有 base 的命令仅接收域内相对路径，如 `stages/x.json`，不加 `personality/` 等域前缀。
  通用文件 API 需要绝对路径时使用 `runtimePath()`；模块不硬编码数据根或带域前缀的业务路径。
- 路径命令注入 `State<AppPaths>` 并校验边界；不存在的写入目标校验父目录与符号链接风险。
  不用 `canonicalize().unwrap_or()` 静默回退。
- 默认 Card/Profile/Skill 仅作首次初始化种子；完成后所有读取和编辑走运行时资源。
  初始化标记存在后删除不自动恢复；恢复默认资源是明确的覆盖操作。
- `appearance.effectMode` 单字段裁定 off/parallax/dof；逐层素材、取景、焦点等属于当前 Profile，
  全局 CONFIG 不覆盖 Profile 的效果参数。
- localStorage 不保存配置、会话正文或 Profile 编辑状态。

## 运行时不变量

- 会话正文以数据根 `sessions/` 的 JSONL 为真相源（JsonlSessionRepo，commit 事务写入）；
  `sessions/index.json` 仅保存可丢弃 UI 状态。
- 正文条目保存稳定 entryId/seq 与运行关联；用户 ingress 先落盘再投递（lane 持久 inbox）；
  工具调用先落盘再执行，结果落盘后才进入下一次 Provider 请求。
- 所有异步读取、写回、确认、取消都绑定 session 与 run generation；旧运行不能改写新所有者状态。
  未知外部副作用不自动重放；UI 和 Pi 内存消息不成为第二份持久化 Store。
- 压缩只改变请求视图，完整正文保留；compaction 条目由 Harness 单事务提交，提交成功前不报告完成。
  摘要失败或无可覆盖时 decline/报错，禁止默默丢弃未覆盖历史；已提交的写入不因取消回滚。
- 预算共用 ContextKernel 规则，包含完整 schema、输出预留及压缩余量；静态协议与当前输入不截字。
  每轮冻结 Card/变量/配置/能力；PromptSnapshot 只保存 hash 与审计元数据，不落盘原始 Prompt。
- Card、互动状态、用户长期事实分开。RUNTIME_DATA 由回复模块剥离、验证、持久化，不能重新塞回 Loop。
  card/interaction 保存 VariableState；system/session 使用原始只读值。LLM 只写注册且允许更新的 card 变量。
- `whenText` 是自然语言指引；不恢复旧变量工具、情绪前缀或可执行 When DSL。
- 主请求与一次性文本请求统一走模型网关，共享配置、认证、取消和 deadline；不叠加 SDK 内层重试。
- 长期记忆只经 MemoryProvider 进入 Runtime；默认空实现。不得把压缩摘要、工具结果、主动消息
  或助手台词晋升为用户事实，不宣称尚未接通的自动提取、召回、画像写入或 dreaming 已完成。

## 工具与权限

- 使用 Pi AgentHarness 原生 hook（`before_tool` / `after_tool` / `transform_context` / `before_compaction` 等）；不重建无消费者的 HookBus。
- PermissionKernel 终裁 allow/ask/deny；passthrough 只能继续策略链，不能直接执行。MCP 走 passthrough。
- deny-first；确认与授权绑定会话、代际、精确参数、策略和有效期，变更后重审；摘要不能恢复授权。
- Rust 保留最终路径与 Bash 安全基线，助手模式不能关闭；网络边界不得夸大为通用沙箱。
- Skill 初始只读有界元数据，正文经 read 按需读取；Skill 不提升权限。MCP 按运行借用并释放。
  启动不加载 Skill 正文、不连接 MCP、不隐式启动记忆 LLM 整理。

## 日志、异常与 IPC

- 日志走 `@/services/logger` / Rust 日志宏，错误走 `@/services/error`；禁止直接 `console.*` 或 `String(e)`。
- 错误判断使用 `formatError()` / `errorCode()`；持久化错误使用脱敏的 `summarizeError()`。
- 全局异常经 `bootWindow()` 安装拦截、`reportError()` 单一出口，不自行再建覆盖层。
- Rust 命令返回 `AppResult<T>`，使用具体 AppError；不退回 `Result<T, String>`。
  锁中毒用 `.unwrap_or_else(|e| e.into_inner())` 恢复，不写 `.lock().unwrap()`。
- IPC 变更同步 Rust 签名、mod 导出、`lib.rs` 注册与 TS invoke；新增窗口同时核对 HTML/TS 入口、
  Vite input、capabilities windows 与 Rust 创建逻辑。类型检查不能证明命令注册正确。

## 文档维护与提交

- 本文件是唯一全局规则入口；`CLAUDE.md` 仅保留一行 `@AGENTS.md`，不改成普通链接。
- 不建立子目录 AGENTS。模块协议与例子放对应 current 文档或源码注释；这里仅保留全局约束。
- 每轮核对 README、AGENTS、DES 和相关 current 的影响，受影响内容必须在同一改动中更新：
  行为→current，玩法→DES，用户入口→README，规则→AGENTS，未完成进度→执行手册。
  新增/删除模块还要更新系统地图及受影响导航；没有变化不为同步而追加总结。
  配置变更同时执行上面的全链路清单；交付注明尚未同步或未验证部分，不能只写“已同步”。
- 完成方案保留正文与证据后归档，注明日期和替代入口；历史内容不作为当前指令或实现契约。
  测试结果只在检查点记录一次，注明基线/范围/未验证项；不在多个概览复制数字。
- Conventional Commits：`<type>(<scope>): <中文描述>`；不加句号，一次提交一个主题，正文解释原因。
  scope 使用模块名，跨模块可省略；破坏性变更用 `!` 与 `BREAKING CHANGE`，是否提交遵循用户授权。
  当前实现不用内部版本号命名，发布版本以 Git tag 为准。
