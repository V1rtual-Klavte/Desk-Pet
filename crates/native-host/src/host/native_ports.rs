//! 原生宿主的宿主能力端口实现（W4 补齐）。
//!
//! 本模块是原生宿主的端口实现：业务侧（`commands/**`）只经 trait 取用能力，
//! 不建第二份判定：
//!
//! - [`NativeAssetScope`]：受控资源读取授权。**不是**「任意路径可读」的空壳 ——
//!   授权时逐路径跑既有 `AppPaths::validate_file_path`（存在性 + 凭据 + 记忆保护 +
//!   允许根），授权后才进进程内白名单，读取方只能经 [`NativeAssetScope::is_allowed`]
//!   查询；`profiles` 根在启动时整目录授权（见 `main.rs` 启动序列）。
//! - [`NativeFileDialog`]：原生文件对话框。macOS 走 `NSOpenPanel` / `NSSavePanel`
//!   （AppKit 只能在 UI 主线程调用 → 经 [`UiHandle::queue`] 投递主线程并等待；
//!   对话框的等待时长由用户决定，故不走 5s 超时的 `run_on_main`）；Windows 走
//!   系统通用对话框 `GetOpenFileNameW` / `GetSaveFileNameW`（windows-sys 0.52 的
//!   `IFileOpenDialog` 只有 `*mut c_void` 别名、无 vtable 绑定，通用对话框是同一
//!   系统组件的可用绑定；在专用线程上打开，不需要消息循环）。
//! - [`NativeLifecycle`]：退出/重启接到 W5 的统一退出序列（[`ExitOnceHook`] 包装
//!   宿主注入的 `HostExitHook`，保证 MCP/Bash/Node/更新 helper 只收尾一次）。
//!
//! 线程纪律：文件对话框与退出都可能在 IPC 分派线程上被调用；macOS 的 AppKit 调用
//! 一律经 UI 主线程队列执行，Windows 的通用对话框在自己的专用线程上打开。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::host::{AssetScopePort, FileDialogPort, LifecyclePort};
use crate::paths::AppPaths;
use crate::rust_warn;
use crate::ui::{HostExitHook, UiHandle};

/// 打开原生文件对话框时等待用户的时间上限（用户取消/确认都会提前结束等待）。
///
/// 这不是「对话框自己的超时」：到点只放弃本线程的等待并如实报 `TIMEOUT`，
/// 主线程上的对话框仍由用户正常关闭（迟到回执按归宿丢弃）。
const FILE_DIALOG_WAIT: Duration = Duration::from_secs(600);

// ==========================================
// AssetScopePort：受控资源读取授权
// ==========================================

/// 原生宿主的受控资源通道授权表。
///
/// 「原生 UI 读取本地图片前必须经这里放行」的白名单：授权只发生在业务命令完成
/// 原路径校验之后（`validate_chat_images` / `save_screenshot` / 启动时的 profiles
/// 整目录授权），白名单本身对路径再跑一次 `AppPaths::validate_file_path`，
/// 不引入「任意路径」捷径。
#[derive(Default)]
pub struct NativeAssetScope {
    files: Mutex<HashSet<PathBuf>>,
    /// `(目录, 是否递归)`；非递归目录只放行直接子项。
    dirs: Mutex<Vec<(PathBuf, bool)>>,
}

impl NativeAssetScope {
    pub fn new() -> Self {
        Self::default()
    }

