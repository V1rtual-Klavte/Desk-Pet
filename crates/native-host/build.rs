// ==========================================
// 构建脚本：Windows 下把应用图标嵌进 exe 的资源段
// ==========================================
//
// **为什么必须在这里做**：`ui/platform/windows.rs` 按 `LoadIconW(module, 1)` 取应用图标
// （资源 ID 1，MAKEINTRESOURCE(1)），取不到就回落 `IDI_APPLICATION` —— 任务栏、Alt-Tab
// 与托盘于是全是系统默认图标。`cargo-packager` 只把图标用在安装器与快捷方式上，
// **不会**写 exe 的资源段，那一步只有编译期能做（2026-10-07 实机反馈「win 上的软件没图标」）。
//
// 图标本体由 `node scripts/make-app-ico.mjs` 从 1024 主图生成并入库
// （`resources/icons/mascot-app-icon.ico`，四个尺寸的 PNG 内嵌条目）。
//
// 刻意用 `embed-resource` 而不是 `winres`：前者只把我们给的 `.rc` 交给 rc.exe，
// 不额外注入自带 manifest —— 窗口的 DPI 感知由原生代码自己按窗口 API 处理，
// 不希望被一个隐式 manifest 覆盖成另一套口径。
//
// 非 Windows 宿主是空实现（本仓只做原生构建，不交叉编译；macOS 的图标走 .icns 与
// Info.plist，见 packaging/desktop.json）。

fn main() {
    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;

        let icon = PathBuf::from("../../resources/icons/mascot-app-icon.ico");
        println!("cargo:rerun-if-changed={}", icon.display());

        // 先把图标与 .rc 都摆到 OUT_DIR 再编译：rc.exe 解析 ICON 的路径以 .rc 所在目录
        // 为基准，写死相对路径在两种 CWD 下容易踩空，落一处固定的绝对位置最稳。
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 由 cargo 提供"));
        let staged_icon = out_dir.join("app-icon.ico");
        std::fs::copy(&icon, &staged_icon).expect("复制应用图标失败");
        let rc = out_dir.join("app-icon.rc");
        std::fs::write(&rc, "1 ICON \"app-icon.ico\"\n").expect("写 app-icon.rc 失败");

        embed_resource::compile(&rc, embed_resource::NONE);
    }
}
