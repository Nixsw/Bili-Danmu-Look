mod app_config;
mod bilibili;
mod commands;
mod models;
mod store;
mod ws_client;

use app_config::{load_config, save_window_position, save_window_size};
use commands::{
    ack_message, ack_user_messages, connect_ws, disconnect_ws, get_config, get_snapshot,
    jump_main_viewport_to_unread, probe_bilibili_connection, reconnect_ws, scroll_main_viewport,
    scroll_person_viewport, select_user_anchor, set_main_window_geometry, set_person_panel_hover,
    set_viewport_sizes, update_config,
};
use std::sync::{Arc, Mutex};
use store::MessageStore;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const APP_DISPLAY_TITLE: &str = "读弹幕工具 - 小小鱼";

pub struct AppState {
    pub inner: Arc<Mutex<RuntimeState>>,
    pub ws_task: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    pub connect_cache: Arc<Mutex<bilibili::ConnectApiCache>>,
}

pub struct RuntimeState {
    pub store: MessageStore,
    pub config: app_config::AppConfig,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = load_config();
            let mut store = MessageStore::new(config.main_capacity, config.per_user_capacity);
            store.set_person_history_count(config.person_history_count as usize);
            let runtime_state = Arc::new(Mutex::new(RuntimeState { store, config }));
            let state = AppState {
                inner: runtime_state.clone(),
                ws_task: Arc::new(Mutex::new(None)),
                connect_cache: Arc::new(Mutex::new(bilibili::ConnectApiCache::default())),
            };
            app.manage(state);
            ensure_main_window(app)?;
            apply_main_window_config(app, &runtime_state)?;
            persist_main_window_geometry(app, runtime_state)?;
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_config,
            update_config,
            connect_ws,
            disconnect_ws,
            reconnect_ws,
            probe_bilibili_connection,
            ack_message,
            ack_user_messages,
            select_user_anchor,
            set_person_panel_hover,
            scroll_main_viewport,
            jump_main_viewport_to_unread,
            scroll_person_viewport,
            set_viewport_sizes,
            set_main_window_geometry
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DanmuTools");
}

fn ensure_main_window(app: &tauri::App) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("DanmuTools")
        .inner_size(600.0, 780.0)
        .min_inner_size(420.0, 520.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .visible(false)
        .always_on_top(true)
        .resizable(true)
        .build()?;
    Ok(())
}

fn apply_main_window_config(
    app: &tauri::App,
    runtime_state: &Arc<Mutex<RuntimeState>>,
) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let config = runtime_state
        .lock()
        .map(|state| state.config.clone())
        .unwrap_or_default();

    if let (Some(width), Some(height)) = (config.window_width, config.window_height) {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }
    if let (Some(x), Some(y)) = (config.window_x, config.window_y) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    Ok(())
}

fn persist_main_window_geometry(
    app: &tauri::App,
    runtime_state: Arc<Mutex<RuntimeState>>,
) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| match event {
            WindowEvent::Moved(position) => {
                if let Ok(mut state) = runtime_state.lock() {
                    let config = state.config.clone();
                    if let Ok(next) = save_window_position(position.x, position.y, config) {
                        state.config = next;
                    }
                }
            }
            WindowEvent::Resized(size) => {
                if let Ok(mut state) = runtime_state.lock() {
                    let config = state.config.clone();
                    if let Ok(next) = save_window_size(size.width, size.height, config) {
                        state.config = next;
                    }
                }
            }
            _ => {}
        });
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct TrayMenuItemSpec {
    id: &'static str,
    label: &'static str,
}

fn tray_menu_item_specs() -> [TrayMenuItemSpec; 3] {
    [
        TrayMenuItemSpec {
            id: "show",
            label: "显示/隐藏",
        },
        TrayMenuItemSpec {
            id: "settings",
            label: "设置",
        },
        TrayMenuItemSpec {
            id: "quit",
            label: "退出",
        },
    ]
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let [show_spec, settings_spec, quit_spec] = tray_menu_item_specs();
    let show = MenuItem::with_id(app, show_spec.id, show_spec.label, true, None::<&str>)?;
    let settings = MenuItem::with_id(
        app,
        settings_spec.id,
        settings_spec.label,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, quit_spec.id, quit_spec.label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("configured default window icon should exist"),
        )
        .tooltip(APP_DISPLAY_TITLE)
        .title(APP_DISPLAY_TITLE)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("tray_settings_requested", ());
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_menu_excludes_disconnect_and_reconnect_actions() {
        let ids: Vec<&str> = tray_menu_item_specs().iter().map(|item| item.id).collect();

        assert_eq!(ids, vec!["show", "settings", "quit"]);
        assert!(!ids.contains(&"disconnect"));
        assert!(!ids.contains(&"reconnect"));
    }

    #[test]
    fn tray_uses_requested_display_title() {
        assert_eq!(APP_DISPLAY_TITLE, "读弹幕工具 - 小小鱼");
    }

    #[test]
    fn main_window_config_disables_native_shadow() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("tauri config should be valid JSON");

        assert_eq!(config["app"]["windows"][0]["shadow"], false);
    }
}
