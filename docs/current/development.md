# 工程参考

用途：按需查阅构建、IPC、日志和异常实现。全局开发约束见[根 AGENTS](../../AGENTS.md)，TS 业务约束见[services AGENTS](../../src/services/AGENTS.md)，Rust 宿主约束见[native-host AGENTS](../../crates/native-host/AGENTS.md)；配置与路径所有权见[运行时数据](runtime-data.md)。

## 构建与平台

- 前端脚本与 pnpm 版本以 [package.json](../../package.json) 为准；[CI](../../.github/workflows/ci.yml) 使用 Node.js 22，双平台门禁矩阵见「验证边界」。
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
| 数据根 | `<仓库>/data/desk-pet/` | `{用户数据目录}/com.v1rtual.deskpet/`（macOS 为 `~/Library/Application Support`；Windows 默认安装目录旁 `data/`，不可写时回退 `%LOCALAPPDATA%\com.v1rtual.deskpet`） |
| CONFIG | `<仓库>/CONFIG-DEV.yaml`（缺失回落 `<仓库>/CONFIG.yaml`） | `<数据根>/settings/CONFIG.yaml`（首启由嵌入的 `CONFIG.yaml` 模板写入） |
| 资源根 | `<仓库>/packaging/dist/`（`DEV_RESOURCE_SUBDIR`；node / harness / defaults 与打包闭包同形） | macOS：`.app/Contents/Resources/`；Windows：安装目录（与可执行文件同目录） |
| runtime_mode | `development` | `production` |
| E2E | `DESKPET_E2E=1` 且 `DESKPET_E2E_CHANNEL` 指向私有通道时走 `test/.tmp/e2e-*` 隔离根；E2E 分支仅 debug 编译 | 不编译 E2E 分支 |
| 聊天评测隔离 | `DESKPET_SIM_EVAL=1` + `DESKPET_SIM_EVAL_RUN_DIR=<仓库>/test/.tmp/sim-eval-*` 时数据根固定为 `<run>/data`，并在 Node 引导早期按 `<run>/clock.json` 安装 Node 域固定时钟；只接受 `test/.tmp` 的直接子目录和 `sim-eval-` 前缀，拒绝与 E2E 并用 | 不编译该分支 |

聊天评测隔离入口由 [scripts/sim-eval-run.mjs](../../scripts/sim-eval-run.mjs) 的 `eval prepare|start|drive|status|finish|compare|holdout|judge prepare|judge apply|review show|review spotcheck|report|stop` 使用：`prepare` 冻结授权与时钟，宿主在取得数据根单实例锁后写 `ready.json`，Node 侧核对父进程、路径同源与 `runtimeMode: development` 后才装载 fixture；`start` 核验时钟并建 attempt 开始 trace 采集，`drive` 按驱动包逐步推进并持久化进度、中断后从同一进度续跑，`finish` 收口采集并封存，`compare` 只在固定条件一致时对照 baseline 与候选，`holdout` 只报告留出使用，`judge prepare` 只对已封存完整证据冻结判分包，`judge apply` 校验独立 coding-agent judge 的裁决并追加判分，`review spotcheck` 记录用户可选的抽查意见（不改变判分），`report` 从同一证据重建四层报告；采集状态可用 [desk-pet-chat.mjs](../../scripts/desk-pet-chat.mjs) 的 `capture status|sessions` 核对。`drive` 的每个消息步骤带唯一操作身份，排队回复按 `requestId` 的 run 分支绑定；采集期间手动 `chat` 消息会被拒绝。它不是面向用户的启动方式，也不改变正常 dev 数据根。当前完成度与剩余项见[未完成工作与已知缺口 §12](../plans/active/未完成工作与已知缺口.md)。

### 打包与发布