    /// 查询一个路径是否已被授权读取。消费方（原生查看器 / 内联预览）在读取本地图片
    /// 前查询这里；未授权即拒绝，不自动补授权。
    pub fn is_allowed(&self, path: &Path) -> bool {
        // 白名单里存的是 canonical 形态；查询方可能给词法路径，解析失败即按词法比较
        // （拒绝是默认归宿，解析失败不会把路径变成「已授权」）。
        let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if self
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&resolved)
        {
            return true;
        }
        self.dirs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|(dir, recursive)| {
                if *recursive {
                    resolved.starts_with(dir)
                } else {
                    resolved.parent() == Some(dir.as_path())
                }
            })
    }

    pub fn file_count(&self) -> usize {
        self.files.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl AssetScopePort for NativeAssetScope {
    fn allow_file(&self, path: &Path) -> AppResult<()> {
        let canonical = AppPaths::validate_file_path(path)?;
        if !canonical.is_file() {
            return Err(AppError::Tool("资源授权只接受常规文件".into()));
        }
        self.files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(canonical);
        Ok(())
    }

    fn allow_directory(&self, path: &Path, recursive: bool) -> AppResult<()> {
        let canonical = AppPaths::validate_file_path(path)?;
        if !canonical.is_dir() {
            return Err(AppError::Tool("资源目录授权只接受目录".into()));
        }
        let mut dirs = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
        let entry = (canonical, recursive);
        if !dirs.contains(&entry) {
            dirs.push(entry);
        }
        Ok(())
    }
}

// ==========================================
// FileDialogPort：原生文件对话框
// ==========================================

/// 原生文件对话框实现。macOS 需要 UI 主线程（AppKit 纪律），Windows 不需要。
pub struct NativeFileDialog {
    ui: UiHandle,
}

impl NativeFileDialog {
    pub fn new(ui: UiHandle) -> Self {
        Self { ui }
    }

    /// 在 UI 主线程执行对话框并等待结果；UI 未启动时如实报错（不静默串行兜底）。
    ///
    /// 不用 `UiHandle::run_on_main`：那条路径的 5s 超时是给引擎派发用的，
    /// 文件对话框的等待时长由用户决定。这里同样经主线程队列投递与唤醒，但用
    /// 对话框自己的等待上限。
    fn run_on_main_blocking<T, F>(&self, job: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> AppResult<T> + Send + 'static,
    {
        if self.ui.is_main_thread() {
            return job();
        }
        if !self.ui.queue().has_waker() {
            return Err(AppError::Other(
                "原生 UI 尚未启动，无法打开文件对话框".into(),
            ));
        }
        let (tx, rx) = std_mpsc::sync_channel(1);
        self.ui.queue().push(Box::new(move || {
            let _ = tx.send(job());
        }));
        rx.recv_timeout(FILE_DIALOG_WAIT)
            .map_err(|_| AppError::Timeout)?
    }
}

impl FileDialogPort for NativeFileDialog {
    fn pick_images(&self) -> AppResult<Vec<String>> {
        #[cfg(target_os = "macos")]
        {
            return self.run_on_main_blocking(|| macos_panel::open_panel(true, IMAGE_EXTENSIONS));
        }
        #[cfg(windows)]
        {
            let _ = &self.ui;
            return windows_panel::open_files("图片", &IMAGE_EXTENSIONS, true);
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Err(AppError::Other("原生宿主只支持 macOS 与 Windows".into()))
        }
    }

    fn pick_file(&self) -> AppResult<Option<String>> {
        #[cfg(target_os = "macos")]
        {
            return self.run_on_main_blocking(|| {
                Ok(macos_panel::open_panel(false, IMAGE_EXTENSIONS)?
                    .into_iter()
                    .next())
            });
        }
        #[cfg(windows)]
        {
            let _ = &self.ui;
            return Ok(windows_panel::open_files("图片", &IMAGE_EXTENSIONS, false)?
                .into_iter()
                .next());
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Err(AppError::Other("原生宿主只支持 macOS 与 Windows".into()))
        }
    }

    fn pick_file_filtered(&self, label: &str, extensions: &[&str]) -> AppResult<Option<String>> {
        if extensions.is_empty() {
            // 调用方（分派臂）已挡住空列表；这里兜底不静默换成「全部文件」。
            return Err(AppError::Config("文件选择器需要非空的扩展名列表".into()));
        }
        #[cfg(target_os = "macos")]
        {
            // macOS 的 NSOpenPanel 只用扩展名做过滤（没有 Windows 的过滤器标签位）。
            let _ = label;
            // 闭包要求 'static：扩展名转为 owned 后在主线程内借用。
            let owned: Vec<String> = extensions
                .iter()
                .map(|value| (*value).to_string())
                .collect();
            return self.run_on_main_blocking(move || {
                let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
                Ok(macos_panel::open_panel(false, &refs)?.into_iter().next())
            });
        }
        #[cfg(windows)]
        {
            let _ = &self.ui;
            return Ok(windows_panel::open_files(label, extensions, false)?
                .into_iter()
                .next());
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = label;
            Err(AppError::Other("原生宿主只支持 macOS 与 Windows".into()))
        }
    }

    fn save_file(
        &self,
        suggested_name: &str,
        filter_label: &str,
        extension: &str,
    ) -> AppResult<Option<String>> {
        #[cfg(target_os = "macos")]
        {
            let suggested_name = suggested_name.to_string();
            let _ = filter_label;
            let extension = extension.to_string();
            return self.run_on_main_blocking(move || {
                macos_panel::save_panel(&suggested_name, &extension)
            });
        }
        #[cfg(windows)]
        {
            let _ = &self.ui;
            return windows_panel::save_file(suggested_name, filter_label, extension);
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (suggested_name, filter_label, extension);
            Err(AppError::Other("原生宿主只支持 macOS 与 Windows".into()))
        }
    }
}

/// `pick_chat_images` 的过滤器（扩展名集合固定，覆盖全部准入格式）。
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

// ── macOS：NSOpenPanel / NSSavePanel（只在 UI 主线程调用）──

#[cfg(target_os = "macos")]
mod macos_panel {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel, NSSavePanel};
    use objc2_foundation::{NSArray, NSString};

    use crate::error::{AppError, AppResult};

    pub(super) fn open_panel(multiple: bool, extensions: &[&str]) -> AppResult<Vec<String>> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| AppError::Other("文件对话框必须在 UI 主线程打开".into()))?;
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setAllowsMultipleSelection(multiple);
        panel.setCanChooseFiles(true);
        panel.setCanChooseDirectories(false);
        let types: Vec<_> = extensions
            .iter()
            .map(|extension| NSString::from_str(extension))
            .collect();
        #[allow(deprecated)]
        // setAllowedFileTypes 在 macOS 12 起被 UTType 取代；本宿主不引入 UniformTypeIdentifiers
        panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&types)));
        // 经降级包裹：编辑器/设置窗被抬到 1200/1500 层，而 NSOpen/SavePanel 模态期
        // 是 level 8 —— 不降层时面板会被整面盖住（表现同「假死」，见
        // `with_picker_level_guard` 的根因注释）。
        if crate::ui::platform::macos_widgets::with_picker_level_guard(
            &crate::ui::MainThreadPort,
            || panel.runModal(),
        ) != NSModalResponseOK
        {
            return Ok(Vec::new()); // 用户取消是正常结果
        }
        let mut paths = Vec::new();
        for url in panel.URLs().iter() {
            if let Some(path) = url.path() {
                paths.push(path.to_string());
            }
        }
        Ok(paths)
    }

    pub(super) fn save_panel(suggested_name: &str, extension: &str) -> AppResult<Option<String>> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| AppError::Other("文件对话框必须在 UI 主线程打开".into()))?;
        let panel = NSSavePanel::savePanel(mtm);
        panel.setNameFieldStringValue(&NSString::from_str(suggested_name));
        panel.setCanCreateDirectories(true);
        let types = [NSString::from_str(extension)];
        #[allow(deprecated)]
        panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&types)));
        // 同 `open_panel`：存储/打开面板也须先降三窗层级（模态期被压 level 8）。
        if crate::ui::platform::macos_widgets::with_picker_level_guard(
            &crate::ui::MainThreadPort,
            || panel.runModal(),
        ) != NSModalResponseOK
        {
            return Ok(None); // 用户取消是正常结果
        }
        Ok(panel
            .URL()
            .and_then(|url| url.path())
            .map(|path| path.to_string()))
    }
}

