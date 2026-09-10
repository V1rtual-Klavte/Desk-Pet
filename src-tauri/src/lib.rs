#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#![allow(unexpected_cfgs)]

mod macros;
mod monitor;
mod window;
mod commands;
mod paths;

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
    log_message, focus_main, open_devtools,
    bash_exec, bash_cancel, file_read, file_read_binary, file_write, file_list,
    file_info, file_exists, file_canonical_path,
    system_info, app_open, clipboard_read, clipboard_write,
    mcp_spawn, mcp_send, mcp_kill, McpPool, BashPool,
    get_memory_file, get_session_file, init_memory_files,
    list_session_files, delete_session_file, file_delete,
    profile_file_write, profile_file_read, profile_delete, list_user_profiles, list_profile_files,
    personality_file_read, personality_file_write, personality_file_list, personality_file_delete,
    spawn_cursor_tracker,
};

use crate::paths::AppPaths;

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
fn live_test_complete(app: tauri::AppHandle, paths: tauri::State<AppPaths>, passed: bool, report: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("Live Test 仅允许 debug 构建".to_string());
    }
    println!("[LiveTest] completed passed={passed}\n{report}");
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
            let paths = AppPaths::init(app.handle()).expect("路径初始化失败");
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

            // ── 系统托盘 ──
            let tray_menu = MenuBuilder::new(app.handle())
                .item(&MenuItemBuilder::with_id("show", "显示").build(app.handle()).unwrap())
                .item(&MenuItemBuilder::with_id("quit", "退出").build(app.handle()).unwrap())
                .build()
                .unwrap();

            let handle2 = app.handle().clone();
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
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
                .unwrap();
            rust_info!("系统托盘已创建");

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
            log_message,
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
            profile_file_write,
            profile_file_read,
            profile_delete,
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
        .expect("startup failure");
}