- 怎么推、怎么发版、怎么打 tag：看 [工作流说明](../../.github/workflows/README.md)（含轻量标签必须显式推送、预发布冒烟流程、失败排查表）。
- 流水线：[ci.yml](../../.github/workflows/ci.yml)（双平台验证 + `bundle-config` 配置校验，不做构建）与 [release.yml](../../.github/workflows/release.yml)（tag `v*` 或手动触发的双平台打包发布）。
- 配置守卫：`pnpm run check:bundle`，失败项逐条给出修法；它在 release 构建之前跑，拦住版本号与 tag 分叉。
- 产物位置：CI 在 GitHub Release；本地打包 `cargo packager --release --config packaging/desktop.json --formats app,dmg`（与 release.yml 同一条链，产物落 `packaging/dist/`）。
- 发布产物三类：macOS `.dmg`（手动安装）与 `.app.tar.gz`（更新制品，helper 只接受恰好一个顶层 `.app`）；Windows `x64-setup.exe`（NSIS 静默安装）。
- 体积控制三个落点：① `[profile.release]` 只认 **workspace 根** `Cargo.toml`（成员 crate 里的 `[profile]` 会被 Cargo 忽略且不报错），本仓开 `strip`/`lto`/`codegen-units = 1`；② 打包清单是白名单 `packaging/desktop.json` 的 `resources`（node / harness / version-set / defaults），随包 Node 闭包在 `packaging/node-runtime.json` 锁定并由 `.github/scripts/stage-node.mjs` 裁剪（含 npm 自带 docs/man 与 corepack，2026-10-06 裁撤）；③ 加载期大头是随包 Node 与 `resources/defaults` 素材。
- 体积参考（2026-10-06 本机 macOS arm64 实测）：随包 Node 闭包约 121 MB（已排除 include/share 约 62 MB、npm docs/man 约 2.5 MB、corepack 约 1.2 MB）；harness `main.mjs` 2.8 MB（esbuild `--minify --keep-names`，未压缩约 5.9 MB；生产栈追踪行号可用性下降，函数名经 `--keep-names` 保留）；`resources/defaults` 约 21 MB；Rust 二进制约 1.3 MB/枚。产物名：macOS 由 `productName` 决定，Windows 安装包由主二进制名（`native-host`）决定；`productName` 与主二进制名都必须是 ASCII（中文会被 GitHub 剥掉并让更新 feed 静默缺失）。
- 发布验收：Release 资产中必须存在 `update.json`，且 `macos/aarch64` 与 `windows/x86_64` 两条 component（含 sha256 与 minisign 签名）齐备；缺一 `update-feed.mjs` 不汇总（见[工作流说明](../../.github/workflows/README.md)）。
- 签名：安装包**未做**代码签名与公证（决策暂缓，首启按 README 的 Gatekeeper/SmartScreen 提示放行）；更新 feed 的制品哈希与 minisign 签名由 CI 现场生成并验签。
- **更新取字节的网络出口**：`update/proxy.rs` 在装配时定一次代理——**环境变量 → 系统设置 → 直连**。只认环境变量是不够的：`ureq` 自己的 `Proxy::try_from_system` 名字像系统代理、实际只读 env，而 GUI App 由 launchd / Explorer 启动、拿不到 shell 的 `HTTPS_PROXY`——只靠它会让「系统设置里配了代理」的用户永远直连（2026-10-08 实机：直连 github.com 时通时不通，连测 6 次全超时而走系统代理稳定 200）。macOS 读 `SCDynamicStoreCopyProxies`，Windows 读 `WinHttpGetIEProxyConfigForCurrentUser`；**「返回了但没启用」按正常路径直连**，解析任何一步失败也退回直连、不报错。PAC / 自动检测（`ProxyAutoConfigEnable`、`fAutoDetect` / `lzAutoConfigUrl`）不解析——执行 PAC 要 JS 引擎，那种形态下同样直连（TUN / 全局 VPN 用户本来直连就是对的）。装配时留痕一条 `更新网络出口: 代理来源=…`，用户报「更新失败」先看它。
- 图标：`resources/icons/`（`mascot-app-icon.icns` 与 `mascot-app-icon-1024.png` 同一主图的两个形状 + `mascot-tray-44.png` 托盘模板图）；打包经 `desktop.json` 的 `icons`，托盘模板图另经 `include_bytes!` 编译期嵌入宿主二进制（`ui/platform/macos.rs` 的 `tray_template_image`）。
  - **macOS 必须给 `.icns`、不能只给 1024 PNG**：cargo-packager 对单个 1024×1024 PNG 会直接报 `No matching IconType`（它是 2 的整数幂、不进入缩小分支，于是按 density=1 去 `tauri-icns` 找 1024 槽位——该槽位不存在）。`.icns` 走**原样复制**分支，不经过这套启发式；`.icns` 由 `iconutil -c icns` 从 1024 主图生成（本机 `cargo packager` 已 A/B 实测：只给 PNG 复现报错，加上 `.icns` 打包通过）。
  - **Windows 仍取 PNG**：`find_ico()` 先找 `.ico`、回落到列表里的 `.png`，`.icns` 被跳过——所以列表里两者都要留。