// ── Windows：系统通用对话框（专用线程上打开，不需消息循环）──

#[cfg(windows)]
mod windows_panel {
    use std::mem::size_of;

    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, GetSaveFileNameW, OFN_ALLOWMULTISELECT, OFN_EXPLORER, OFN_FILEMUSTEXIST,
        OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW, WM_COMMAND};

    use crate::error::{AppError, AppResult};

    /// 系统对话框的路径缓冲：单文件名上限（32k 字符）之外还要容纳多选列表。
    const FILE_BUFFER_UNITS: usize = 64 * 1024;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `"标签\0*.png;*.jpg\0\0"` 形式（Windows 过滤器协议）。
    fn filter_block(label: &str, extensions: &[&str]) -> Vec<u16> {
        let pattern = extensions
            .iter()
            .map(|extension| format!("*.{extension}"))
            .collect::<Vec<_>>()
            .join(";");
        let mut block = Vec::new();
        block.extend(label.encode_utf16());
        block.push(0);
        block.extend(pattern.encode_utf16());
        block.push(0);
        block.push(0);
        block
    }

    fn main_window() -> isize {
        // 与 ui/platform/windows.rs 的 MAIN_CLASS 同名（对话框挂在主窗之上）。
        unsafe { FindWindowW(wide("DeskPetMainWindow").as_ptr(), std::ptr::null()) }
    }

    pub(super) fn open_files(
        label: &str,
        extensions: &[&str],
        multiple: bool,
    ) -> AppResult<Vec<String>> {
        let extensions: Vec<String> = extensions.iter().map(|value| value.to_string()).collect();
        let label = label.to_string();
        run_on_dialog_thread(move || {
            let filter = filter_block(
                &label,
                &extensions.iter().map(String::as_str).collect::<Vec<_>>(),
            );
            let mut buffer = vec![0u16; FILE_BUFFER_UNITS];
            let mut spec: OPENFILENAMEW = unsafe { std::mem::zeroed() };
            spec.lStructSize = size_of::<OPENFILENAMEW>() as u32;
            spec.hwndOwner = main_window();
            spec.lpstrFilter = filter.as_ptr();
            spec.lpstrFile = buffer.as_mut_ptr();
            spec.nMaxFile = buffer.len() as u32;
            spec.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
            if multiple {
                spec.Flags |= OFN_ALLOWMULTISELECT;
            }
            if unsafe { GetOpenFileNameW(&mut spec) } == 0 {
                return Ok(Vec::new()); // 取消（或错误，一律按空结果；用户无感）
            }
            Ok(parse_multi_selection(&buffer))
        })
    }

    pub(super) fn save_file(
        suggested_name: &str,
        filter_label: &str,
        extension: &str,
    ) -> AppResult<Option<String>> {
        let suggested_name = suggested_name.to_string();
        let filter_label = filter_label.to_string();
        let extension = extension.to_string();
        run_on_dialog_thread(move || {
            let filter = filter_block(&filter_label, &[extension.as_str()]);
            let def_ext = wide(&extension);
            let mut buffer = vec![0u16; FILE_BUFFER_UNITS];
            for (index, unit) in suggested_name.encode_utf16().enumerate() {
                if index + 1 < buffer.len() {
                    buffer[index] = unit;
                }
            }
            let mut spec: OPENFILENAMEW = unsafe { std::mem::zeroed() };
            spec.lStructSize = size_of::<OPENFILENAMEW>() as u32;
            spec.hwndOwner = main_window();
            spec.lpstrFilter = filter.as_ptr();
            spec.lpstrDefExt = def_ext.as_ptr();
            spec.lpstrFile = buffer.as_mut_ptr();
            spec.nMaxFile = buffer.len() as u32;
            spec.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
            if unsafe { GetSaveFileNameW(&mut spec) } == 0 {
                return Ok(None); // 用户取消
            }
            Ok(Some(c_string_lossy(&buffer)))
        })
    }

    /// 通用对话框在专用线程上打开并阻塞该线程直到用户操作完毕。
    fn run_on_dialog_thread<T, F>(job: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> AppResult<T> + Send + 'static,
    {
        std::thread::Builder::new()
            .name("deskpet-file-dialog".into())
            .spawn(job)
            .map_err(|error| AppError::Other(format!("文件对话框线程创建失败: {error}")))?
            .join()
            .map_err(|_| AppError::Other("文件对话框线程异常结束".into()))?
    }

    /// OFN_EXPLORER 多选布局：`目录\0名称1\0名称2\0\0`；单选布局是完整路径 + 单 NUL。
    fn parse_multi_selection(buffer: &[u16]) -> Vec<String> {
        let directory = read_unit(buffer, 0);
        if directory.is_empty() {
            return Vec::new();
        }
        let mut names = Vec::new();
        let mut offset = directory.len() + 1;
        loop {
            let name = read_unit(buffer, offset);
            if name.is_empty() {
                break;
            }
            names.push(name);
            offset += name.len() + 1;
        }
        if names.is_empty() {
            // 没有第二段 = 单选：第一段就是完整路径。
            vec![directory]
        } else {
            let base = std::path::PathBuf::from(directory.replace('/', "\\"));
            names
                .into_iter()
                .map(|name| base.join(name).to_string_lossy().into_owned())
                .collect()
        }
    }

    fn read_unit(buffer: &[u16], offset: usize) -> String {
        let slice = &buffer[offset.min(buffer.len())..];
        let end = slice
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(slice.len());
        String::from_utf16_lossy(&slice[..end])
    }

    fn c_string_lossy(buffer: &[u16]) -> String {
        read_unit(buffer, 0)
    }

    // 主窗口在退出序列里要用到的命令号（与 ui/platform/windows.rs 的 CMD_QUIT 同值）。
    pub(super) const QUIT_COMMAND: usize = 1002;

    /// 托盘「退出」的同一入口：给主窗发 CMD_QUIT，由 UI 线程走完整退出序列。
    pub(super) fn post_quit_message() -> bool {
        let hwnd = main_window();
        if hwnd == 0 {
            return false;
        }
        unsafe { PostMessageW(hwnd, WM_COMMAND, QUIT_COMMAND, 0) != 0 }
    }
}

