# 工程参考

用途：按需查阅构建、IPC、日志和异常实现。全局开发约束见[根 AGENTS](../../AGENTS.md)，TS 业务约束见[services AGENTS](../../src/services/AGENTS.md)，Rust 宿主约束见[native-host AGENTS](../../crates/native-host/AGENTS.md)；配置与路径所有权见[运行时数据](runtime-data.md)。

## 构建与平台

- 前端脚本与 pnpm 版本以 [package.json](../../package.json) 为准；[CI](../../.github/workflows/ci.yml) 当前使用 Node.js 22，在 macOS 与 Windows 各跑一遍 `pnpm run test:types` 与 `pnpm run test:rust`。
- 有构建脚本的依赖由 [pnpm-workspace.yaml](../../pnpm-workspace.yaml) 的 allowBuilds 管理；已有 node_modules 的安装成功不能证明干净安装也成功。
- 依赖树只读：`node_modules/**` 一律不写，调试插桩进业务代码或临时分支，不修改安装副本。曾有依赖包安装副本被手改注入 `__diag`/`hgdiag` 调试插桩（源项 HN-10），检测命令：`rg -n "__diag|hgdiag" node_modules/.pnpm/@earendil-works+pi-agent-core@*/node_modules/@earendil-works/pi-agent-core/dist/`，0 命中为正常。恢复步骤（顺序不可换）：

  ```bash
  rm -rf node_modules/.pnpm/@earendil-works+pi-agent-core@0.85.1_ws@8.21.3
  pnpm install --frozen-lockfile
  rm -rf node_modules/.vite
  ```

  最后一步必须做：`.vite/deps` 的失效键是 lockfile/config 摘要，不感知依赖文件被改；依赖安装或缓存失效会重新预打包，要么把插桩打进 bundle（每次 assistant 结束写 localStorage），要么在打包器作用域摊平不成立时于 `observer.end` 直接 `ReferenceError`。若第二步输出 `Already up to date` 而副本未恢复（pnpm 只比对状态摘要，不检查 `.pnpm` 目录是否完整），先删 `node_modules/.pnpm-workspace-state-v1.json` 再重跑同一命令。本约束只落文档、不加 CI 检查（CI 只跑双平台 `test:types`/`test:rust`，grep `node_modules` 的检查价值低且易漏），裁定理由见[前舞台修复方案](../history/implementation/前舞台修复方案-2026-09-24基线.md) §10。
- 打包基础配置由 [packaging/desktop.json](../../packaging/desktop.json) 管理（binaries 与 resources 清单），配置守卫 `pnpm run check:bundle`。macOS 签名、公证与 Windows 体验未完成项见[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md)。
- 本机 macOS 类型/编译检查不能覆盖 Windows 条件代码；Windows CI 的原生 check 与 `cargo test` 才能提供对应编译与单测证据，仍不替代 UI 验收。
- CSP 的配置解析通过不代表生产 WebView 行为通过。涉及 CSP、资源协议或窗口权限的变更需要检查构建产物中的实际行为。

### 开发环境入口

```bash
pnpm dev              # 暂存随包资源 → cargo build（debug）→ 启动 target/debug/native-host
pnpm run dev:prepare  # 只做资源暂存；已就绪时幂等跳过（pnpm dev 已包含）
```

`dev:prepare`（[scripts/dev-prepare.mjs](../../scripts/dev-prepare.mjs)）做三件事：按
[packaging/node-runtime.json](../../packaging/node-runtime.json) 的锁定版本暂存随包 Node（同版本跳过，
不重复下载）、跑 `build:harness`、在 dev 资源根建 `defaults` 符号链接（Windows 为目录 junction）
指回 [resources/defaults](../../resources/defaults)。`pnpm dev` 随后执行
`cargo build -p native-host --bin native-host` 并运行产物；多出的参数原样转交宿主
（如 `pnpm dev -- --smoke`）。debug 宿主的数据根是 `data/desk-pet/`。

dev 资源根（debug 构建下 `node` / `harness` / `defaults` 的解析根）只在
[crates/native-host/src/main.rs](../../crates/native-host/src/main.rs) 的 `DEV_RESOURCE_SUBDIR`
定义一次；`dev-prepare` 从该常量派生路径并核验暂存产物落在其中（对不上直接报错并指名同步点）。
打包路径不经过 `packaging/dist/defaults`（[packaging/desktop.json](../../packaging/desktop.json)
的 resources 直接取 `../resources/defaults`），符号链接不影响产物。

dev 与 release 的路径区分：

