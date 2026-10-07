# AGENTS.md · native-host（Rust 原生宿主）

`crates/native-host` 是**产品本体**：无 WebView / 无 Tauri runtime 的原生宿主，承载窗口与绘制、
系统能力、领域逻辑（记忆/主动/监控）、私有 IPC 与**最终执行裁决**。唯一 Node（Harness + 服务层）
由本 crate 监督器拉起。

**本文件是 Rust 侧的唯一规则入口**：类型与错误、平台与条件编译、构建产物、路径与安全边界、
IPC 命令矩阵的 Rust 半边、模块落位、测试与日志、同步义务表。
全局规则（工作范围、文档维护、提交规范、跨层同步）在[根 AGENTS.md](../../AGENTS.md)，
本文件**不重复**其内容；TS 业务规则见 [services AGENTS](../../src/services/AGENTS.md)，测试域的分层与门禁规则在 [test/AGENTS.md](../../test/AGENTS.md)。

---

## 1. 类型与错误

- **所有 `#[tauri]` 时代的命令签名已收敛为**：返回 `AppResult<T>`（`error.rs`），错误用**具体
  `AppError` 变体**；**不退回 `Result<T, String>`**，不把错误压成字符串丢信息。
- 锁中毒一律 `.unwrap_or_else(|e| e.into_inner())` 恢复，**不写 `.lock().unwrap()`** ——
  中毒时 panic 会把「某个持有者崩过」升级成「整个宿主崩」。
- `AppError` 的 `code()` 是**跨语言错误码的单一真相源**：Node 侧 `HostCommandError.code` 与它同表，
  新增变体要同步（见 §7 同步义务表）。
- 解析外部载荷（IPC 回执、线协议帧、YAML）时：**缺字段/类型不符即如实报错，不给「静默兜底值」**。
  口径样板见 `ui/ports.rs::parse_stage_profile` 顶部注释。唯一允许的例外是**显式声明为可选**
  且语义上「缺省 = 该状态」的字段（如各面板面板的 `history` 缺省），这类必须在就地注释写明理由。

## 2. 平台与条件编译

- **两平台必须对称**：改 `platform/macos*.rs` 就要同步 `platform/windows*.rs`（反之亦然），
  口径差异**就地注明**并写明为什么，不留「另一边以后再补」。
- 平台专有实现必须用 `#[cfg(target_os = "…")]` 与对应的 target 依赖分段
  （`Cargo.toml` 的 `[target.'cfg(windows)'.dependencies]` / `…macos…`），
  **不能让另一平台的编译路径引用它**。
- **本机（macOS）编不出 Windows 分支**：`cargo check --target x86_64-pc-windows-msvc` 会卡在
  bundled SQLite 的 `stdlib.h not found`（clang 需 MSVC 头文件）。所以：
  - 本机的 `cargo check` **不证明** Windows 分支；
  - 唯一权威手段是 CI 的 `verify (windows-latest)` job（真 Windows 机原生编译）；
  - 本机只能做**离线核对**：读 `~/.cargo/registry/src/*/windows-sys-0.52*` 的注册表源码逐符号
    核类型与 feature，必要时建最小 scratch crate 做类型检查。**这只能证明类型，不证明链接与运行。**
  - 交付时必须把 Windows 侧标为**未验证**。
- 新增 Windows API 时同步 `Cargo.toml` 的 `windows-sys` feature 清单（每个符号所属的 feature 不同）。

## 3. 构建与产物

- **`[profile.release]` 只能写在 workspace 根 `Cargo.toml`**：成员 crate 里的 `[profile]`
  被 Cargo **静默忽略**（只有 warning，不报错也不生效）。
- 产物体积的两个落点：release profile（根 `Cargo.toml`）与**随包资源范围**
  （`packaging/desktop.json` 的 `resources`）。加依赖前先想清楚它进不进产物。