// ==========================================
// LifecyclePort：统一退出序列
// ==========================================

/// 只跑一次的退出钩子包装。
///
/// 平台侧（托盘「退出」→ `HostExitHook::run`）与命令侧（`app_restart` →
/// [`LifecyclePort`]）可能先后到达；`ServiceExitHook` 内的 `update::on_host_exit`
/// 拉起 helper 不是幂等动作，用本包装保证收尾只发生一次。
pub struct ExitOnceHook {
    inner: Arc<dyn HostExitHook>,
    ran: AtomicBool,
}

impl ExitOnceHook {
    pub fn new(inner: Arc<dyn HostExitHook>) -> Self {
        Self {
            inner,
            ran: AtomicBool::new(false),
        }
    }

    /// 显式只跑一次（命令侧调用）。
    pub fn run_once(&self) {
        if !self.ran.swap(true, Ordering::SeqCst) {
            self.inner.run();
        }
    }

    #[cfg(test)]
    pub(crate) fn has_run(&self) -> bool {
        self.ran.load(Ordering::SeqCst)
    }
}

impl HostExitHook for ExitOnceHook {
    fn run(&self) {
        self.run_once();
    }
}

/// 原生宿主的退出/重启实现：先走统一退出序列，再请求平台终止事件循环。
///
/// - macOS：主线程 `NSApplication terminate:`（经 `will_terminate` 再兜一次退出
///   序列，本包装保证只跑一次）；UI 未启动（`--smoke`/E2E）时直接 `process::exit`。
/// - Windows：给主窗发托盘退出同款 `WM_COMMAND`，由 UI 线程完成 teardown 后退出；
///   没有主窗时直接 `process::exit`。
///
/// `code` 语义：平台优雅退出路径固定以 0 结束（AppKit/消息循环的既有行为）；
/// 请求非 0 退出码时在退出序列完成后直接 `process::exit(code)`（如实执行调用方
/// 的退出码，不伪报）。
pub struct NativeLifecycle {
    ui: UiHandle,
    exit_once: Arc<ExitOnceHook>,
}

