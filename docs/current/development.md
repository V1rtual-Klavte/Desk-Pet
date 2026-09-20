# 工程参考

用途：按需查阅构建、IPC、日志和异常实现。全局开发约束只定义在 [AGENTS](../../AGENTS.md)；配置与路径所有权见[运行时数据](runtime-data.md)。

## 构建与平台

- 前端脚本与 pnpm 版本以 [package.json](../../package.json) 为准；[CI](../../.github/workflows/ci.yml) 当前使用 Node.js 22，在 macOS 与 Windows 各跑一遍 `pnpm run test:types` 与 `pnpm run test:rust`。
- 有构建脚本的依赖由 [pnpm-workspace.yaml](../../pnpm-workspace.yaml) 的 allowBuilds 管理；已有 node_modules 的安装成功不能证明干净安装也成功。
- `pnpm dev` 仅 Vite；完整 IPC/桌面行为通过 `pnpm tauri dev` 或 Live Test 宿主运行。
- [tauri.conf.json](../../src-tauri/tauri.conf.json) 管理基础配置并默认构建 Windows NSIS；[macOS 配置](../../src-tauri/tauri.macos.conf.json) 覆盖为 app/dmg。macOS 签名、公证与 Windows 体验未完成项见[2026-09-20 收尾清单](../plans/active/2026-09-20收尾清单.md)。
- 本机 macOS 类型/编译检查不能覆盖 Windows 条件代码；Windows CI 的原生 check 与 `cargo test` 才能提供对应编译与单测证据，仍不替代 UI 验收。
- CSP 的配置解析通过不代表生产 WebView 行为通过。涉及 CSP、资源协议或窗口权限的变更需要检查构建产物中的实际行为。

## IPC 与窗口入口

Rust 命令集中在 [commands/](../../src-tauri/src/commands/)，由 [mod.rs](../../src-tauri/src/commands/mod.rs) 导出、[lib.rs](../../src-tauri/src/lib.rs) 的 invoke_handler 注册；TS 调用点通过 invoke 使用相同命令名与字段。

签名、命令名、返回错误变化应沿调用链核对，TypeScript 不会发现字符串形式的注册遗漏。路径命令持有 AppPaths，返回 AppResult；会话正文使用独立原子写命令，普通文件写入语义不被悄悄改变。

移动、改名或删除文件时，同时检查静态 import、动态加载/字符串引用、Contract 的 sourceFiles 和文档链接；入口还要检查 Vite input、capabilities 与 Rust 注册。不能因类型检查通过就断定无消费者。

新窗口涉及 HTML/TS、[Vite input](../../vite.config.ts)、Rust 创建、[capabilities](../../src-tauri/capabilities/) 和层级/聚焦行为。窗口启动共用 [bootWindow](../../src/services/boot.ts)，全局拦截先于路径和配置初始化，避免启动失败变成空白窗口。

进程级重启走 `app_restart`（[app_lifecycle.rs](../../src-tauri/src/commands/app_lifecycle.rs)）。它用 `AppHandle::request_restart()` 而不是 `restart()`：后者在调用线程就是事件循环线程时直接 `process::restart()`，**不发 `RunEvent::Exit`**，[lib.rs](../../src-tauri/src/lib.rs) 那条回收 MCP 子进程的钩子不会执行，每次重启漏下一批 npx/node。前端在 invoke 前先 `flushConfig()`——设置改动先进写盘队列，直接重启会把未落盘的配置丢掉。

## 日志

TS 入口为 [logger/index.ts](../../src/services/logger/index.ts) 的 createLogger：

```typescript
import { createLogger } from "@/services/logger"
const log = createLogger("MyModule")
log.info("状态已更新")
log.error("操作失败", error)
```

Rust 对应日志宏位于 [macros/](../../src-tauri/src/macros/)，内核是 [logger.rs](../../src-tauri/src/logger.rs)。终端、DevTools 与 data_root/logs/deskpet.log 使用本地时间，方便跨端对齐事件。

前端按时间/条数批量转发到 Rust；当前批量阈值在 logger 模块，文件大小与备份数在 Rust 日志内核。改参数直接定位这些定义，不在配置或其他模块复制常量。

生效级别由 [config.ts](../../src/services/config.ts) 的 computeLogLevel 计算：VITE_LOG_LEVEL 显式覆盖 → 前端 dev 的 debug → 生产配置值。Rust 启动时有自己的构建默认值与 DESKPET_LOG_LEVEL，前端初始化后推送统一级别。

`generalConfig.loggingLevel` 是设置读写接口；`computeLogLevel()` 是运行期派生值。保存设置时使用前者，避免把 dev 强制 debug 误写入用户 YAML。`.env.example` 给出临时日志覆盖方式。

## 异常

[error/global.ts](../../src/services/error/global.ts) 统一接收 window.onerror、unhandledrejection、Vue errorHandler 与启动异常。reportError 路径为日志 → Rust report_frontend_error → 按配置显示 DOM 覆盖层；覆盖层不依赖 Vue 挂载。

[error/format.ts](../../src/services/error/format.ts) 处理 JS Error 与 Rust `{code,message}`。formatError 用于读取错误，errorCode 用于分支，summarizeError 用于持久化脱敏摘要；裸 String(e) 会丢失结构化信息。

`general.errors.overlay` 在报错时求值：auto 为 dev 显示、生产隐藏，always/never 显式覆盖。初始化前错误也能进入同一出口。Rust [AppError](../../src-tauri/src/error.rs) 统一序列化错误，panic hook 记录位置。

## 文档与验证

测试运行/编写流程归[测试 README](../../src/services/__tests__/live/README.md)，验证边界归[testing.md](testing.md)。Rust 单测与实现同文件内联（`#[cfg(test)]`），由 `pnpm run test:rust`（`cargo test --lib`）执行，随 CI 双平台运行；它只覆盖纯 Rust 逻辑，不替代 Live Test。修改文档时检查：相对链接和锚点可达、提到的源码符号存在、当前/未来/历史状态分明、没有把旧验证或授权当作本轮结论。

目录树只由[系统地图](system-design.md)维护；配置默认值以 YAML/Config 为准，测试数字只记录在对应执行检查点。普通实现变化不要求给每份概览追加进展段落。