- 依赖只开需要的 feature（`default-features = false` + 精确列表），注释写明**为什么开这些**；
  版本与 Cargo.lock 已有版本对齐，不引第二份同类实现（例如 deflate 只留 zlib-rs 一个后端）。
- **Windows exe 的两段资源由 `build.rs` 编译期嵌入，缺一不可**：图标（`1 ICON`，资源 ID 1，
  任务栏/Alt-Tab/托盘按它取）与应用清单（`1 24` = `RT_MANIFEST`，`app.manifest`）。
  清单**只为声明 Windows 8+ 兼容性** —— 舞台子窗口是 `WS_EX_LAYERED + WS_CHILD`，
  没有该声明时 `CreateWindowExW` 直接返回 NULL（实机症状：只剩蓝色空框，2026-10-07）。
  清单里**不写 DPI 段**：DPI 口径由代码的 `SetProcessDpiAwarenessContext` 设定。
  改动它们前先读 `build.rs` 顶部与 `app.manifest` 的因由注释。

## 4. 路径与安全边界

- `AppPaths`（`src/paths/mod.rs`）决定数据根；开发/生产按 **Rust 构建模式**（`cfg!(debug_assertions)`）
  区分。**不用进程环境（`NODE_ENV`、cwd）推导路径环境。**
- **Rust 命令经分派器持有的 `AppPaths` 取 base，只接收域内相对路径**（如 `stages/x.json`），
  **不加 `personality/` 等域前缀**；需要绝对路径的通用文件 API 用 `runtimePath()`。
  模块**不硬编码数据根**，也不拼带域前缀的业务路径。
- 路径命令从分派上下文取 `AppPaths` 并**校验边界**；写入目标不存在时校验父目录与符号链接风险。
  **不用 `canonicalize().unwrap_or()` 静默回退** —— 回退等于把「越界」变成「换个路径照写」。
- **`env!("CARGO_MANIFEST_DIR")` 不得用于推导业务路径**。唯一例外：
  `src/main.rs::workspace_root()`，仅 debug 构建用于定位开发工作区与随包资源，release 路径不经过它。
  （测试夹具里用它定位仓库内临时目录不算业务路径，但要在注释写明。）
- **Rust 保留最终路径裁决与 Bash 安全基线**（层 1 硬基线 + 系统路径保护 + 凭据拦截），
  **调用方不可关闭**；`bash_policy.rs` 是这块的单一实现点。
  网络边界**不得夸大为通用沙箱** —— 如实描述能力范围，别让下游以为有隔离。

## 5. 模块落位（`src/`）

| 域 | 职责 | 备注 |
|---|---|---|
| `paths/` | 数据根、域内路径拼接与校验、种子 | 路径规则的唯一实现点 |
| `host/` | 分派器、端口契约（`mod.rs`）、监督器、事件出口 | 命令矩阵的 Rust 半边在 `host/dispatch.rs` |
| `ipc/` | 线协议（信封/帧/限额）、传输、blob | 字节布局规范在 `ipc/mod.rs` 模块文档 |
| `commands/` | 命令实现（按域分子模块） | 只做域内相对路径，见 §4 |
| `ui/` | 原生 UI 域；`platform/` 是两平台实现，其余为平台无关的模型/状态/面板 | 见 §5.1 |
| `render/` | 几何核、帧循环、平台表面 | `geometry.rs` 是灵动几何的单一实现点 |
| `images/` | 解码、缩放、编码、内联预览 | 格式准入是白名单，不是黑名单 |
| `memory/` | SQLite 存储、schema、命令 | 事实与治理决定的唯一归属 |
| `proactive/` | 主动陪伴调度与存储 | |
| `monitor/` | 窗口观察（事件驱动，无轮询） | |
| `window/` | 窗口层级数值单源、系统能力 | `WindowLevel` 是层级数值的单一真相源 |
| `update/` | 更新清单、暂存、helper | |
| `audio/` | 提示音播放 | |

