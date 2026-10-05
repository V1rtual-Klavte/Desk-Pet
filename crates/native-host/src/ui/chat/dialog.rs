//! 通用提示对话框（旧壳 `AppDialog.vue` 的宿主侧承接）。
//!
//! 迁移背景：旧壳由 `services/dialog` 挂起请求、`AppDialog.vue` 渲染「标题 +
//! 一句话 + 详情 + 一键复制」；原生迁移后这两个 .vue 面都不存在，聊天面的失败
//! 只剩一条几秒自动收起的 notice 行 —— 出错详情（可能是较长的远端/传输错误）
//! 用户拿不到、也复制不了。本模块把这条能力补回原生宿主：
//!
//! - **协议**：调用方只构造 [`DialogSpec`]（标题 / 一句话结论 / 可选详情），不碰平台；
//! - **呈现**：平台实现见 `platform/{macos,windows}_chat.rs::show_dialog`
//!   （macOS `NSAlert` / Windows 自建模态窗），详情存在即显示为可选中区域
//!   并提供「复制」按钮（复制详情原文）；
//! - **线程**：任何线程可调用；主线程调用即时弹出（模态到用户关闭），
//!   工作线程经既有主线程队列转投（UI 未启动时留痕跳过，不伪造弹出）。
//!
//! 旧壳 `detail` 与 `copyText` 两个字段在全部真实调用里恒为同一段文本，
//! 这里收成 `detail` 一个字段：有详情就有复制，避免第二个定义点。

use super::ui::chat_ui;

/// 一条提示的内容：一句话结论 + 可选详情（详情 = 复制目标）。
#[derive(Clone, Debug)]
pub struct DialogSpec {
    /// 标题（macOS 为 alert 主文案；Windows 为窗口标题）。
    pub title: String,
    /// 一句话结论（中性系统文案，不写角色台词）。
    pub message: String,
    /// 补充详情（错误原文、完整路径等）；存在即显示并可一键复制。
    pub detail: Option<String>,
}

/// 弹一个提示；用户关闭后返回（主线程即时弹出，其他线程转投主线程）。
pub fn show(spec: DialogSpec) {
    chat_ui().show_dialog(spec);
}

/// 失败提示：详情显示为可选中区域，并提供「复制」按钮复制详情原文。
pub fn show_failure(title: &str, message: &str, detail: &str) {
    show(DialogSpec {
        title: title.to_owned(),
        message: message.to_owned(),
        detail: Some(detail.to_owned()),
    });
}