| 维度 | dev（debug 构建） | release（打包产物） |
|---|---|---|
| 数据根 | `<仓库>/data/desk-pet/` | `{用户数据目录}/com.v1rtual.deskpet/`（macOS 为 `~/Library/Application Support`，Windows 为 `%LOCALAPPDATA%`） |
| CONFIG | `<仓库>/CONFIG-DEV.yaml`（缺失回落 `<仓库>/CONFIG.yaml`） | `<数据根>/settings/CONFIG.yaml`（首启由嵌入的 `CONFIG.yaml` 模板写入） |
| 资源根 | `<仓库>/packaging/dist/`（`DEV_RESOURCE_SUBDIR`；node / harness / defaults 与打包闭包同形） | macOS：`.app/Contents/Resources/`；Windows：安装目录（与可执行文件同目录） |
| runtime_mode | `development` | `production` |
| E2E | `DESKPET_E2E=1` 且 `DESKPET_E2E_CHANNEL` 指向私有通道时走 `test/.tmp/e2e-*` 隔离根；E2E 分支仅 debug 编译 | 不编译 E2E 分支 |

### 打包与发布

- 怎么推、怎么发版、怎么打 tag：看 [工作流说明](../../.github/workflows/README.md)（含轻量标签必须显式推送、预发布冒烟流程、失败排查表）。
- 流水线：[ci.yml](../../.github/workflows/ci.yml)（双平台验证 + `bundle-config` 配置校验，不做构建）与 [release.yml](../../.github/workflows/release.yml)（tag `v*` 或手动触发的双平台打包发布）。
- 配置守卫：`pnpm run check:bundle`，失败项逐条给出修法；它在 release 构建之前跑，拦住版本号与 tag 分叉。
- 产物位置：CI 在 GitHub Release；本地打包 `cargo packager --release --config packaging/desktop.json --formats app,dmg`（与 release.yml 同一条链，产物落 `packaging/dist/`）。
- 发布产物三类：macOS `.dmg`（手动安装）与 `.app.tar.gz`（更新制品，helper 只接受恰好一个顶层 `.app`）；Windows `x64-setup.exe`（NSIS 静默安装）。
- 体积控制三个落点：① `[profile.release]` 只认 **workspace 根** `Cargo.toml`（成员 crate 里的 `[profile]` 会被 Cargo 忽略且不报错），本仓开 `strip`/`lto`/`codegen-units = 1`；② 打包清单是白名单 `packaging/desktop.json` 的 `resources`（node / harness / version-set / defaults），随包 Node 闭包在 `packaging/node-runtime.json` 锁定并由 `.github/scripts/stage-node.mjs` 裁剪（含 npm 自带 docs/man 与 corepack，2026-10-06 裁撤）；③ 加载期大头是随包 Node 与 `resources/defaults` 素材。
- 体积参考（2026-10-06 本机 macOS arm64 实测）：随包 Node 闭包约 121 MB（已排除 include/share 约 62 MB、npm docs/man 约 2.5 MB、corepack 约 1.2 MB）；harness `main.mjs` 2.8 MB（esbuild `--minify --keep-names`，未压缩约 5.9 MB；生产栈追踪行号可用性下降，函数名经 `--keep-names` 保留）；`resources/defaults` 约 21 MB；Rust 二进制约 1.3 MB/枚。产物名由 `productName` 决定，**必须是 ASCII**（中文会被 GitHub 剥掉并让更新 feed 静默缺失）。
- 发布验收：Release 资产中必须存在 `update.json`，且 `macos/aarch64` 与 `windows/x86_64` 两条 component（含 sha256 与 minisign 签名）齐备；缺一 `update-feed.mjs` 不汇总（见[工作流说明](../../.github/workflows/README.md)）。
- 签名：安装包**未做**代码签名与公证（决策暂缓，首启按 README 的 Gatekeeper/SmartScreen 提示放行）；更新 feed 的制品哈希与 minisign 签名由 CI 现场生成并验签。
- 图标：`resources/icons/`（`mascot-app-icon.icns` 与 `mascot-app-icon-1024.png` 同一主图的两个形状 + `mascot-tray-44.png` 托盘模板图）；打包经 `desktop.json` 的 `icons`，托盘模板图另经 `include_bytes!` 编译期嵌入宿主二进制（`ui/platform/macos.rs` 的 `tray_template_image`）。
  - **macOS 必须给 `.icns`、不能只给 1024 PNG**：cargo-packager 对单个 1024×1024 PNG 会直接报 `No matching IconType`（它是 2 的整数幂、不进入缩小分支，于是按 density=1 去 `tauri-icns` 找 1024 槽位——该槽位不存在）。`.icns` 走**原样复制**分支，不经过这套启发式；`.icns` 由 `iconutil -c icns` 从 1024 主图生成（本机 `cargo packager` 已 A/B 实测：只给 PNG 复现报错，加上 `.icns` 打包通过）。
  - **Windows 仍取 PNG**：`find_ico()` 先找 `.ico`、回落到列表里的 `.png`，`.icns` 被跳过——所以列表里两者都要留。
