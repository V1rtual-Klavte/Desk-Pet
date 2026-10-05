//! 自动和手动更新共用的原生交互；网络/安装在后台，确认在UI线程。
use crate::error::{AppError, AppResult};
use crate::host::LifecyclePort;
use crate::rust_warn;
use crate::ui::UiHandle;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

struct Interaction {
    ui: UiHandle,
    lifecycle: Arc<dyn LifecyclePort>,
}
static INTERACTION: OnceLock<Interaction> = OnceLock::new();
static CHECKING: Mutex<()> = Mutex::new(());
static STARTUP: OnceLock<()> = OnceLock::new();

pub fn install(ui: UiHandle, lifecycle: Arc<dyn LifecyclePort>) {
    if INTERACTION.set(Interaction { ui, lifecycle }).is_err() {
        rust_warn!("更新交互端口重复安装，保留本应用原始所有者");
    }
}

/// 交互编排的三类副作用。真实实现走设置窗 / UI 主线程 / LifecyclePort；
/// 单测用替身逐段盯住文案与失败语义（安装端到端仍留人工验证）。
trait UpdateInteraction {
    /// 阶段提示（设置窗通知通道；None = 清空）。
    fn notice(&self, message: Option<String>);
    /// 主线程确认对话框；返回用户是否选择「下载并安装」。
    fn confirm(&self, version: &str) -> AppResult<bool>;
    /// 重启到已 staged 的新版本。
    fn restart(&self) -> AppResult<()>;
}

/// 真实交互实现。
struct NativeUpdateInteraction<'a> {
    interaction: &'a Interaction,
}

impl UpdateInteraction for NativeUpdateInteraction<'_> {
    fn notice(&self, message: Option<String>) {
        super::settings_ui().set_notice(message);
    }

    fn confirm(&self, version: &str) -> AppResult<bool> {
        let (answer, receive) = mpsc::sync_channel(1);
        let prompt_version = version.to_owned();
        // 用户确认时间不能套用普通5s UI执行超时；任务由主线程实际执行并回传选择。
        self.interaction.ui.queue().push(Box::new(move || {
            let _ = answer.send(confirm(&prompt_version));
        }));
        receive
            .recv()
            .map_err(|_| AppError::Other("更新确认窗口已关闭（未收到用户选择）".into()))?
    }

    fn restart(&self) -> AppResult<()> {
        self.interaction.lifecycle.restart()
    }
}

/// 当前调用方在设置后台线程；返回前保留具体结果，不能用通用成功文案覆盖候选。
///
/// 每一环的失败都必须可见（中性文案，走设置窗通知通道）：检查 / 确认回传 /
/// 下载校验 / 重启失败各自带阶段前缀返回，调用方原样呈现，不伪装成成功。
pub fn check_interactive(manual: bool) -> AppResult<()> {
    let _check = CHECKING
        .try_lock()
        .map_err(|_| AppError::Other("更新检查或安装正在进行中".into()))?;
    let interaction = INTERACTION
        .get()
        .ok_or_else(|| AppError::Other("原生更新交互未初始化".into()))?;
    run_interactive(
        &|method: &str| crate::update::handle_command(method, &serde_json::json!({})),
        &NativeUpdateInteraction { interaction },
        manual,
    )
}