- 常见失败：tag 与三处 version 不一致（先跑 `pnpm run version:set <x.y.z>`）；暂存缺失（`pnpm run check:bundle --require-staging` 在打包前拦）。

## IPC 与窗口入口

Rust 命令落在 [commands/](../../crates/native-host/src/commands/)（按域分子模块），由 [dispatch/](../../crates/native-host/src/host/dispatch/) 统一分派。命令名与参数/结果形状是两侧共用的 schema：Rust 分派臂与 TS 的 [`HostCommandMap`](../../src/services/host/types.ts) 必须逐字一致，TS 调用点经 `getHostBridge().request(...)` 使用同一套名字。

签名、命令名、返回错误变化应沿调用链核对，TypeScript 不会发现字符串形式的注册遗漏。路径命令持有 AppPaths，返回 AppResult；会话正文使用独立原子写命令，普通文件写入语义不被悄悄改变。

移动、改名或删除文件时，同时检查静态 import、动态加载/字符串引用、Contract 的 sourceFiles 和文档链接；入口还要检查 Vite input、capabilities 与 Rust 注册。不能因类型检查通过就断定无消费者。

新窗口**全部由 Rust 原生创建**（[`ui/platform/`](../../crates/native-host/src/ui/platform/) 与 `ui/window`），没有 HTML/TS 入口、没有 Vite input、没有 capabilities 清单；窗口层级的数值单源在 `ui/window/platform.rs` 的 `WindowLevel`。Node 侧领域引导在 [`@/services/init`](../../src/services/init.ts)，路径与配置初始化先于其余引导。

进程级重启走设置窗的「重启」入口（[`ui/settings/updates.rs`](../../crates/native-host/src/ui/settings/updates.rs) 的 `request_restart` → `LifecyclePort::restart()`），与更新安装**共用同一个退出序列**：MCP/Bash 子进程回收与 Node flush 都由退出钩子完成，不另起第二实例。重启前先把未落盘的配置写盘——有草稿先提交，提交失败就不重启（文案可见），避免把未落盘的设置丢掉。

开发模式（debug 构建）下 `app_restart` 与打包版走同一条 `lifecycle.restart()`：有暂存更新时交给 update helper，否则先拉起新实例再退出当前进程；不再依赖 `pnpm tauri dev`，也不重载主窗口。

## 日志

TS 入口为 [logger/index.ts](../../src/services/logger/index.ts) 的 createLogger：

```typescript
import { createLogger } from "@/services/logger"
const log = createLogger("MyModule")
log.info("状态已更新")
log.error("操作失败", error)
```

Rust 对应日志宏位于 [macros.rs](../../crates/native-host/src/macros.rs)，内核是 [logger.rs](../../crates/native-host/src/logger.rs)。终端与 data_root/logs/deskpet.log 使用本地时间，方便跨端对齐事件。

**崩溃兜底留痕（2026-10-07）**：`main()` 最先安装 panic hook，把 panic 写进**系统临时目录**的 `v1rtual-desk-pet-crash.log`（Windows 上即 `%TEMP%`；`logger::crash_log_path()`），同时写一份进常规日志。刻意**不落数据根**——早期失败（路径解析、种子）发生时数据根可能还没建起来。这条兜底是必需的而非锦上添花：release 的 Windows 构建是窗口子系统、没有控制台，Rust 默认的 panic 输出（stderr）**无声丢失**；而 panic 一旦发生在 `extern "system"` 回调（窗口过程）里就无法 unwind，直接 `abort()`，用户端表现为「闪退且什么都没有」。

前端按时间/条数批量转发到 Rust（`logger::emit_frontend` → 终端 + 文件双出口）；当前批量阈值在 logger 模块，文件大小与备份数在 Rust 日志内核。改参数直接定位这些定义，不在配置或其他模块复制常量。

