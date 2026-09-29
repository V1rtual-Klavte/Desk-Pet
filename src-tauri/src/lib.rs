#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#![allow(unexpected_cfgs)]

mod commands;
pub mod error;
pub mod logger;
mod macros;
mod monitor;
mod paths;
mod window;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::commands::{
    app_open, app_restart, bash_cancel, bash_exec, clipboard_read, clipboard_write, close_windows_sim,
    compute_popup_position, dir_create, export_profile_zip, file_append,
    file_canonical_path, file_exists, file_info, file_list, file_read, file_read_binary,
    file_remove, file_rename, file_write, file_write_atomic, get_cursor_position, init_memory_files,
    list_profile_files, list_profiles, log_messages, mcp_kill, mcp_send,
    mcp_spawn, open_devtools, open_windows_sim, pause_monitor, personality_file_list, personality_file_read, personality_file_write, profile_asset_base,
    profile_clone, profile_delete, profile_file_read, profile_file_write, report_frontend_error,
    restore_default_resources, resume_monitor, set_log_config, set_monitor_config, skill_catalog_fingerprint, skill_delete,
    spawn_cursor_tracker, system_info, tool_permit_acquire, tool_permit_attach, tool_permit_cancel,
    tool_permit_release, tool_permit_set_max_shared_readers, tool_permit_snapshot, BashPool, McpPool,
    ToolPermitPool,
};
use crate::monitor::MonitorState;
use crate::window::{
    create_main_window, enhance_layer_editor_window, enhance_settings_window, set_picker_window_level,
};

use crate::error::{err, AppError, AppResult};
use crate::paths::AppPaths;

// ==========================================
// AppPaths 统一路径 commands
// ==========================================

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
            || candidate
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
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
    std::fs::write(&paths.config_file, content)
        .map_err(|e| AppError::Io(format!("写入配置失败: {e}")))
}

#[tauri::command]
fn read_session_ui_state(paths: tauri::State<AppPaths>) -> AppResult<Option<String>> {
    let file = paths.sessions.join("index.json");
    if !file.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(file)
        .map(Some)
        .map_err(|e| AppError::Io(format!("读取会话 UI 状态失败: {e}")))
}

