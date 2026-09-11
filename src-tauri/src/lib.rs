#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#![allow(unexpected_cfgs)]

mod macros;
mod monitor;
mod window;
mod commands;
mod paths;
pub mod logger;
pub mod error;

use std::sync::Arc;
use std::path::PathBuf;
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};

use crate::monitor::MonitorState;
use crate::window::{create_main_window, enhance_settings_window, enhance_layer_editor_window};
use crate::commands::{
    get_cursor_position, compute_popup_position,
    pause_monitor, resume_monitor, set_monitor_config,
    open_windows_sim, close_windows_sim,
    log_messages, set_log_config, report_frontend_error, focus_main, open_devtools,
    bash_exec, bash_cancel, file_read, file_read_binary, file_write, file_list,
    file_info, file_exists, file_canonical_path,
    system_info, app_open, clipboard_read, clipboard_write,
    mcp_spawn, mcp_send, mcp_kill, McpPool, BashPool,
    get_memory_file, get_session_file, init_memory_files,
    list_session_files, delete_session_file, file_delete,
    profile_file_write, profile_file_read, profile_delete, profile_asset_base, profile_user_asset_base, list_user_profiles, list_profile_files,
    personality_file_read, personality_file_write, personality_file_list, personality_file_delete,
    spawn_cursor_tracker,
};

use crate::paths::AppPaths;
use crate::error::{err, AppError, AppResult};

// ==========================================
// AppPaths 统一路径 commands
// ==========================================

#[tauri::command]
fn get_data_dir(paths: tauri::State<AppPaths>) -> String {
    paths.data_root.to_string_lossy().to_string()
}

#[tauri::command]
fn get_memory_dir(paths: tauri::State<AppPaths>) -> String {
    paths.memory.to_string_lossy().to_string()
}

#[tauri::command]
fn get_sessions_dir(paths: tauri::State<AppPaths>) -> String {
    paths.sessions.to_string_lossy().to_string()
}

#[tauri::command]
fn get_personality_dir(paths: tauri::State<AppPaths>) -> String {
    paths.personality.to_string_lossy().to_string()
}