**Node 日志单一出口（2026-10-07）**：TS 侧 `createLogger` **不再同时写进程 console** —— 集成运行时子进程的 stdout/stderr 归监督器的 stdio 采集器采集，console 那一路会被二次采集，同一条日志进文件两次。stdio 采集器保留，给裸 stderr / 崩溃输出兜底；转发失败仍由 logger 模块里唯一的 console 调用兜底（[保留已登记 §4.2]）。Rust 侧沿用 `DESKPET_LOG_LEVEL` / 构建默认级别；为定位跟随卡顿加的 `[诊断·*]` 临时探针与「主线程任务队列清空」逐条留痕已随定位结束删除。

**绘制期失败回落不逐条留痕（2026-10-08）**：Windows 绘制路径里「逐控件 / 逐帧」的失败回落——角区创建与差集失败、按钮底重放回落、小图形覆盖率位图失败、圆角区域被系统拒绝、气泡 / 盒体与卡片底板 / 设置字段的圆角、浮层重画失败——一律**就地注释说明后静默**，不再发 `rust_warn!`。判据是频率面：它们随每次重绘成比例放大，而回落分支本身已自证失败；保留的是窗口 / 初始化级的**一次性**失败警告（主窗圆角与系统边框、透明度提交、顶栏字体创建、RichEdit 装载、编辑器初始化、设置滚动面、聊天窗口补绘）。新增绘制期失败分支按同口径处理，不要退回逐条 warn；`paint_win::apply_round_region` 的失败留痕属本批被删的一员，它的历史结论见 [native-host AGENTS](../../crates/native-host/AGENTS.md#9-双端-ui-的写法本域踩过的)。

生效级别由 [config.ts](../../src/services/config.ts) 的 computeLogLevel 计算：开发模式一律 debug → 生产配置值。开发模式的判据是宿主运行模式端口（Node = ServerWelcome、旧壳 = Vite 构建模式，见 [host/ports.ts](../../src/services/host/ports.ts)），不再是 `import.meta.env`；`.env` 的 VITE_* 覆写已随端口化删除（运行期调参走 CONFIG/开发配置）。Rust 启动时有自己的构建默认值与 DESKPET_LOG_LEVEL，前端初始化后推送统一级别。引导期在 `runDomainBootstrap` 的 `initConfig()` 之后立即应用（`applyLogLevel()`）：`computeLogLevel()` 需要真实运行模式与已加载配置，不应用则 logger 停在保守默认 `info`，主动链路的 debug 证据整段丢失；刻意不放进 `initConfig()` 内部——它被多个 L2 用例直接调用，放进去会给每次调用加一次 `set_log_config` 下行请求与噪声。领域引导序列用例断言引导后 `getLogLevel() === computeLogLevel()`。下发失败只 `log.debug` 留痕、不阻断启动：后果是两端过滤级别不一致，Rust 侧按其构建默认值过滤（根因留痕在 `applyLogLevel`，T4.41）。

`generalConfig.loggingLevel` 是设置读写接口；`computeLogLevel()` 是运行期派生值。保存设置时使用前者，避免把 dev 强制 debug 误写入用户 YAML。

## 异常

[error/global.ts](../../src/services/error/global.ts) 统一接收 window.onerror、unhandledrejection、Vue errorHandler 与启动异常。reportError 路径为日志 → Rust report_frontend_error → 按配置显示 DOM 覆盖层；覆盖层不依赖 Vue 挂载。覆盖层 `auto` 的 dev 判据来自宿主运行模式端口（不再是 `import.meta.env`）；Node 宿主没有 DOM 时只保留内存条目、不渲染（日志与上报照走）。「复制详情」用临时 textarea + `execCommand`，避免在 Node 领域闭包里出现 `navigator.` 字面量。

[error/format.ts](../../src/services/error/format.ts) 处理 JS Error 与 Rust `{code,message}`。formatError 用于读取错误，errorCode 用于分支，summarizeError 用于持久化脱敏摘要；裸 String(e) 会丢失结构化信息。

失败分类的唯一定义点是 [error/failure-kind.ts](../../src/services/error/failure-kind.ts)：生产回合（[turn-failure.ts](../../src/services/engine/harness/turn-failure.ts) 以 `classifyTurnFailure` 名字 re-export）与 Live Test 的场景失败分类共用同一条正则表，状态码按独立数字匹配，测试侧只在结果落到 `unknown` 时叠加自己的 `configuration` 档。`admission` 由调用点写入（回合准入拒绝、lane 结构操作在飞），不来自文案分类。

`general.errors.overlay` 在报错时求值：auto 为 dev 显示、生产隐藏，always/never 显式覆盖。初始化前错误也能进入同一出口。Rust [AppError](../../crates/native-host/src/error.rs) 统一序列化错误，panic hook 记录位置。

音效由 [audio/registry.ts](../../src/services/audio/registry.ts) 按事件分配选择预设，经 [synth.ts](../../src/services/audio/synth.ts) 编译 WAV，再通过 `audio_play_wav` 交给原生宿主播放。编译或播放失败经 `reportError` 留痕，不把音效副作用失败当成已接受消息的发送失败；设置试听按既有调用入口呈现错误。

有意静默的判据与保留项标记由[全局错误留痕](../../AGENTS.md#错误留痕)规定；TS 的日志、错误分类与进程异常出口见[services AGENTS](../../src/services/AGENTS.md#日志与错误)。本节只描述实现入口，不另存一份规则。

## 验证边界

运行时验证以 [Live Test 使用规范](../../test/README.md) 为权威入口；代码代理对 Contract 和 Scene 的分析、生成、审查流程以 [Live Test Skill](../../test/SKILL.md) 为准。本节只说明当前验证的边界，不记录历史通过次数、旧报告或完整命令清单。

### 验证层次

- **Live Test（L4）** 在真实**原生宿主**（`crates/native-host`，debug + `DESKPET_E2E=1` 隔离模式）上运行：真实 Node 业务代码、真实 Rust IPC、运行时状态和临时数据根；场景由宿主的唯一 Node 子进程（`test/e2e` Scene runner）驱动，不经 WebView。它按 Scene 的入口选择真实 Provider、fake Provider 或无模型的 unit 断言；这些入口的含义及命令见 Live README。
- **类型与编译检查**只证明 TypeScript/Rust 的静态可构建性，不能替代 Live Test 的状态、IPC、Provider 或工具链验证。
- **Rust 单测**（`pnpm run test:rust`，即 `cargo test --lib -p native-host`，与实现同文件内联的 `#[cfg(test)]`）覆盖 Bash 策略、路径校验、工具许可、Node 监督器（握手/崩溃代际/关停）、以及真实 SQLite 治理与 trace 文件追加、重试和恢复。它们不启动原生宿主 UI，不验证宿主 IPC 与 Provider 接线；release 存储基准需显式执行。
- **CI** 在 macOS 和 Windows 执行编译级检查（`tsc --noEmit` + `cargo check`）、Rust 单测与快层 L2 / L3（经重试入口 `scripts/run-vitest-with-retry.mjs`，附测试纪律扫描与 FLAKY 棘轮）；另有 `check:contract-hashes` 与 bundle-config 静态守卫（均为秒级、不编译；后者检查版本号与打包配置一致性）。L4 Live Test 不在 CI 中运行。Windows 的运行时交互仍须在支持的桌面环境中验证。

### Contract 门禁

每个当前模块 Contract 都以 `sourceFiles` 和 `sourceHash` 绑定源码版本。源码改变后必须重新分析受影响 Contract，补齐或调整关联 Scene；空 hash、过期 hash、无效 caseId 引用和严格覆盖缺口都不能作为通过证据。Scene runner 的启动预检会校验 `sourceHash`，并拒绝绕过启动脚本直接起宿主时缺失的契约证明（该 Contract 记为 stale）。

严格模式同时检查：

- `coverage.scenarios` 引用已发现的 **caseId**，并与模块和 `contractId` 匹配；
- Contract 声明的边界、错误要求由实际 Scene tag 满足；已经迁入 L2/L3 的判据由对应 caseId 与层级关联验证，不强制重复制造 L4 场景；
- 除显式且有理由的 `unitOnly` 外，每个 Contract 至少有一个非 unit 场景；
- 全量 L4 收尾时执行三层 caseId 对账（声明/实现/跨层唯一），过滤运行不做该对账。

通过结果只证明当次配置、Provider 与已覆盖 Scene 下的行为；真实模型下的记忆召回质量、记忆库的资源开销、未覆盖的平台路径与尚未接通的规划能力不能由已有场景推断为已验证（记忆模块已有 L4 `memory-store-lifecycle` 等确定性场景，它们证明协议与存储，不证明模型效果）。

线路、记忆质量与资源开销分别有独立评测入口，格式和命令见[测试 README](../../test/README.md#trace记忆质量与性能门禁)。线路完整性检查与用户理想稿的独立 AI 审阅分开；理想稿只由用户编写。记忆原始采集不能代替 gold 双人审计与校准 judge 盲审。性能分列 release 原生存储、debug 宿主 IPC 和进程树样本（须覆盖 native-host + 唯一 Node 及其子进程），不能冒充真实 UI 首显或完整产品 RSS。

外部记忆基准（memory-bench：LongMemEval / LoCoMo / MemoryBank cn）是**质量对照的主口径**（观测性证据，与自建 80 题物理隔离）；**门禁保持现状**——CI 与 `test:release` 不跑评测集（最多冒烟级自检），完整分层在本机跑通后再发布；自建 80 题只作兜底冒烟与治理语义回归。数据集文件不进仓库：版本锁（固定 revision + SHA-256、许可原文、判分移植代码）在 git，数据由 `pnpm run test:memory-bench:prepare [-- --data-dir <目录>]` 装进开发者指定的 data-dir（默认 `test/memory-bench/.data/`，可弃缓存），运行期不下载。判分为官方脚本/模板的自适配移植（LoCoMo 用异构 LLM judge 的语义正确率，不用官方词面 F1；LongMemEval judge 必须异构于被测模型，官方 `evaluate_qa.py` 链保留），报告口径为 `source: external` / `status: observational`、不设质量阈值；运行方法、口径差异与非商用许可约束见 [memory-bench/README](../../test/memory-bench/README.md)。

### 聊天评测数据集

`test/ideal-traces/suites/<suiteId>/` 的结构化聊天用例（`suite.json` / `cases/` / `fixtures/` / `approvals/`，schema v4）与旧格式 `.ideal.md` 线路稿分开治理：前者允许代理起草 silver，只有用户按当前哈希绑定真实会话消息审批的用例才是 gold；唯一写审批入口是 `dataset approve`，只接受用户本人给出的真实来源、拒绝覆盖并回读标签。实际输出不能充当期望来源，驱动包不包含题型、探针、oracle、检查点、证据与评分。case 是可跨会话的场景容器，探针逐条绑定驱动步骤、题型、难度与已登记 rubric，带 `required` / `forbidden` 与 `critical` 标记，用户消息轮数不设上限；只有 rubric 声明需要时才写 `expectation`（内容词表、频率、时间关系、主语别名与跨会话来源），未知或多余字段直接失败。题型注册表固定 7 族 24 型，并要求每个产品分类至少被一个题型覆盖；case 的 `questionTypes` 必须恰好等于探针题型的并集。fixture 必须声明 `loading`：`direct-seed` 只预置初始状态、待测行为仍走真实消息链，`real-chain` 禁止同时 seed 会话或记忆；`fixed` 时钟要求每个驱动步骤带升序 `at`；runner 会写入 `clock.json` 并在宿主 Node 引导早期推进 Node 域 `Date`，Rust 调度器、OS 文件时间与跨进程时间戳仍是真实时间。探针窗口限定 driver 步骤，`difficulty`（1–5）只用于报告分层。需要真实交付的 case 可声明 `deliverables`（`id`／`role`／数据根内相对路径／可选字节上限，需 `tools` 能力），配 `artifact` 窗口与 `delivery.artifact-exists`／`delivery.artifact-content`（或不带期望的 `chat.delivery-acknowledged`）；交付路径只进 oracle 绑定，不进驱动包。消息步骤可用 `{{dataRoot}}` 占位符（驱动包装载时保留、发送时渲染）；声明 `precondition.toolApproval: "allow-once"` 时驱动在消息在飞期间单槽确认一次，未声明时同样轮询但一律拒绝（需要工具的请求只能在对话里作答）；被测模型在回合里反问用户时驱动轮询提问通道并一律取消（结构化评测没有真人可答，取消后模型只能按已有信息作答）。两类应答记录都随进度持久化，同一回合被拒超过三次以 `driver.confirm-loop`、连续取消超过三次以 `driver.question-loop` 中止，都不让交互把回合挂到消息超时。当前候选、消息／探针数量、题型与难度分布以 `dataset list`／`dataset review` 输出为准；其他套件为空占位。

三个 Skill 分工：`desk-pet-chat` 负责真实聊天与自由定性评测，`desk-pet-eval-authoring` 负责起草用例并收集用户审批，`desk-pet-eval-runner` 负责结构化执行、独立 judge 判分与报告。结构化探针全部由独立 coding-agent judge 按冻结判分包判定；结构化用例只评可核对的结果，不评价语气、分泡或拟人化，运行默认关闭拟人化（合成 CONFIG `ai.humanizer.enabled=false`，分泡会改写句数与长度观感），需要测拟人化链路时显式 `--humanizer`，修复沿用原运行开关。judge 与被测模型必须异构并记录平台／模型／prompt 版本；runner 只冻结判分包、按取证窗口派生精简读取件（`judge view`，判定要求与原包一致、权威仍是原包哈希）、校验裁决与聚合，不调用模型、不读取 judge 凭据。用户抽查可选、不阻塞，也不改变自动判分。数据集支持 `direct-seed`／`real-chain` 装载、Node 域固定时钟、隔离运行、驱动／续跑、同条件 `compare`、`holdout` 记录与 `--repair-of` 修复 attempt。封存时按声明把交付产物复制为只读证据并逐项记录 delivered／missing／oversized／invalid（符号链接与越界路径拒绝采集，异常不改证据完整性）；判分包携带产物封存状态与受限内容（单文件 4 KiB、整包 16 KiB，超限截断、二进制或哈希不符只保留原因）以及 `deliverable:<id>` 证据引用。当前候选、最近运行与剩余验收项见[未完成工作与已知缺口 §12](../plans/active/未完成工作与已知缺口.md)；实施批次与历史验收证据见[聊天评测闭环执行契约（归档）](../history/implementation/聊天评测闭环执行契约-2026-10-26归档.md)。

公开通用评测复用上述聊天评测链，适配目录位于 `test/sim/desk-pet-chat/external/`。命令、固定数据规模、来源与许可限制见[演练说明](../../test/sim/README.md)；本节只保留边界：安装与连接沿用聊天评测的隔离运行，所有导入仍为 silver、gold 沿用真实用户审批，Desk-Pet 报告标作外部适配观测，不进入 CI／发布评测。

### 未验证边界

- 恢复中断运行时「MCP 不可用 → 显式提示」的异常路径：无法由现有场景直接验证，缺的是**前提不可构造**——它要求中断运行里待重放的工具是 `mcp_*` 且其服务器本次借不到（`pendingInterruptedToolNames` 与本次能力准备的 `unavailableMcp` 取交集），而构造该前提需要「曾借用过 mcp_* 工具的中断运行 + 届时借不到的服务器」两个条件同时成立：现有场景只有前者（`MCP真IPC假server` 已连真 stdio 脚本服务器并完成借用→发现→调用），`MCP大结果回读` 仅在传输边界替换 `callTool`，未构造后者。这条失败不是「只存在于界面呈现」：运行入口先 `appendAssistantMessage` 落成普通助手条目（`stopReason: "stop"`，读模型可见），再把它作为 `reply` 返回，观测面存在。代理由 `runtime-resume-capability-prep` 覆盖：恢复路径确实重新执行能力准备（Skill 目录在恢复后可用），且会话里不落上游「Tool … is unavailable」通用文案。

仍存缺口记录在[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md)。

## 文档维护

测试运行/编写流程归[测试 README](../../test/README.md)，验证边界见本页「验证边界」。修改文档时检查：相对链接和锚点可达、提到的源码符号存在、当前/未来/历史状态分明、没有把旧验证或授权当作本轮结论。

目录树只由[系统地图](system-design.md)维护；配置默认值以 YAML/Config 为准，测试数字只记录在对应执行检查点。普通实现变化不要求给每份概览追加进展段落。