- 常见失败：tag 与三处 version 不一致（先跑 `pnpm run version:set <x.y.z>`）；暂存缺失（`pnpm run check:bundle --require-staging` 在打包前拦）。

## IPC 与窗口入口

Rust 命令落在 [commands/](../../crates/native-host/src/commands/)（按域分子模块），由 [dispatch.rs](../../crates/native-host/src/host/dispatch.rs) 统一分派。命令名与参数/结果形状是两侧共用的 schema：Rust 分派臂与 TS 的 [`HostCommandMap`](../../src/services/host/types.ts) 必须逐字一致，TS 调用点经 `getHostBridge().request(...)` 使用同一套名字。

签名、命令名、返回错误变化应沿调用链核对，TypeScript 不会发现字符串形式的注册遗漏。路径命令持有 AppPaths，返回 AppResult；会话正文使用独立原子写命令，普通文件写入语义不被悄悄改变。

移动、改名或删除文件时，同时检查静态 import、动态加载/字符串引用、Contract 的 sourceFiles 和文档链接；入口还要检查 Vite input、capabilities 与 Rust 注册。不能因类型检查通过就断定无消费者。

新窗口**全部由 Rust 原生创建**（[`ui/platform/`](../../crates/native-host/src/ui/platform/) 与 `ui/window`），没有 HTML/TS 入口、没有 Vite input、没有 capabilities 清单；窗口层级的数值单源在 `ui/window/platform.rs` 的 `WindowLevel`。Node 侧领域引导在 [`@/services/init`](../../src/services/init.ts)，路径与配置初始化先于其余引导。

进程级重启走设置窗的「重启」入口（[`ui/settings/updates.rs`](../../crates/native-host/src/ui/settings/updates.rs) 的 `request_restart` → `LifecyclePort::restart()`），与更新安装**共用同一个退出序列**：MCP/Bash 子进程回收与 Node flush 都由退出钩子完成，不另起第二实例。重启前先把未落盘的配置写盘——有草稿先提交，提交失败就不重启（文案可见），避免把未落盘的设置丢掉。

开发模式（debug 构建）下 `app_restart` 不走进程重启，改为关闭其他窗口并重载主窗口：`pnpm tauri dev` 的 CLI 把 app 当子进程，子进程一退出就结束整个 dev 会话并关掉 Vite，`process::restart()` 拉起的孤儿进程没有页面可加载，只剩一个空白窗口（终端 Ctrl+C 也因 CLI 已退出而失效）。重载后前端从零 boot，设置同样从磁盘重新读取；打包版仍走真进程重启。

## 日志

TS 入口为 [logger/index.ts](../../src/services/logger/index.ts) 的 createLogger：

```typescript
import { createLogger } from "@/services/logger"
const log = createLogger("MyModule")
log.info("状态已更新")
log.error("操作失败", error)
```

Rust 对应日志宏位于 [macros.rs](../../crates/native-host/src/macros.rs)，内核是 [logger.rs](../../crates/native-host/src/logger.rs)。终端、DevTools 与 data_root/logs/deskpet.log 使用本地时间，方便跨端对齐事件。

**崩溃兜底留痕（2026-10-07）**：`main()` 最先安装 panic hook，把 panic 写进**系统临时目录**的 `v1rtual-desk-pet-crash.log`（Windows 上即 `%TEMP%`；`logger::crash_log_path()`），同时写一份进常规日志。刻意**不落数据根**——早期失败（路径解析、种子）发生时数据根可能还没建起来。这条兜底是必需的而非锦上添花：release 的 Windows 构建是窗口子系统、没有控制台，Rust 默认的 panic 输出（stderr）**无声丢失**；而 panic 一旦发生在 `extern "system"` 回调（窗口过程）里就无法 unwind，直接 `abort()`，用户端表现为「闪退且什么都没有」。

前端按时间/条数批量转发到 Rust；当前批量阈值在 logger 模块，文件大小与备份数在 Rust 日志内核。改参数直接定位这些定义，不在配置或其他模块复制常量。

