# AGENTS.md

V1rtual-Desk-Pet 是可自定义 Card/Profile 的桌宠，优先做好轻量陪伴与聊天。
技术栈：Rust 原生宿主（含原生 UI 与平台能力）、TypeScript（Node 22 Harness 与服务层）、
Pi Agent Core；唯一 Node 随包分发（版本锁定在 `packaging/node-runtime.json`），无 WebView。
目标平台为 Windows 与 macOS。核心方针：轻量化、低内存、高性能、节省 token、保持功能完整。

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

不默认通读全部文档。先按下表读取相关文档及目标源码；`docs/history/` 归档后封存，不再读取或修改。
链接是导航，不会自动加载正文；文档中的历史命令与授权记录不能替代当前用户授权。

| 任务 | 入口 |
|---|---|
| TypeScript 业务服务、Harness 接线 | [services AGENTS](src/services/AGENTS.md) |
| Rust 宿主、原生 UI、平台能力 | [native-host AGENTS](crates/native-host/AGENTS.md) |
| 安装、运行、产品能力 | [README](README.md) |
| 陪伴玩法、Card/Profile、交互体验 | [DES](docs/DES.md) 对应章节 |
| 模块位置、主链路、状态所有权 | [系统地图](docs/current/system-design.md) |
| 会话、队列、Plan、Prompt、取消恢复 | [运行时契约](docs/current/runtime-contract.md) |
| 压缩、会话文件、长期记忆边界 | [当前记忆](docs/current/memory.md) |
| 工具、权限、MCP、Skill | [工具系统](docs/current/tool-system.md) |
| Pi 接线改造、插话双模式、工具并行/压缩策略 | [运行时契约](docs/current/runtime-contract.md)、[工具系统](docs/current/tool-system.md)与目标源码；剩余工作见[未完成工作与已知缺口](docs/plans/active/未完成工作与已知缺口.md)的 PI 剩余批次 |
| 配置、路径、Profile 资源、持久化 | [运行时数据](docs/current/runtime-data.md) |
| 数据库表结构、schema 版本、备份/恢复版本校验 | [数据库](docs/current/database.md) |
| 人格变量、阶段文案、回复元数据 | [人格与回复](docs/current/personality.md) |
| 日志、异常、IPC、构建排查 | [工程参考](docs/current/development.md) |
| 测试规则、分层与门禁 | [测试 AGENTS](test/AGENTS.md)（规则入口与维护义务表）；命令与报告见其 [README](test/README.md)，生成与审查流程见其 [SKILL](test/SKILL.md) |
| 记忆系统设计与剩余验证 | [当前记忆](docs/current/memory.md) 与 [未完成工作与已知缺口](docs/plans/active/未完成工作与已知缺口.md) §3（B 方案契约已按当前实现归档，不再读取） |
| 主动机会、约定、回执、presence 与观察画像 | [主动陪伴](docs/current/proactive.md)、[行为画像](docs/current/behavior.md) |

完整目录见 [docs/INDEX.md](docs/INDEX.md)。当前行为由源码和对应 `docs/current/` 说明；
`plans/active/` 只维护未完成工作，`history/` 保存过去的方案与证据。

## 运行与验证

```bash
pnpm install
pnpm dev              # 完整桌面应用：暂存随包资源 → debug 构建 → 启动 target/debug/native-host
pnpm run dev:prepare  # 只做随包资源暂存（幂等；pnpm dev 已包含）
pnpm run build:harness        # 单独构建 Node Harness 产物（esbuild → packaging/dist/harness）
pnpm run test:types           # 静态检查：tsc --noEmit + cargo check（不替代运行验证）
pnpm run test:rust            # Rust 单测：cargo test --lib -p native-host
pnpm run check:bundle # 打包配置校验（秒级，不编译）
pnpm run version:set <x.y.z>  # 发版：统一三处版本号
```

