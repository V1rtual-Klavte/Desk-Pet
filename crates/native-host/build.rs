// ==========================================
// 构建脚本：Windows 下把应用图标与应用清单嵌进 exe 的资源段
// ==========================================
//
// **为什么必须在这里做**：
// 1. 图标：`ui/platform/windows.rs` 按 `LoadIconW(module, 1)` 取应用图标（资源 ID 1，
//    MAKEINTRESOURCE(1)），取不到就回落 `IDI_APPLICATION` —— 任务栏、Alt-Tab 与托盘
//    于是全是系统默认图标。`cargo-packager` 只把图标用在安装器与快捷方式上，
//    **不会**写 exe 的资源段（2026-10-07 实机反馈「win 上的软件没图标」）。
// 2. 应用清单（RT_MANIFEST / 资源 ID 1）：舞台子窗口是 `WS_EX_LAYERED + WS_CHILD`，
//    而分层**子**窗口只在清单声明了 Windows 8+ 兼容性时才可用 —— 没有清单时
//    `CreateWindowExW` 直接返回 NULL（实机症状：只剩一个蓝色空框，2026-10-07）。
//    清单内容与完整因由见同目录 `app.manifest`。
//
// 图标本体由 `node scripts/make-app-ico.mjs` 从 1024 主图生成并入库
// （`resources/icons/mascot-app-icon.ico`，四个尺寸的 PNG 内嵌条目）。
//
// 刻意用 `embed-resource` 而不是 `winres`：前者只把我们给的 `.rc` 交给 rc.exe，
// 清单由我们自己写（只有兼容性声明，**不含 DPI 段**）—— 窗口的 DPI 感知仍由原生代码
// `SetProcessDpiAwarenessContext` 按窗口 API 处理，不被任何隐式 manifest 覆盖口径。
//
// 非 Windows 宿主是空实现（本仓只做原生构建，不交叉编译；macOS 的图标走 .icns 与
// Info.plist，见 packaging/desktop.json）。

fn main() {
    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;

        let icon = PathBuf::from("../../resources/icons/mascot-app-icon.ico");
        let manifest = PathBuf::from("app.manifest");
        println!("cargo:rerun-if-changed={}", icon.display());
        println!("cargo:rerun-if-changed={}", manifest.display());

        // 先把图标、清单与 .rc 都摆到 OUT_DIR 再编译：rc.exe 解析相对路径以 .rc 所在
        // 目录为基准，写死相对路径在两种 CWD 下容易踩空，落一处固定的绝对位置最稳。
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 由 cargo 提供"));
        std::fs::copy(&icon, out_dir.join("app-icon.ico")).expect("复制应用图标失败");
        std::fs::copy(&manifest, out_dir.join("app.manifest")).expect("复制应用清单失败");
        let rc = out_dir.join("app.rc");
        // `1 ICON` = 图标资源（ID 1）；`1 24` = RT_MANIFEST（ID 1 = 进程清单）。
        std::fs::write(&rc, "1 ICON \"app-icon.ico\"\n1 24 \"app.manifest\"\n")
            .expect("写 app.rc 失败");

        // `CompilationResult` 标了 `#[must_use]`（Windows 构建日志里原有一条 unused 告警）；
        // 它只是编译产物路径，失败本身会 panic（内部 `compile_impl` 的 expect），忽略安全。
        let _ = embed_resource::compile(&rc, embed_resource::NONE);
    }
}
