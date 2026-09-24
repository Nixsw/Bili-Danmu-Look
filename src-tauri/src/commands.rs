use crate::app_config::{save_config, AppConfig, ConfigPatch};
use crate::bilibili::{run_probe_once, ProbeOptions, ProbeReport};
use crate::models::AppSnapshot;
use crate::ws_client::{connect_ws_inner, disconnect_ws_inner};
use crate::AppState;
use directories::ProjectDirs;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn get_snapshot(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    let inner = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(inner.store.snapshot())
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let inner = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(inner.config.clone())
}

#[tauri::command]
pub fn update_config(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: ConfigPatch,
) -> Result<AppConfig, String> {
    let config = {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.config.apply_patch(patch);
        let person_history_count = inner.config.person_history_count;
        inner
            .store
            .set_person_history_count(person_history_count as usize);
        save_config(&inner.config)?;
        inner.config.clone()
    };
    emit_snapshot(&app, &state)?;
    Ok(config)
}

#[tauri::command]
pub async fn connect_ws(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    connect_ws_inner(app, &state).await
}

#[tauri::command]
pub async fn disconnect_ws(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    disconnect_ws_inner(&state)?;
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.set_connection("已断开", false);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub async fn reconnect_ws(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    disconnect_ws_inner(&state)?;
    connect_ws_inner(app, &state).await
}

#[tauri::command]
pub async fn probe_bilibili_connection(state: State<'_, AppState>) -> Result<ProbeReport, String> {
    let connect_api_url = {
        let inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.config.connect_api_url.clone()
    };
    let mut report = run_probe_once(
        &connect_api_url,
        state.connect_cache.clone(),
        ProbeOptions::default(),
    )
    .await?;
    let report_path = probe_report_path();
    report.report_path = Some(report_path.to_string_lossy().to_string());
    if let Some(parent) = report_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    fs::write(&report_path, text).map_err(|error| error.to_string())?;
    Ok(report)
}

#[tauri::command]
pub fn ack_message(
    app: AppHandle,
    state: State<'_, AppState>,
    message_id: u64,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.ack_message(message_id);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn ack_main_message(
    app: AppHandle,
    state: State<'_, AppState>,
    message_id: u64,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.ack_main_message(message_id);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn ack_user_messages(
    app: AppHandle,
    state: State<'_, AppState>,
    uid: String,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.ack_user_messages(&uid);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn clear_read_messages(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let removed_count = {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.clear_read_messages()
    };
    emit_snapshot(&app, &state)?;
    Ok(removed_count)
}

#[tauri::command]
pub fn clear_all_messages(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let removed_count = {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.clear_all_messages()
    };
    emit_snapshot(&app, &state)?;
    Ok(removed_count)
}

#[tauri::command]
pub fn select_user_anchor(
    app: AppHandle,
    state: State<'_, AppState>,
    message_id: u64,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.select_user_anchor(message_id);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn set_person_panel_hover(
    app: AppHandle,
    state: State<'_, AppState>,
    value: bool,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.set_person_panel_hover(value);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn scroll_main_viewport(
    app: AppHandle,
    state: State<'_, AppState>,
    delta: i32,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.scroll_main_viewport(delta as isize);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn jump_main_viewport_to_unread(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.jump_main_viewport_to_unread();
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn scroll_person_viewport(
    app: AppHandle,
    state: State<'_, AppState>,
    delta: i32,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.scroll_person_viewport(delta as isize);
    }
    emit_snapshot(&app, &state)
}

#[tauri::command]
pub fn set_viewport_sizes(
    app: AppHandle,
    state: State<'_, AppState>,
    main_viewport_size: Option<usize>,
    person_viewport_size: Option<usize>,
) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner
            .store
            .set_viewport_sizes(main_viewport_size, person_viewport_size);
    }
    emit_snapshot(&app, &state)
}

pub fn emit_snapshot(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let snapshot = {
        let inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.snapshot()
    };
    app.emit("danmu_state_changed", snapshot)
        .map_err(|error| error.to_string())
}

fn probe_report_path() -> PathBuf {
    ProjectDirs::from("com", "DanmuTools", "DanmuTools")
        .map(|dirs| dirs.config_dir().join("bilibili-probe-report.json"))
        .unwrap_or_else(|| PathBuf::from("bilibili-probe-report.json"))
}
