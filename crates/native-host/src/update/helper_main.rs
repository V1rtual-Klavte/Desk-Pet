// ==========================================
// deskpet-update-helper —— 独立安装 helper 的可执行入口（W10b）
// ==========================================
//
// 这是 cargo `[[bin]]` 目标（见 crates/native-host/Cargo.toml）：与主宿主同 crate、
// **独立可执行文件**。全部替换/回滚逻辑在 `native_host::update::helper`；
// 本文件只负责进程入口与退出码。
//
// 谁拉起它：主宿主的退出序列（`update::on_host_exit` → `helper::spawn_helper`），
// 拉起的是复制到 staging 的运行副本（绝不从安装目录运行自己）。
// 什么时候动手：读到 stdin EOF（= 宿主进程已结束，OS 关闭了写端）之后。
//
// 退出码（与 helper.rs 的文件头一致）：
//   0 = 已替换并重启；1 = 失败且已回滚；2 = 没有可执行的 staged 状态；
//   3 = 失败且回滚未完成（需要人工检查）。

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    let code = native_host::update::helper::run_helper_main();
    std::process::exit(code);
}
