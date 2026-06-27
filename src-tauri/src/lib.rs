#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#![allow(unexpected_cfgs)]

mod macros;
mod monitor;
mod window;
mod commands;

use std::sync::Arc;
use tauri::Manager;
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};

use crate::monitor::MonitorState;
use crate::window::{create_main_window, enhance_settings_window};
use crate::commands::{
    get_cursor_position, compute_popup_position,
    pause_monitor, resume_monitor, set_monitor_config,
    open_windows_sim, close_windows_sim,
    log_message, focus_main,
    bash_exec, file_read, file_write, file_list,
    system_info, app_open, clipboard_read, clipboard_write,
    mcp_spawn, mcp_send, mcp_kill, McpPool,
    get_memory_dir, get_memory_file, get_session_file, init_memory_files,
    list_session_files, delete_session_file, file_delete,
};

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
        .setup(move |app| {
            rust_info!("糖糖桌宠已启动");

            // macOS: 必须先设置 ActivationPolicy，再创建窗口
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                rust_info!("macOS: ActivationPolicy::Accessory 已设置");
            }

            // 手动创建主窗口（在 Accessory 之后），默认显示
            let _main_window = create_main_window(app.handle())
                .expect("创建主窗口失败");
            rust_info!("主窗口已创建并显示");

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
            enhance_settings_window,
            bash_exec,
            file_read,
            file_write,
            file_list,
            system_info,
            app_open,
            clipboard_read,
            clipboard_write,
            mcp_spawn,
            mcp_send,
            mcp_kill,
            get_memory_dir,
            get_memory_file,
            get_session_file,
            init_memory_files,
            list_session_files,
            delete_session_file,
            file_delete,
        ])
        .run(tauri::generate_context!())
        .expect("startup failure");
}