#[tauri::command]
fn write_session_ui_state(paths: tauri::State<AppPaths>, content: String) -> AppResult<()> {
    let file = paths.sessions.join("index.json");
    std::fs::write(file, content).map_err(|e| AppError::Io(format!("写入会话 UI 状态失败: {e}")))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct E2eOptions {
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
    source_hashes: Option<String>,
    commit: Option<String>,
}

#[tauri::command]
fn e2e_options() -> E2eOptions {
    if !cfg!(debug_assertions) {
        return E2eOptions {
            module: None,
            scene: None,
            case_id: None,
            tag: None,
            suite: None,
            repeat: None,
            strict: None,
            report: None,
            seed_hash: None,
            source_hashes: None,
            commit: None,
        };
    }
    let env_value = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
    E2eOptions {
        module: env_value("DESKPET_E2E_MODULE"),
        scene: env_value("DESKPET_E2E_SCENE"),
        case_id: env_value("DESKPET_E2E_CASE"),
        tag: env_value("DESKPET_E2E_TAG"),
        suite: env_value("DESKPET_E2E_SUITE"),
        repeat: env_value("DESKPET_E2E_REPEAT"),
        strict: env_value("DESKPET_E2E_STRICT"),
        report: env_value("DESKPET_E2E_REPORT"),
        seed_hash: env_value("DESKPET_E2E_SEED_HASH"),
        source_hashes: env_value("DESKPET_E2E_SOURCE_HASHES"),
        commit: env_value("DESKPET_E2E_COMMIT"),
    }
}

#[tauri::command]
fn e2e_complete(
    app: tauri::AppHandle,
    paths: tauri::State<AppPaths>,
    passed: bool,
    report: String,
) -> AppResult<()> {
    if !cfg!(debug_assertions) {
        return err("E2E 仅允许 debug 构建");
    }
    // 报告是多行结构，原样转发（不套 Rust 前缀），但要经过统一出口才能落盘
    logger::emit_frontend(&format!("[E2E] completed passed={passed}\n{report}"));
    let result = format!("{}\n{}", if passed { "PASS" } else { "FAIL" }, report);
    if let Err(error) = std::fs::write(paths.data_root.join("e2e-result.txt"), result) {
        eprintln!("[E2E] 无法写入测试结果: {error}");
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(monitor_state)
        .manage(McpPool::default())
        .manage(BashPool::default())
        .manage(ToolPermitPool::default())
        .setup(move |app| {
            rust_info!("糖糖桌宠已启动");

            let e2e = cfg!(debug_assertions) && crate::paths::is_e2e();

            // macOS: 必须先设置 ActivationPolicy，再创建窗口。
            //
            // 产品是桌宠，不该占 Dock —— Accessory 无 Dock 图标、不进 Cmd+Tab、无应用菜单。
            // 但 **E2E 宿主窗口是给人看的开发者工具**，Accessory 下它一旦被最小化就再也
            // 找不回来（三种入口全都没有），而窗口只要被判定为遮挡，WebKit 就会冻结页面
            // JS —— 整轮测试静默停摆，使用者既看不到进度，也不知道它已经停了。
            // 实测：2026-09-29 最小化后 7 分钟只耗 0.6% CPU、零产出，与「同样规模 4 分 37 秒
            // 跑完」的正常运行完全不符。
            // E2E 用 Regular：出现在 Dock 与 Cmd+Tab，随时能唤回。
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                let policy = if e2e {
                    ActivationPolicy::Regular
                } else {
                    ActivationPolicy::Accessory
                };
                let _ = app.set_activation_policy(policy);
                rust_info!(
                    "macOS: ActivationPolicy::{} 已设置",
                    if e2e { "Regular" } else { "Accessory" }
                );
            }
            let paths = match AppPaths::init(app.handle()) {
                Ok(p) => p,
                Err(e) => {
                    // 极早期失败：窗口尚未创建，前端无从汇报，只能靠终端 + 退出码
                    rust_error!("路径初始化失败: {e}");
                    std::process::exit(1);
                }
            };
            app.asset_protocol_scope()
                .allow_directory(&paths.profiles, true)?;
            // 文件 sink 必须在 paths 就绪后初始化；此处之前的日志只进终端
            logger::init_file_sink(&paths.logs);
            app.manage(paths);

            if e2e {
                let window = WebviewWindowBuilder::new(
                    app,
                    "e2e",
                    WebviewUrl::App(PathBuf::from("test-e2e.html")),
                )
                .title("Desk-Pet E2E")
                .inner_size(900.0, 700.0)
                .visible(true)
                // 不让最小化：窗口被遮挡（含最小化）时 WebKit 会冻结页面 JS，
                // 整轮测试静默停摆。Dock 能唤回是兜底，这里从源头堵掉误操作。
                .minimizable(false)
                .build();
                match window {
                    Ok(_) => {
                        rust_info!("E2E 窗口已创建");
                    }
                    Err(e) => {
                        rust_warn!("E2E 窗口创建失败: {e}");
                    }
                }
                return Ok(());
            } else {
                // 手动创建主窗口（在 Accessory 之后），默认显示
                let _main_window = match create_main_window(app.handle()) {
                    Ok(w) => {
                        rust_info!("主窗口已创建并显示");
                        Some(w)
                    }
                    Err(e) => {
                        rust_warn!("创建主窗口失败: {e}");
                        None
                    }
                };
            }

            // ── 系统托盘 ── 非必需组件：构建失败只告警，应用仍可运行
            let tray_result = (|| -> Result<(), String> {
                let show_item = MenuItemBuilder::with_id("show", "显示")
                    .build(app.handle())
                    .map_err(|e| format!("菜单项 show: {e}"))?;
                let quit_item = MenuItemBuilder::with_id("quit", "退出")
                    .build(app.handle())
                    .map_err(|e| format!("菜单项 quit: {e}"))?;
                let tray_menu = MenuBuilder::new(app.handle())
                    .item(&show_item)
                    .item(&quit_item)
                    .build()
                    .map_err(|e| format!("托盘菜单: {e}"))?;

                let handle2 = app.handle().clone();
                let icon = app
                    .default_window_icon()
                    .ok_or_else(|| "缺少默认窗口图标".to_string())?
                    .clone();

                TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&tray_menu)
                    .on_menu_event(move |app, event| match event.id().as_ref() {
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
                    })
                    .on_tray_icon_event(move |_tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
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
            app_restart,
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
            open_devtools,
            enhance_settings_window,
            enhance_layer_editor_window,
            set_picker_window_level,
            bash_exec,
            bash_cancel,
            file_read,
            file_read_binary,
            file_write,
            file_write_atomic,
            file_append,
            file_rename,
            file_remove,
            dir_create,
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
            init_memory_files,
            get_runtime_paths,
            resolve_runtime_path,
            read_runtime_config,
            write_runtime_config,
            read_session_ui_state,
            write_session_ui_state,
            profile_file_write,
            profile_file_read,
            profile_delete,
            profile_clone,
            export_profile_zip,
            profile_asset_base,
            list_profiles,
            list_profile_files,
            restore_default_resources,
            skill_catalog_fingerprint,
            skill_delete,
            e2e_options,
            e2e_complete,
            personality_file_read,
            personality_file_write,
            personality_file_list,
            tool_permit_acquire,
            tool_permit_attach,
            tool_permit_release,
            tool_permit_cancel,
            tool_permit_set_max_shared_readers,
            tool_permit_snapshot,
            ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // 不做裸 panic：给出可读原因并保留退出码
            rust_error!("事件循环启动失败: {e}");
            std::process::exit(1);
        })
        .run(|app, event| {
            // MCP 子进程必须在进程真正退出前回收。`Exit` 覆盖所有退出路径，
            // 包括托盘菜单那条 —— 它直接调用 Rust 的 app.exit，不经过前端钩子，
            // 只靠 App.vue 的 onUnmounted 会留下一批常驻的 npx / node。
            if let tauri::RunEvent::Exit = event {
                app.state::<McpPool>().kill_all();
            }
        });
}