生效级别由 [config.ts](../../src/services/config.ts) 的 computeLogLevel 计算：开发模式一律 debug → 生产配置值。开发模式的判据是宿主运行模式端口（Node = ServerWelcome、旧壳 = Vite 构建模式，见 [host/ports.ts](../../src/services/host/ports.ts)），不再是 `import.meta.env`；`.env` 的 VITE_* 覆写已随端口化删除（运行期调参走 CONFIG/开发配置）。Rust 启动时有自己的构建默认值与 DESKPET_LOG_LEVEL，前端初始化后推送统一级别。引导期在 `runDomainBootstrap` 的 `initConfig()` 之后立即应用（`applyLogLevel()`）：`computeLogLevel()` 需要真实运行模式与已加载配置，不应用则 logger 停在保守默认 `info`，主动链路的 debug 证据整段丢失；刻意不放进 `initConfig()` 内部——它被多个 L2 用例直接调用，放进去会给每次调用加一次 `set_log_config` 下行请求与噪声。领域引导序列用例断言引导后 `getLogLevel() === computeLogLevel()`。下发失败只 `log.debug` 留痕、不阻断启动：后果是两端过滤级别不一致，Rust 侧按其构建默认值过滤（根因留痕在 `applyLogLevel`，T4.41）。

`generalConfig.loggingLevel` 是设置读写接口；`computeLogLevel()` 是运行期派生值。保存设置时使用前者，避免把 dev 强制 debug 误写入用户 YAML。

## 异常

[error/global.ts](../../src/services/error/global.ts) 统一接收 window.onerror、unhandledrejection、Vue errorHandler 与启动异常。reportError 路径为日志 → Rust report_frontend_error → 按配置显示 DOM 覆盖层；覆盖层不依赖 Vue 挂载。覆盖层 `auto` 的 dev 判据来自宿主运行模式端口（不再是 `import.meta.env`）；Node 宿主没有 DOM 时只保留内存条目、不渲染（日志与上报照走）。「复制详情」用临时 textarea + `execCommand`，避免在 Node 领域闭包里出现 `navigator.` 字面量。

[error/format.ts](../../src/services/error/format.ts) 处理 JS Error 与 Rust `{code,message}`。formatError 用于读取错误，errorCode 用于分支，summarizeError 用于持久化脱敏摘要；裸 String(e) 会丢失结构化信息。

失败分类的唯一定义点是 [error/failure-kind.ts](../../src/services/error/failure-kind.ts)：生产回合（runtime.ts 以 `classifyTurnFailure` 名字 re-export）与 Live Test 的场景失败分类共用同一条正则表，状态码按独立数字匹配，测试侧只在结果落到 `unknown` 时叠加自己的 `configuration` 档。`admission` 由调用点写入（回合准入拒绝、lane 结构操作在飞），不来自文案分类。

`general.errors.overlay` 在报错时求值：auto 为 dev 显示、生产隐藏，always/never 显式覆盖。初始化前错误也能进入同一出口。Rust [AppError](../../crates/native-host/src/error.rs) 统一序列化错误，panic hook 记录位置。

音效由 [audio/registry.ts](../../src/services/audio/registry.ts) 按事件分配选择预设，经 [synth.ts](../../src/services/audio/synth.ts) 编译 WAV，再通过 `audio_play_wav` 交给原生宿主播放。编译或播放失败经 `reportError` 留痕，不把音效副作用失败当成已接受消息的发送失败；设置试听按既有调用入口呈现错误。

有意静默的判据与保留项标记由[全局错误留痕](../../AGENTS.md#错误留痕)规定；TS 的日志、错误分类与进程异常出口见[services AGENTS](../../src/services/AGENTS.md#日志与错误)。本节只描述实现入口，不另存一份规则。

## 文档与验证

测试运行/编写流程归[测试 README](../../test/README.md)，验证边界归[testing.md](testing.md)。Rust 单测与实现同文件内联（`#[cfg(test)]`），由 `pnpm run test:rust`（`cargo test --lib`）执行，随 CI 双平台运行；它只覆盖纯 Rust 逻辑，不替代 Live Test。修改文档时检查：相对链接和锚点可达、提到的源码符号存在、当前/未来/历史状态分明、没有把旧验证或授权当作本轮结论。

目录树只由[系统地图](system-design.md)维护；配置默认值以 YAML/Config 为准，测试数字只记录在对应执行检查点。普通实现变化不要求给每份概览追加进展段落。
