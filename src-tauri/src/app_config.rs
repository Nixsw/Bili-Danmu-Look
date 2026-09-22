use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const MAIN_DEFAULT_WIDTH: u32 = 420;
const PERSON_PANEL_WIDTH: u32 = 180;
const DEFAULT_WINDOW_WIDTH: u32 = MAIN_DEFAULT_WIDTH + PERSON_PANEL_WIDTH;
const MIN_WINDOW_HEIGHT: u32 = 520;
const WINDOWS_HIDDEN_WINDOW_POSITION: i32 = -30000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    #[serde(alias = "websocketUrl")]
    pub connect_api_url: String,
    pub opacity: f64,
    pub font_size: u8,
    /// Legacy persisted field; always normalized to false because the person panel is permanent.
    pub panel_collapsed: bool,
    pub person_history_count: u8,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub main_capacity: usize,
    pub per_user_capacity: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    #[serde(alias = "websocketUrl")]
    pub connect_api_url: Option<String>,
    pub opacity: Option<f64>,
    pub font_size: Option<u8>,
    /// Legacy patch field; accepted for config compatibility but ignored.
    pub panel_collapsed: Option<bool>,
    pub person_history_count: Option<u8>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            connect_api_url: default_connect_api_url(),
            opacity: 0.82,
            font_size: 14,
            panel_collapsed: false,
            person_history_count: 1,
            window_x: None,
            window_y: None,
            window_width: None,
            window_height: None,
            main_capacity: 1000,
            per_user_capacity: 50,
        }
    }
}

pub fn save_window_position(x: i32, y: i32, mut config: AppConfig) -> Result<AppConfig, String> {
    if !should_persist_window_position(x, y) {
        return Ok(config);
    }
    config.window_x = Some(x);
    config.window_y = Some(y);
    save_config(&config)?;
    Ok(config)
}

pub fn save_window_size(
    width: u32,
    height: u32,
    mut config: AppConfig,
) -> Result<AppConfig, String> {
    if !should_persist_window_size(width, height) {
        return Ok(config);
    }
    config.window_width = Some(width);
    config.window_height = Some(height);
    save_config(&config)?;
    Ok(config)
}

impl AppConfig {
    pub fn apply_patch(&mut self, patch: ConfigPatch) {
        self.panel_collapsed = false;

        if let Some(value) = patch.connect_api_url {
            if is_http_connect_api_url(&value) {
                self.connect_api_url = value;
            }
        }
        if let Some(value) = patch.opacity {
            self.opacity = value.clamp(0.45, 0.98);
        }
        if let Some(value) = patch.font_size {
            self.font_size = value.clamp(12, 18);
        }
        if let Some(value) = patch.person_history_count {
            self.person_history_count = value.min(3);
        }
    }

    pub fn sanitize_window_geometry(&mut self) {
        self.panel_collapsed = false;

        if !is_http_connect_api_url(&self.connect_api_url) {
            self.connect_api_url = default_connect_api_url();
        }

        if let (Some(x), Some(y)) = (self.window_x, self.window_y) {
            if !should_persist_window_position(x, y) {
                self.window_x = None;
                self.window_y = None;
            }
        }

        if let (Some(width), Some(height)) = (self.window_width, self.window_height) {
            if !should_persist_window_size(width, height) {
                self.window_width = None;
                self.window_height = None;
            }
        }
    }
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    let Ok(text) = fs::read_to_string(path) else {
        return AppConfig::default();
    };
    let mut config: AppConfig = serde_json::from_str(&text).unwrap_or_default();
    config.sanitize_window_geometry();
    config
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| error.to_string())
}

fn config_path() -> PathBuf {
    ProjectDirs::from("com", "DanmuTools", "DanmuTools")
        .map(|dirs| dirs.config_dir().join("config.json"))
        .unwrap_or_else(|| PathBuf::from("danmutools.config.json"))
}