### 5.1 `ui/` 的硬约束

- `platform/` 下**只有平台 API 调用**，业务逻辑放平台无关模块（`chat/`、`settings/`、`editor/`、`state.rs`、
  `stage.rs`、`titlebar.rs` 等），两平台共享同一份模型 —— 不要在 `macos_chat.rs` 里写状态机。
- **`define_class!` 里自定义 target-action 必须放在裸 `impl 类名 {}` 块**：写进 `unsafe impl <协议>` 块
  会让 objc2 拿它去协议定义里核对，找不到就在**类注册期 panic**
  （`failed overriding protocol method …: method not found`）。同理，协议方法要放进**它自己的协议块**
  （`textDidChange:` 属 `NSTextDelegate`，不是 `NSTextViewDelegate`）。
- **RefCell 不得重入**：`match x.borrow().foo() { … }` 的只读借用活到**整个 match 结束**，
  分支里再 `borrow_mut()` 必 panic。先把值取出来再 match。
  在窗口过程这条路上它还会**升级成进程级崩溃**：Win32 的 `SetWindowPos` / `SendMessage` /
  `SetFocus` / `ShowWindow` 会**同步**把消息派发回本进程的窗口过程，回调里再借用就撞上
  外层尚未释放的借用；而 panic 落在 `extern "system"` 回调里无法 unwind，Rust 直接
  `abort()`（Windows 表现为 `0xC0000409` / `FAST_FAIL_FATAL_APP_EXIT`，进程静默消失）。
  **规则**：UI 状态的借用口（`windows.rs` 的 `with_ui` 与同族取用）一律用 `try_borrow_mut` /
  `try_borrow`，重入时按普通错误返回而不是 panic；只有 UI 初始化与销毁这两处一次性站点
  可以裸借用（有源码级守门测试盯着）。2026-10-07 的 Windows 启动崩溃即此路径。
- 逐帧改 CALayer 属性必须包 `CATransaction` 关掉隐式动画。
- **Node 不得驱动窗口显隐与层级**；窗口 chrome 类命令的消费者是原生 UI。

### 5.2 主题与设计稿

- 主题只提供预设，不开放改值、不跟随系统深浅色；Node 只传预设 id，色值的唯一真相源是
  `ui/theme/tokens.rs`，视觉基准是[主题设计稿](../../docs/history/design/theme-candidates.html)。
- 修改颜色、纹理或新增主题槽位，同步 tokens 与设计稿。`tokens.rs` 通过 `include_str!` 引入设计稿，
  由「设置窗槽位与设计稿逐字一致」核对；设计稿是编译期依赖，改选择器、移动或归档前核对引用。
- 纹理按需生成，只驻留当前主题用到的那张。

## 6. 测试与日志

- Rust 单测**内联**在 `src/**` 的 `#[cfg(test)] mod tests`，由 `pnpm run test:rust`
  （`cargo test --lib -p native-host`）执行。**不新建 `tests/` 目录**。
- 分层、选层、区分力判据与门禁**由测试域自持**：见 [test/AGENTS.md](../../test/AGENTS.md)。
  写断言前先过那里的自查清单 —— **编译通过不等于行为正确**。
- 测试里读仓库内文件的夹具用 `env!("CARGO_MANIFEST_DIR")` 定位到 `test/.tmp`（crate 在 `crates/native-host`，
  所以要 `../../test/.tmp`），**业务路径始终来自 `AppPaths`**。
- 日志走后缀宏：`rust_info!` / `rust_debug!` / `rust_warn!` / `rust_error!`（`macros.rs`，内核 `logger.rs`）。
  **不直接 `println!` / `eprintln!`**（Node 侧另有 `@/services/logger`）。