#[tauri::command]
fn get_profiles_dir(paths: tauri::State<AppPaths>) -> String {
    paths.profiles.to_string_lossy().to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePathsPayload {
    data: String,
    memory: String,
    sessions: String,
    personality: String,
    profiles: String,
    settings: String,
    config_file: String,
    runtime_mode: String,
}

#[tauri::command]
fn get_runtime_paths(paths: tauri::State<AppPaths>) -> RuntimePathsPayload {
    let display = |path: &std::path::Path| path.to_string_lossy().to_string();
    RuntimePathsPayload {
        data: display(&paths.data_root),
        memory: display(&paths.memory),
        sessions: display(&paths.sessions),
        personality: display(&paths.personality),
        profiles: display(&paths.profiles),
        settings: display(&paths.settings),
        config_file: display(&paths.config_file),
        runtime_mode: paths.runtime_mode.to_string(),
    }
}

#[tauri::command]
fn resolve_runtime_path(
    paths: tauri::State<AppPaths>,
    scope: String,
    segments: Vec<String>,
) -> AppResult<String> {
    let mut path = match scope.as_str() {
        "data" => paths.data_root.clone(),
        "memory" => paths.memory.clone(),
        "sessions" => paths.sessions.clone(),
        "personality" => paths.personality.clone(),
        "profiles" => paths.profiles.clone(),
        "settings" => paths.settings.clone(),
        _ => return err(format!("未知运行时路径域: {scope}")),
    };
    for segment in segments {
        let candidate = std::path::Path::new(&segment);
        if candidate.is_absolute()
            || candidate.components().any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(AppError::PathEscape);
        }
        path.push(candidate);
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn read_runtime_config(paths: tauri::State<AppPaths>) -> AppResult<String> {
    std::fs::read_to_string(&paths.config_file)
        .map_err(|e| AppError::Io(format!("读取配置失败 {:?}: {e}", paths.config_file)))
}

#[tauri::command]
fn write_runtime_config(paths: tauri::State<AppPaths>, content: String) -> AppResult<()> {
    let parent = paths.config_file.parent().ok_or("配置文件路径没有父目录")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    std::fs::write(&paths.config_file, content).map_err(|e| AppError::Io(format!("写入配置失败: {e}")))
}

#[tauri::command]
fn read_session_ui_state(paths: tauri::State<AppPaths>) -> AppResult<Option<String>> {
    let file = paths.sessions.join("index.json");
    if !file.exists() { return Ok(None); }
    std::fs::read_to_string(file).map(Some).map_err(|e| AppError::Io(format!("读取会话 UI 状态失败: {e}")))
}

#[tauri::command]
fn write_session_ui_state(paths: tauri::State<AppPaths>, content: String) -> AppResult<()> {
    let file = paths.sessions.join("index.json");
    std::fs::write(file, content).map_err(|e| AppError::Io(format!("写入会话 UI 状态失败: {e}")))
}

#[tauri::command]
fn get_cards_dir(paths: tauri::State<AppPaths>) -> String {
    paths.personality.join("cards").to_string_lossy().to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveTestOptions {
    module: Option<String>,
    scene: Option<String>,
    #[serde(rename = "case")]
    case_id: Option<String>,
    tag: Option<String>,
    suite: Option<String>,
    repeat: Option<String>,
    strict: Option<String>,
    report: Option<String>,
    seed_hash: Option<String>,
    commit: Option<String>,
}

#[tauri::command]
fn get_live_test_options() -> LiveTestOptions {
    if !cfg!(debug_assertions) {
        return LiveTestOptions {
            module: None, scene: None, case_id: None, tag: None, suite: None,
            repeat: None, strict: None, report: None, seed_hash: None, commit: None,
        };
    }
    let env_value = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
    LiveTestOptions {
        module: env_value("DESKPET_LIVE_TEST_MODULE"),
        scene: env_value("DESKPET_LIVE_TEST_SCENE"),
        case_id: env_value("DESKPET_LIVE_TEST_CASE"),
        tag: env_value("DESKPET_LIVE_TEST_TAG"),
        suite: env_value("DESKPET_LIVE_TEST_SUITE"),
        repeat: env_value("DESKPET_LIVE_TEST_REPEAT"),
        strict: env_value("DESKPET_LIVE_TEST_STRICT"),
        report: env_value("DESKPET_LIVE_TEST_REPORT"),
        seed_hash: env_value("DESKPET_LIVE_TEST_SEED_HASH"),
        commit: env_value("DESKPET_LIVE_TEST_COMMIT"),
    }
}

#[tauri::command]
fn live_test_complete(app: tauri::AppHandle, paths: tauri::State<AppPaths>, passed: bool, report: String) -> AppResult<()> {
    if !cfg!(debug_assertions) {
        return err("Live Test 仅允许 debug 构建");
    }
    // 报告是多行结构，原样转发（不套 Rust 前缀），但要经过统一出口才能落盘
    logger::emit_frontend(&format!("[LiveTest] completed passed={passed}\n{report}"));
    let result = format!("{}\n{}", if passed { "PASS" } else { "FAIL" }, report);
    if let Err(error) = std::fs::write(paths.data_root.join("live-test-result.txt"), result) {
        eprintln!("[LiveTest] 无法写入测试结果: {error}");
    }
    app.exit(0);
    Ok(())
}

// ==========================================
// 启动入口
// ==========================================

pub fn run() {
    // 必须在任何日志之前：DESKPET_LOG_LEVEL 可覆写默认级别
    logger::init_from_env();

    // panic 默认只写 stderr；release 构建（windows_subsystem="windows"）没有控制台，
    // 换掉 hook 才能让崩溃留下可查的记录。
    std::panic::set_hook(Box::new(|info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "未知 panic".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "未知位置".to_string());
        logger::emit(
            logger::LEVEL_ERROR,
            format_args!("[PANIC] {message} @ {location}"),
        );
    }));

    let monitor_state = Arc::new(MonitorState::default());
    let monitor_state_clone = Arc::clone(&monitor_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(monitor_state)
        .manage(McpPool::default())
        .manage(BashPool::default())
        .setup(move |app| {
            rust_info!("糖糖桌宠已启动");

            // macOS: 必须先设置 ActivationPolicy，再创建窗口
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                rust_info!("macOS: ActivationPolicy::Accessory 已设置");
            }

            let live_test = cfg!(debug_assertions)
                && std::env::var("DESKPET_LIVE_TEST").ok().as_deref() == Some("1");
            let paths = match AppPaths::init(app.handle()) {
                Ok(p) => p,
                Err(e) => {
                    // 极早期失败：窗口尚未创建，前端无从汇报，只能靠终端 + 退出码
                    rust_error!("路径初始化失败: {e}");
                    std::process::exit(1);
                }
            };
            app.asset_protocol_scope().allow_directory(&paths.profiles, true)?;
            // 文件 sink 必须在 paths 就绪后初始化；此处之前的日志只进终端
            logger::init_file_sink(&paths.logs);
            app.manage(paths);

            if live_test {
                let window = WebviewWindowBuilder::new(
                    app,
                    "live-test",
                    WebviewUrl::App(PathBuf::from("live-test.html")),
                )
                .title("Desk-Pet Live Test")
                .inner_size(900.0, 700.0)
                .visible(true)
                .build();
                match window {
                    Ok(_) => { rust_info!("Live Test 窗口已创建"); }
                    Err(e) => { rust_warn!("Live Test 窗口创建失败: {e}"); }
                }
                return Ok(());
            } else {
                // 手动创建主窗口（在 Accessory 之后），默认显示
                let _main_window = match create_main_window(app.handle()) {
                    Ok(w) => { rust_info!("主窗口已创建并显示"); Some(w) }
                    Err(e) => { rust_warn!("创建主窗口失败: {e}"); None }
                };
            }

            // ── 系统托盘 ── 非必需组件：构建失败只告警，应用仍可运行
            let tray_result = (|| -> Result<(), String> {
                let show_item = MenuItemBuilder::with_id("show", "显示")
                    .build(app.handle()).map_err(|e| format!("菜单项 show: {e}"))?;
                let quit_item = MenuItemBuilder::with_id("quit", "退出")
                    .build(app.handle()).map_err(|e| format!("菜单项 quit: {e}"))?;
                let tray_menu = MenuBuilder::new(app.handle())
                    .item(&show_item)
                    .item(&quit_item)
                    .build()
                    .map_err(|e| format!("托盘菜单: {e}"))?;

                let handle2 = app.handle().clone();
                let icon = app.default_window_icon()
                    .ok_or_else(|| "缺少默认窗口图标".to_string())?
                    .clone();

                TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&tray_menu)
                    .on_menu_event(move |app, event| {
                        match event.id().as_ref() {
                            "show" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.unminimize();
                                    let _ = w.set_focus();
                                }
                            }
                            "quit" => {
                                rust_info!("托盘菜单 → 退出");
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(move |_tray, event| {
                        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                            if let Some(w) = handle2.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                                rust_debug!("托盘单击 → 显示窗口");
                            }
                        }
                    })
                    .build(app.handle())
                    .map_err(|e| format!("托盘图标: {e}"))?;
                Ok(())
            })();

            match tray_result {
                Ok(()) => rust_info!("系统托盘已创建"),
                Err(e) => rust_warn!("系统托盘创建失败（应用继续运行）: {e}"),
            }

            // 启动窗口监控后台线程
            monitor::spawn_monitor_thread(app.handle().clone(), monitor_state_clone);

            // 启动光标追踪后台线程 (灵动图层 ~60fps)
            spawn_cursor_tracker(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_cursor_position,
            compute_popup_position,
            pause_monitor,
            resume_monitor,
            set_monitor_config,
            open_windows_sim,
            close_windows_sim,
            log_messages,
            set_log_config,
            report_frontend_error,
            focus_main,
            open_devtools,
            enhance_settings_window,
            enhance_layer_editor_window,
            bash_exec,
            bash_cancel,
            file_read,
            file_read_binary,
            file_write,
            file_list,
            file_info,
            file_exists,
            file_canonical_path,
            system_info,
            app_open,
            clipboard_read,
            clipboard_write,
            mcp_spawn,
            mcp_send,
            mcp_kill,
            get_data_dir,
            get_memory_dir,
            get_sessions_dir,
            get_memory_file,
            get_session_file,
            init_memory_files,
            list_session_files,
            delete_session_file,
            file_delete,
            get_profiles_dir,
            get_runtime_paths,
            resolve_runtime_path,
            read_runtime_config,
            write_runtime_config,
            read_session_ui_state,
            write_session_ui_state,
            profile_file_write,
            profile_file_read,
            profile_delete,
            profile_asset_base,
            profile_user_asset_base,
            list_user_profiles,
            list_profile_files,
            get_personality_dir,
            get_cards_dir,
            get_live_test_options,
            live_test_complete,
            personality_file_read,
            personality_file_write,
            personality_file_list,
            personality_file_delete,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // 不做裸 panic：给出可读原因并保留退出码
            rust_error!("事件循环启动失败: {e}");
            std::process::exit(1);
        });
}