fn should_persist_window_position(x: i32, y: i32) -> bool {
    x > WINDOWS_HIDDEN_WINDOW_POSITION && y > WINDOWS_HIDDEN_WINDOW_POSITION
}

fn should_persist_window_size(width: u32, height: u32) -> bool {
    width >= DEFAULT_WINDOW_WIDTH && height >= MIN_WINDOW_HEIGHT
}

fn default_connect_api_url() -> String {
    "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect".to_string()
}

fn is_http_connect_api_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::{
        should_persist_window_position, should_persist_window_size, AppConfig, ConfigPatch,
    };

    #[test]
    fn defaults_to_showing_person_panel() {
        let config = AppConfig::default();

        assert!(!config.panel_collapsed);
    }

    #[test]
    fn defaults_to_one_person_history_message() {
        let config = AppConfig::default();

        assert_eq!(config.person_history_count, 1);
    }

    #[test]
    fn discards_narrow_saved_width_when_person_panel_is_visible() {
        let mut config = AppConfig {
            panel_collapsed: false,
            window_width: Some(460),
            window_height: Some(780),
            ..AppConfig::default()
        };

        config.sanitize_window_geometry();

        assert_eq!(config.window_width, None);
        assert_eq!(config.window_height, None);
    }

    #[test]
    fn config_patch_clamps_display_values_and_keeps_window_geometry() {
        let mut config = AppConfig {
            window_x: Some(11),
            window_y: Some(22),
            window_width: Some(333),
            window_height: Some(444),
            ..AppConfig::default()
        };

        config.apply_patch(ConfigPatch {
            connect_api_url: Some(
                "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=abc".to_string(),
            ),
            opacity: Some(2.0),
            font_size: Some(3),
            panel_collapsed: Some(true),
            person_history_count: Some(9),
        });

        assert_eq!(
            config.connect_api_url,
            "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=abc"
        );
        assert_eq!(config.opacity, 0.98);
        assert_eq!(config.font_size, 12);
        assert_eq!(config.window_x, Some(11));
        assert_eq!(config.window_height, Some(444));
        assert!(!config.panel_collapsed);
        assert_eq!(config.person_history_count, 3);
    }

    #[test]
    fn rejects_non_http_connect_api_url_patches() {
        let mut config = AppConfig {
            connect_api_url: "https://example.test/connect".to_string(),
            ..AppConfig::default()
        };

        config.apply_patch(ConfigPatch {
            connect_api_url: Some("ws://127.0.0.1:17878".to_string()),
            opacity: None,
            font_size: None,
            panel_collapsed: None,
            person_history_count: None,
        });

        assert_eq!(config.connect_api_url, "https://example.test/connect");
    }

    #[test]
    fn migrates_legacy_websocket_url_to_connect_api_url_when_loading_json() {
        let config: AppConfig = serde_json::from_str(
            r#"{
                "websocketUrl": "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=abc",
                "opacity": 0.82,
                "fontSize": 14,
                "panelCollapsed": false
            }"#,
        )
        .expect("legacy config should deserialize");

        assert_eq!(
            config.connect_api_url,
            "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=abc"
        );
        assert_eq!(config.person_history_count, 1);
    }

    #[test]
    fn rejects_windows_hidden_window_geometry() {
        assert!(!should_persist_window_position(-32000, -32000));
        assert!(!should_persist_window_size(144, 19));
    }

    #[test]
    fn sanitizes_hidden_window_geometry_from_loaded_config() {
        let mut config = AppConfig {
            panel_collapsed: true,
            window_x: Some(-32000),
            window_y: Some(-32000),
            window_width: Some(144),
            window_height: Some(19),
            ..AppConfig::default()
        };

        config.sanitize_window_geometry();

        assert_eq!(config.window_x, None);
        assert_eq!(config.window_y, None);
        assert_eq!(config.window_width, None);
        assert_eq!(config.window_height, None);
        assert!(!config.panel_collapsed);
    }
}