- dev 与 release 的路径区分（数据根 / CONFIG / 资源根 / runtime_mode / E2E）与 dev 入口的
  组成见[工程参考](docs/current/development.md#开发环境入口)。
- **测试规则（分层、选层、纪律、门禁与报告）由测试模块自持**：[test/AGENTS.md](test/AGENTS.md)
  （规则入口与维护义务表）；命令与保留细节见其 [README](test/README.md)。本文件不重复测试域规则。
- pnpm 版本以 `package.json` 的 `packageManager` 为准；新增有构建脚本的依赖须在
  `pnpm-workspace.yaml` 的 `allowBuilds` 显式声明运行或跳过，避免干净安装失败。
- CI 分两条线：push/PR 走 `ci.yml`（双平台验证 + `bundle-config` 配置校验，不做构建）；
  tag `v*` 走 `release.yml`（双平台打包并发布到 GitHub Release）。
  发版前先跑 `pnpm run version:set <x.y.z>`，tag 与三处 version（根 `Cargo.toml`、
  `package.json`、`packaging/desktop.json`）由 CI 校验一致。
- **Rust 侧的构建产物、平台与条件编译约束由 `crates/native-host` 自持**：
  见 [native-host AGENTS](crates/native-host/AGENTS.md) §2/§3（`[profile.release]` 只能写 workspace 根、
  Windows/macOS 必须对称、本机编不出 Windows 分支的离线核对法）。本文件不重复。

## 单一真相源与模块落位

- 被 ≥2 处使用的阈值、超时、业务文件名、命令名和枚举放所属模块配置或常量；
  单函数内一次使用的字面量可内联，不为无复用逻辑增加抽象，不建大一统 constants 文件。
- 改共享接口前先查全部消费者；移动、改名或删除文件时，结合 CodeGraph 与全仓 `rg` 检查
  import、动态/字符串引用、`include_str!` / `include_bytes!`、打包资源清单、Rust 分派、
  Contract sourceFiles 和文档链接。删除后确认已无有效消费者；类型检查不能代替这项核对。
- 配置变更同步清单：YAML 运行时 CONFIG 字段新增、改名、删除，或含义、单位、默认值变化，
  必须同步 `CONFIG.yaml` → `CONFIG-DEV.yaml.example` → TS Config/getter
  → 原生设置字段表（`crates/native-host/src/ui/settings/schema.rs`，键与 CONFIG 路径一致）
  → `settings_commit` 的提交与写盘 → 刷新消费者 → 对应文档。
  不提供 UI 的字段须明确用途与修改入口，详见[配置同步清单](docs/current/runtime-data.md#配置变更同步清单)。
- 真实开发配置需单独授权，未同步须在交付时说明；不得因此跳过模板或代码同步。
  本地调参只改开发副本，不污染生产默认值；开发配置是完整文件，不是增量覆盖层。
- 目录地图只在[系统地图](docs/current/system-design.md)维护；模块内部组织由所属 AGENTS 约束。

## 跨层 IPC

- 宿主与唯一 Node 使用私有通道（非 HTTP、非浏览器 API）。改命令、事件、请求/回执、
  作用域或线协议时，在同一改动中同步 Rust 分派/协议、TS 类型/消费者与相关 Contract sourceFiles。
  参数名、类型、可选性与错误语义逐项对齐；具体接线规则分别见 services 与 native-host AGENTS。
- 新增窗口或命令时核对原生 UI 创建逻辑与窗口/许可 principal 的取用。
  类型检查不能证明命令接线、窗口行为或跨平台运行正确。

## 错误留痕

- 使用所属语言的统一日志与错误出口；不得另建平行出口或把故障伪装为成功。
  TS 的入口见 [services AGENTS](src/services/AGENTS.md#日志与错误)，Rust 的入口见
  [native-host AGENTS](crates/native-host/AGENTS.md#6-测试与日志)。
- 有意静默必须就地说明原因并指名统一留痕点；裸 `catch {}` 与只写「ignore」的注释都算违规。
  已登记的保留项使用 `[保留已登记 §4.2]` 标记，复审不重复报；既有登记已封存在
  `docs/history/implementation/前舞台修复方案-2026-09-24基线.md`，不为复审重新读取历史。

## 文档维护与提交

- 本文件是唯一全局规则入口；子目录只维护所属范围的补充约束，不复制全局条款。
  [services AGENTS](src/services/AGENTS.md) 自持 TS 业务层；
  [native-host AGENTS](crates/native-host/AGENTS.md) 自持 Rust 宿主；
  [test AGENTS](test/AGENTS.md) 自持测试域。修改跨域代码时按涉及范围读取对应入口，
  不把子目录规则自动扩大为全仓规则。其他机制与例子放对应 current 文档或源码注释。
- 所有 `CLAUDE.md` 只保留一行 `@agents.md`，引用同目录规则，不放额外正文或普通链接。
- 每轮核对 README、AGENTS、DES 和相关 current 的影响，在同一改动中更新受影响内容：
  行为→current，玩法→DES，用户入口→README，规则→所属 AGENTS，进度→未完成工作与已知缺口。
  新增/删除模块同步系统地图与导航；没有变化不为同步而追加总结。
  交付注明尚未同步或未验证部分，不能只写“已同步”。
- 方案归档前完成对照并保留正文与证据，注明日期和替代入口；归档后封存。
  问题、剩余工作和验收条件只记在《未完成工作与已知缺口.md》，条目须自包含，后续不依赖翻阅历史。
  `plans/active/` 只留未完成总表与尚在实施的目标契约，不为单一主题另开文档。
  测试结果只在检查点记录一次，注明基线、范围和未验证项；不在多个概览复制数字。
- Conventional Commits：`<type>(<scope>): <中文描述>`；不加句号，一次提交一个主题，正文解释原因。
  scope 使用模块名，跨模块可省略；破坏性变更用 `!` 与 `BREAKING CHANGE`，是否提交遵循用户授权。
  当前实现不用内部版本号命名，发布版本以 Git tag 为准；发布流程见
  [.github/workflows/README.md](.github/workflows/README.md)。