impl NativeLifecycle {
    pub fn new(ui: UiHandle, exit_once: Arc<ExitOnceHook>) -> Self {
        Self { ui, exit_once }
    }

    fn quit(&self, code: i32) {
        self.exit_once.run_once();
        if code != 0 {
            std::process::exit(code);
        }
        #[cfg(target_os = "macos")]
        {
            let result = self.ui.run_on_main(|| -> AppResult<()> {
                let Some(mtm) = objc2::MainThreadMarker::new() else {
                    return Err(AppError::Other("退出请求不在 UI 主线程".into()));
                };
                objc2_app_kit::NSApplication::sharedApplication(mtm).terminate(None);
                Ok(())
            });
            let outcome = match result {
                Ok(inner) => inner,
                Err(error) => Err(error),
            };
            if let Err(error) = outcome {
                // UI 未启动（smoke/E2E）或主线程队列不可达：退出序列已完成，直接结束进程。
                rust_warn!("优雅退出路径不可用（{error}），直接结束进程");
                std::process::exit(0);
            }
        }
        #[cfg(windows)]
        {
            if !windows_panel::post_quit_message() {
                rust_warn!("主窗口不存在，退出序列完成后直接结束进程");
                std::process::exit(0);
            }
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = &self.ui;
            std::process::exit(0);
        }
    }
}