/// 交互编排本体（依赖注入版）：检查 → 候选提示 → 确认 → 下载校验 → 重启。
///
/// 每个阶段的失败都带各自的前缀原样上抛；重启失败额外补一条「可手动重启」的
/// 通知 —— 更新已 staged，静默丢弃会让用户以为安装失败而重来一遍。
fn run_interactive(
    run_update_command: &dyn Fn(&str) -> AppResult<serde_json::Value>,
    interaction: &dyn UpdateInteraction,
    manual: bool,
) -> AppResult<()> {
    let result = run_update_command("update_check")
        .map_err(|error| AppError::Other(format!("检查更新失败：{error}")))?;
    let Some(version) = result.get("version").and_then(serde_json::Value::as_str) else {
        if manual {
            interaction.notice(Some("已是最新版本".into()));
        }
        return Ok(());
    };
    let version = version.to_owned();
    // 候选提示只在这里设置；成功路径不覆写它（「已是最新」只在没有候选时出现）。
    interaction.notice(Some(format!("发现新版本 {version}")));
    let accepted = interaction.confirm(&version)?;
    if !accepted {
        interaction.notice(Some(format!("已暂缓更新到 {version}")));
        return Ok(());
    }
    interaction.notice(Some(format!("正在下载并校验 {version}…")));
    run_update_command("update_download_and_install")
        .map_err(|error| AppError::Other(format!("下载或校验更新失败：{error}")))?;
    interaction.notice(Some("更新已准备，正在重启…".into()));
    // 重启失败不能静默：更新已 staged，如实告知用户「可手动重启完成安装」。
    interaction.restart().map_err(|error| {
        let message = format!("更新已准备，但重启失败：{error}；可手动重启应用完成安装");
        interaction.notice(Some(message.clone()));
        AppError::Other(message)
    })
}

/// 设置页「重启」入口：与更新安装共用同一个 LifecyclePort（统一退出序列；
/// 有 staged 更新时由退出钩子拉起 helper，不自行拉起第二实例）。
pub fn request_restart() -> AppResult<()> {
    let interaction = INTERACTION
        .get()
        .ok_or_else(|| AppError::Other("重启入口未初始化（宿主启动序列未安装更新交互）".into()))?;
    interaction.lifecycle.restart()
}