- 静默捕获与保留项标记遵守[全局错误留痕](../../AGENTS.md#错误留痕)，不另建留痕出口。

## 7. 同步义务表（改了什么 → 必须同步什么）

| 改动 | 必须同步 |
|---|---|
| 新增/改名/删参 `HostCommandMap` 命令 | `src/services/host/types.ts`（逐字）→ `host/dispatch.rs` 分派臂 → `docs/current/system-design.md` 的条数 → 契约 `sourceFiles` + `sourceHash` |
| `AppError` 新增/改名变体 | `code()` 字符串 → TS 侧同表的错误码 → 契约 |
| 线协议字段/帧布局（`ipc/`） | `ipc/mod.rs` 的布局注释 → Node 侧 `src/services/host/wire.ts` → 帧相关单测与契约 |
| `ui/settings/schema.rs` 字段 | [根 AGENTS 的配置同步链](../../AGENTS.md#单一真相源与模块落位) |
| 任一被契约 `sourceFiles` 引用的文件 | 该契约的 `sourceHash` 会 STALE —— 按 `test/SKILL.md` 走 `analyze → generate`，**不能只改 hash 过门禁** |
| 平台专有行为 | 另一平台对称改动 + 未验证项如实标注（见 §2） |
| 新增域 / 移动文件 | `docs/current/system-design.md` 的模块地图 + 全仓 `rg` 查 import 与字符串引用 |

## 8. 已知的坑（本机会撞到）

- 本机**没有 `timeout` 命令**（macOS）；需要限时用别的手段。
- `crates/` 整个目录当前**未被 git 跟踪**，`git stash` 对它无效；移动/删除文件前先确认可逆。
- 删文件前用 `rg` 查**字符串形式**的引用（路径常量、`include_str!`、`include_bytes!`、
  `CARGO_MANIFEST_DIR` 拼接）—— 那些 `rg "mod xxx"` 查不到。

## 9. 双端 UI 的写法（本域踩过的）

- **平台绘制适配层同分层、同命名**：`ui/theme/paint.rs`（AppKit + QuartzCore）与
  `ui/theme/paint_win.rs`（GDI）。命名一致便于对照阅读，但**不强行统一签名** ——
  强行统一会造出一个两边都不顺手的假抽象。
- **跨层搬设计要拆成原生原子**：原生没有 `box-shadow` / `linear-gradient` / `border-radius`
  的复合语义，只有「填充 + 一圈内描边 + 投影」。CSS 设计稿不要原样翻译，拆成平台能直接执行的
  原子（`ui/theme/tokens.rs` 的 `Fill` / `Bevel` / `Elevation` 三件套就是这个拆法的定型）。
- **资源能算就别打包**：噪声 PNG 几乎压不动（900×900 一张就约 2 MB），而 fBm 生成器几百行、
  磁盘零字节，还顺带保证可平铺。**可平铺的关键是格点数取整**（频率 × 边长 round 成整数，
  见 `ui/theme/noise.rs`），不是靠后期拼缝 —— 设计稿的 `stitchTiles` 是同一个道理。
- **删资源前先查 `include_bytes!` / `include_str!`**：它们让资源变成**编译期依赖**，
  而 `rg "文件名"` 查不到（路径常是拼出来的或写在别的常量里）。Profile 的 `ui/windows/*.png`
  就被三个单测编译期引用过；只按「字符串引用」判断会直接编译失败。
- **`static` 里只能调 `const fn`**：`Default::default()` 不是 const。要在 `static` 求值的类型
  加 `const NONE` 这类常量，不要为绕语法退回 `LazyLock`（平白多一层运行期初始化）。
- **进程级全局状态的测试合成一条**：`cargo test --lib` 并行跑同一二进制里的用例，
  两条各改同一全局的用例会互踩，症状是**偶发红**。要么合成一条、要么显式引入测试锁，
  不要默认「用例之间是隔离的」。
- **GDI 的两个字节序**：`COLORREF` 是 `0x00BBGGRR`（红在最末字节），DIB 像素是**自下而上**。
  这两处最容易写反，且**不会编译报错**，必须有单测钉住。
- **CF 类型不能直接进 ObjC 集合**：`NSArray::from_retained_slice::<CGColor>` 会把元素静态类型
  记成 `^{CGColor}`，而 `NSArray` 只收 ObjC 对象（`^@`）；objc2 在 `initWithObjects:count:` 上有
  **运行期**类型校验，直接 panic（崩在 objc2-foundation 的 `NSArray.rs`，编译期查不出来）。
  把指针擦成 `AnyObject` 再装（等价 ObjC 的 `@[(__bridge id)color.CGColor, …]`），
  见 `paint.rs::cg_color_array`。
- **边枚举边改集合会崩，但只有 `CALayer.sublayers` 会**：改了正在被枚举的集合，Foundation 抛
  `mutation detected during enumeration`，objc2 把它转成 Rust panic。检查在**每次 `next()`** 上，
  所以「还剩 ≥2 项时改」必炸、恰好只剩 1 项反而逃得掉 —— 别用单元素场景去验。
  `-[NSView subviews]` 返回**快照副本**、这样写是安全的；`-[CALayer sublayers]` 不是。
  同名同形不同行为，动这类循环前先确认它在哪一侧。
- **这一族只有真跑一遍才现形**：以上两条都是「编译通过、类型全对、启动即崩」。
  新增 `ui/theme/paint*.rs` 的绘制路径时，配一条**真把该路径走一遍**的单测
  （渐变要真读回 `layer.colors()`、清理要真挂上旧件再清），并**先把修复退回去看它红一次**，
  证明测试确实挡得住，而不是碰巧跟着绿。
- **非翻转 contentView + 左上原点 y 算式 = 整页垂直镜像**：macOS 窗口的 contentView 默认
  `isFlipped=false`（原点左下），而迁移代码把它当翻转坐标写（`y` 从上往下累加、`height−30`
  当"底部"）。症状是**部分元素位置错得离谱**（底部操作条跑到窗口顶）而**部分看起来正常**
  （滚动文档自洽、上下边距近似对称）。修法是**给根容器挂一只等大的 `FlippedView`**、所有
  控件经它落位（坐标系一次对齐），**不是**把单个错误 y 逐个拍回去（拍回会留下其它潜在偏移）。
- **`y = build_row(...)` 返回常量会静默叠行**：行构建函数若返回「行高」而不是「下一行 y」，
  `y =` 赋值会把第 2 行起全部叠在同一个 y（实机症状：多个「试听」按钮压在另一行的标签上）。
  行 y 的推进应收口到一个纯函数（本仓 `panel_rows_span`），行构建函数**不返回 y**（形状上杜绝再犯）。
- **分派臂测试会经生产路径改全局**：`host::dispatch` 的「全部命令都有分派臂」用例以空参真调每条命令，
  `apply_theme` 会经 `UiHandle::apply_theme` 落到 `theme::store`（不经平台端口）——与 `ui::theme`
  的驻留断言并行互踩出 **~30% 的偶发红**。凡「会动主题全局」的用例拿
  [`GLOBAL_STATE_TEST_LOCK`](src/ui/theme/mod.rs)（`STORE_TRACE` 可打印写操作轨迹定位调用者）。
  定位不到写者时不要猜：**给写入口加测试轨迹**比读代码推理快得多。
- **NSAlert 模态期被 AppKit 压到 level 8**：高层级窗口（设置 1200 / 编辑器 1500）会把确认框
  **整面盖住** + 模态吞事件 = 用户看到的「卡死」（不是死锁，`sample` 里主线程停在 `runModal`）。
  抬 alert 层级无效（实测被复位）；唯一修法是进入模态前用 `set_picker_window_level` 降三窗
  （`macos_widgets::run_modal_alert` / `with_picker_level_guard`，Drop 守卫恢复）。
  新增任何 `runModal` 站点必须过它 —— `模态调用站点不绕过降级包裹` 是源码级守门测试。