impl LifecyclePort for NativeLifecycle {
    fn exit(&self, code: i32) {
        self.quit(code);
    }

    fn restart(&self) -> AppResult<()> {
        // 有 staged 更新时，退出序列会拉起 helper（替换安装目录并自动重启），
        // 此时**不能**再自行拉起新实例，否则新旧两份进程并存。
        use crate::update::UpdatePort as _;
        let staged = crate::update::runtime()
            .ok()
            .and_then(|runtime| runtime.install_state().ok().flatten())
            .is_some_and(|state| state.phase == crate::update::stage::InstallPhase::Staged);
        if !staged {
            spawn_new_instance()?;
        }
        self.quit(0);
        Ok(())
    }
}

/// 拉起本应用的新实例（分离进程；顺序固定为「先起新进程再退出」）。
fn spawn_new_instance() -> AppResult<()> {
    let exe = std::env::current_exe()
        .map_err(|error| AppError::Other(format!("解析可执行文件路径失败: {error}")))?;
    #[cfg(target_os = "macos")]
    {
        // `.app` 内运行时经 LaunchServices 重启整包（与更新 helper 的重启口径一致）。
        let in_bundle = exe
            .components()
            .any(|component| component.as_os_str().to_string_lossy().ends_with(".app"));
        let mut command = if in_bundle {
            // …/X.app/Contents/MacOS/native-host → …/X.app
            let bundle = exe
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .ok_or_else(|| AppError::Other("无法从可执行文件定位应用包".into()))?;
            let mut command = std::process::Command::new("/usr/bin/open");
            command.arg("-n").arg(bundle);
            command
        } else {
            std::process::Command::new(&exe)
        };
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| AppError::Other(format!("重启应用失败: {error}")))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        std::process::Command::new(&exe)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| AppError::Other(format!("重启应用失败: {error}")))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = exe;
        Err(AppError::Other("原生宿主只支持 macOS 与 Windows".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    // ── AssetScope ──

    fn temp_file(tag: &str, name: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "deskpet-asset-scope-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, bytes).unwrap();
        (dir, file)
    }

    #[test]
    fn 授权后才能读取且只对已授权路径放行() {
        let (dir, file) = temp_file("allow", "a.png", b"x");
        let other = dir.join("b.png");
        std::fs::write(&other, b"y").unwrap();

        let scope = NativeAssetScope::new();
        assert!(!scope.is_allowed(&file), "未授权路径默认拒绝");
        scope.allow_file(&file).unwrap();
        assert!(scope.is_allowed(&file));
        assert!(!scope.is_allowed(&other), "授权一个文件不等于整目录放行");
        // 查询方给词法路径（macOS 的 /var 与 /private/var 是不同字符串）也要命中
        // 白名单里的 canonical 形态。
        assert!(scope.is_allowed(&file), "canonical 查询必须命中");
        assert!(
            scope.is_allowed(&dir.join("a.png")),
            "词法形态查询必须归一到 canonical"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 目录授权按递归标志生效() {
        let (dir, file) = temp_file("dirs", "top.png", b"x");
        let nested_dir = dir.join("nested");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let nested = nested_dir.join("deep.png");
        std::fs::write(&nested, b"y").unwrap();

        let scope = NativeAssetScope::new();
        scope.allow_directory(&dir, true).unwrap();
        assert!(scope.is_allowed(&file));
        assert!(scope.is_allowed(&nested), "递归目录授权覆盖子目录");

        let scope = NativeAssetScope::new();
        scope.allow_directory(&dir, false).unwrap();
        assert!(scope.is_allowed(&file), "非递归目录授权放行直接子项");
        assert!(!scope.is_allowed(&nested), "非递归目录授权不盖子目录");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 凭据记忆库与不存在路径一律拒绝授权() {
        let (dir, _file) = temp_file("reject", "keep.txt", b"x");
        let scope = NativeAssetScope::new();

        let credential = dir.join("id_rsa.pem");
        std::fs::write(&credential, b"secret").unwrap();
        assert_eq!(
            scope.allow_file(&credential).unwrap_err().code(),
            "SENSITIVE_PATH"
        );

        let missing = dir.join("missing.png");
        assert_eq!(
            scope.allow_file(&missing).unwrap_err().code(),
            "PATH_NOT_FOUND"
        );

        let database = dir.join("memory").join("memory.sqlite3");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        std::fs::write(&database, b"db").unwrap();
        assert_eq!(
            scope.allow_file(&database).unwrap_err().code(),
            "MEMORY_PROTECTED_PATH"
        );
        assert_eq!(scope.file_count(), 0, "被拒路径不得进入白名单");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 允许根之外的已存在文件被拒绝() {
        #[cfg(unix)]
        {
            let scope = NativeAssetScope::new();
            if std::path::Path::new("/etc/hosts").exists() {
                let error = scope.allow_file(Path::new("/etc/hosts")).unwrap_err();
                assert_eq!(error.code(), "PATH_ESCAPE");
            }
        }
    }

    // ── ExitOnceHook ──

    struct CountingHook(Arc<AtomicUsize>);
    impl HostExitHook for CountingHook {
        fn run(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn 退出序列只跑一次() {
        let count = Arc::new(AtomicUsize::new(0));
        let once = ExitOnceHook::new(Arc::new(CountingHook(count.clone())));
        once.run_once();
        once.run(); // 平台侧晚到的同一次退出
        once.run_once();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(once.has_run());
    }

    // ── macOS 对话框在无 UI 时如实报错（不触达 AppKit；Windows 的通用对话框
    //    会在真实桌面上弹窗，不能进单测，见报告「未验证」）。──

    #[cfg(target_os = "macos")]
    #[test]
    fn 未启动ui时对话框如实报错不挂起() {
        // 在另一个线程创建队列：测试线程不是「UI 主线程」，且没有唤醒器。
        let handle = std::thread::spawn(|| UiHandle::new(crate::ui::MainThreadQueue::new()))
            .join()
            .unwrap();
        let dialog = NativeFileDialog::new(handle);
        assert!(dialog.pick_images().is_err());
        assert!(dialog.pick_file().is_err());
        assert!(dialog.save_file("a.zip", "Zip", "zip").is_err());
    }
}