pub fn schedule_startup() {
    if STARTUP.set(()).is_err() {
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("deskpet-update-autocheck".into())
        .spawn(|| {
            std::thread::sleep(Duration::from_secs(30));
            if let Err(error) = check_interactive(false) {
                rust_warn!("自动检查更新失败: {error}");
            }
        })
    {
        rust_warn!("无法调度自动更新检查: {error}");
    }
}

fn confirm(version: &str) -> AppResult<bool> {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn};
        use objc2_foundation::NSString;
        let main = MainThreadMarker::new()
            .ok_or_else(|| AppError::Other("更新确认必须在UI主线程".into()))?;
        let alert = NSAlert::new(main);
        alert.setMessageText(&NSString::from_str(&format!("发现新版本 {version}")));
        alert.setInformativeText(&NSString::from_str("下载并安装更新后，应用将重新启动。"));
        alert.addButtonWithTitle(&NSString::from_str("下载并安装"));
        alert.addButtonWithTitle(&NSString::from_str("稍后"));
        // 经统一模态入口：确认跑在 UI 主线程，若图层编辑器（level 1500）开着，
        // 裸模态会被整面盖住（AppKit 模态期弹窗固定在 level 8）= 假死。
        Ok(crate::ui::platform::macos_widgets::run_modal_alert(&alert) == NSAlertFirstButtonReturn)
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONINFORMATION, MB_YESNO,
        };
        let wide = |value: &str| {
            value
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>()
        };
        let title = wide("软件更新");
        let message = wide(&format!("发现新版本 {version}。下载并安装后重新启动？"));
        let result = unsafe {
            MessageBoxW(
                0,
                message.as_ptr(),
                title.as_ptr(),
                MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON2,
            )
        };
        if result == 0 {
            Err(AppError::Other("更新确认对话框创建失败".into()))
        } else {
            Ok(result == IDYES)
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(AppError::Other("当前平台没有更新确认窗口".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 交互替身：记录每次提示与确认/重启调用，回放预置结果。
    #[derive(Default)]
    struct FakeInteraction {
        notices: Mutex<Vec<Option<String>>>,
        /// `Some` = 预置结果，由 `confirm` 取走（每个用例只调用一次确认）。
        confirm_answer: Mutex<Option<AppResult<bool>>>,
        restart_result: Mutex<Option<AppResult<()>>>,
        confirmed_versions: Mutex<Vec<String>>,
        restart_calls: AtomicUsize,
    }

    impl FakeInteraction {
        fn notices(&self) -> Vec<String> {
            self.notices
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
                .flatten()
                .cloned()
                .collect()
        }

        fn confirmed_versions(&self) -> Vec<String> {
            self.confirmed_versions
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        }

        fn restart_calls(&self) -> usize {
            self.restart_calls.load(Ordering::SeqCst)
        }
    }

    impl UpdateInteraction for FakeInteraction {
        fn notice(&self, message: Option<String>) {
            self.notices
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(message);
        }

        fn confirm(&self, version: &str) -> AppResult<bool> {
            self.confirmed_versions
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(version.to_string());
            self.confirm_answer
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
                .expect("测试未预置确认结果")
        }

        fn restart(&self) -> AppResult<()> {
            self.restart_calls.fetch_add(1, Ordering::SeqCst);
            self.restart_result
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
                .expect("测试未预置重启结果")
        }
    }

    /// 命令替身 + 调用记录：`update_check` / `update_download_and_install` 分开回放。
    fn command_runner(
        calls: std::sync::Arc<Mutex<Vec<String>>>,
        check: AppResult<serde_json::Value>,
        download: AppResult<serde_json::Value>,
    ) -> impl Fn(&str) -> AppResult<serde_json::Value> {
        move |method: &str| {
            calls
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(method.to_string());
            match method {
                "update_check" => match &check {
                    Ok(value) => Ok(value.clone()),
                    Err(error) => Err(AppError::Other(error.to_string())),
                },
                "update_download_and_install" => match &download {
                    Ok(value) => Ok(value.clone()),
                    Err(error) => Err(AppError::Other(error.to_string())),
                },
                other => panic!("未知更新命令: {other}"),
            }
        }
    }

    fn new_calls() -> std::sync::Arc<Mutex<Vec<String>>> {
        std::sync::Arc::new(Mutex::new(Vec::new()))
    }

    #[test]
    fn 无候选时手动检查如实提示已是最新且不进入确认() {
        let calls = new_calls();
        let fake = FakeInteraction::default();
        run_interactive(
            &command_runner(calls.clone(), Ok(json!({})), Ok(json!({}))),
            &fake,
            true,
        )
        .unwrap();
        assert_eq!(fake.notices(), vec!["已是最新版本".to_string()]);
        assert!(fake.confirmed_versions().is_empty(), "没有候选不弹确认");
        assert_eq!(fake.restart_calls(), 0);
        assert_eq!(&*calls.lock().unwrap(), &["update_check".to_string()]);

        // 自动检查（manual=false）没有候选时静默成功：不占用设置窗通知。
        let calls = new_calls();
        let fake = FakeInteraction::default();
        run_interactive(
            &command_runner(calls, Ok(json!({})), Ok(json!({}))),
            &fake,
            false,
        )
        .unwrap();
        assert!(fake.notices().is_empty(), "自动检查无候选不打扰用户");
    }

    #[test]
    fn 发现候选后提示不被覆盖且暂缓不下载() {
        let calls = new_calls();
        let fake = FakeInteraction::default();
        *fake.confirm_answer.lock().unwrap() = Some(Ok(false));
        run_interactive(
            &command_runner(
                calls.clone(),
                Ok(json!({ "version": "1.2.3" })),
                Ok(json!({})),
            ),
            &fake,
            true,
        )
        .unwrap();
        assert_eq!(
            fake.notices(),
            vec![
                "发现新版本 1.2.3".to_string(),
                "已暂缓更新到 1.2.3".to_string()
            ],
        );
        assert!(
            !fake.notices().contains(&"已是最新版本".to_string()),
            "有候选时绝不出现「已是最新」，候选提示不得被通用成功文案覆盖"
        );
        assert_eq!(fake.confirmed_versions(), vec!["1.2.3".to_string()]);
        assert_eq!(
            &*calls.lock().unwrap(),
            &["update_check".to_string()],
            "暂缓后不进入下载"
        );
        assert_eq!(fake.restart_calls(), 0);
    }

    #[test]
    fn 确认后依次下载校验并重启() {
        let calls = new_calls();
        let fake = FakeInteraction::default();
        *fake.confirm_answer.lock().unwrap() = Some(Ok(true));
        *fake.restart_result.lock().unwrap() = Some(Ok(()));
        run_interactive(
            &command_runner(
                calls.clone(),
                Ok(json!({ "version": "1.2.3" })),
                Ok(json!({})),
            ),
            &fake,
            true,
        )
        .unwrap();
        assert_eq!(
            fake.notices(),
            vec![
                "发现新版本 1.2.3".to_string(),
                "正在下载并校验 1.2.3…".to_string(),
                "更新已准备，正在重启…".to_string(),
            ],
        );
        assert_eq!(
            &*calls.lock().unwrap(),
            &[
                "update_check".to_string(),
                "update_download_and_install".to_string()
            ],
        );
        assert_eq!(fake.restart_calls(), 1);
    }

    #[test]
    fn 重启失败如实报错并留下可手动重启提示() {
        // 回归：更新已 staged 时重启失败曾被静默丢弃 —— 用户既没等到重启，
        // 也看不到原因。失败必须以带阶段前缀的错误上抛，并留下通知。
        let calls = new_calls();
        let fake = FakeInteraction::default();
        *fake.confirm_answer.lock().unwrap() = Some(Ok(true));
        *fake.restart_result.lock().unwrap() = Some(Err(AppError::Other("退出序列超时".into())));
        let error = run_interactive(
            &command_runner(calls, Ok(json!({ "version": "1.2.3" })), Ok(json!({}))),
            &fake,
            true,
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("更新已准备，但重启失败"),
            "文案要点名阶段: {message}"
        );
        assert!(
            message.contains("可手动重启应用完成安装"),
            "文案要给出下一步: {message}"
        );
        assert_eq!(
            fake.notices().last().map(String::as_str),
            Some(message.as_str()),
            "重启失败不能静默丢弃：失败文案必须留在通知通道"
        );
    }

    #[test]
    fn 下载校验失败带阶段前缀且不重启() {
        let calls = new_calls();
        let fake = FakeInteraction::default();
        *fake.confirm_answer.lock().unwrap() = Some(Ok(true));
        let error = run_interactive(
            &command_runner(
                calls,
                Ok(json!({ "version": "1.2.3" })),
                Err(AppError::Other("签名校验失败".into())),
            ),
            &fake,
            true,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("下载或校验更新失败"),
            "实际: {error}"
        );
        assert_eq!(fake.restart_calls(), 0, "下载失败不得重启");
    }

    #[test]
    fn 检查失败带阶段前缀() {
        let calls = new_calls();
        let fake = FakeInteraction::default();
        let error = run_interactive(
            &command_runner(
                calls,
                Err(AppError::Other("网络不可达".into())),
                Ok(json!({})),
            ),
            &fake,
            true,
        )
        .unwrap_err();
        assert!(error.to_string().contains("检查更新失败"), "实际: {error}");
        assert!(fake.notices().is_empty(), "检查阶段失败前没有阶段提示");
    }

    #[test]
    fn 确认回传失败带阶段前缀且不下载不暂缓() {
        let calls = new_calls();
        let fake = FakeInteraction::default();
        *fake.confirm_answer.lock().unwrap() = Some(Err(AppError::Other(
            "更新确认窗口已关闭（未收到用户选择）".into(),
        )));
        let error = run_interactive(
            &command_runner(
                calls.clone(),
                Ok(json!({ "version": "1.2.3" })),
                Ok(json!({})),
            ),
            &fake,
            true,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("更新确认窗口已关闭"),
            "实际: {error}"
        );
        assert_eq!(fake.notices(), vec!["发现新版本 1.2.3".to_string()]);
        assert_eq!(
            &*calls.lock().unwrap(),
            &["update_check".to_string()],
            "确认失败不下载"
        );
    }
}
