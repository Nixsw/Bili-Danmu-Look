use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingDanmuRaw {
    pub content: String,
    pub uid: Value,
    pub nickname: String,
    pub user_level: u8,
    pub fan_level: u8,
    pub guard_type: u8,
    #[serde(default)]
    pub message_type: MessageType,
    #[serde(default)]
    pub super_chat: Option<SuperChatInfo>,
    pub timestamp_ms: Option<i64>,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MessageType {
    Danmu,
    SuperChat,
}

impl Default for MessageType {
    fn default() -> Self {
        Self::Danmu
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuperChatInfo {
    pub id: Option<String>,
    pub price: Option<u64>,
    pub start_time_ms: Option<i64>,
    pub end_time_ms: Option<i64>,
    pub duration_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmuMessage {
    pub message_id: u64,
    pub content: String,
    pub uid: String,
    pub nickname: String,
    pub user_level: u8,
    pub fan_level: u8,
    pub guard_type: u8,
    pub message_type: MessageType,
    pub super_chat: Option<SuperChatInfo>,
    pub timestamp_ms: i64,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonPanelSnapshot {
    pub selected_uid: Option<String>,
    pub selected_nickname: Option<String>,
    pub anchor_message_id: Option<u64>,
    pub hover_frozen: bool,
    pub visible_messages: Vec<DanmuMessage>,
    pub hidden_newer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub connected: bool,
    pub connection_status: String,
    pub main_visible: Vec<DanmuMessage>,
    pub first_unread_message_id: Option<u64>,
    pub main_hidden_newer_count: usize,
    pub main_viewport_revision: u64,
    pub main_viewport_motion: Option<MainViewportMotion>,
    pub person_panel: PersonPanelSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MainViewportMotion {
    Advance,
    Locate,
}

pub fn normalize_incoming(raw: IncomingDanmuRaw, message_id: u64) -> Result<DanmuMessage, String> {
    let content_len = raw.content.chars().count();
    let max_content_len = if raw.message_type == MessageType::SuperChat {
        120
    } else {
        40
    };
    if !(1..=max_content_len).contains(&content_len) {
        return Err(format!(
            "content length must be between 1 and {max_content_len} characters"
        ));
    }
    if raw.user_level > 100 {
        return Err("userLevel must be between 0 and 100".to_string());
    }
    if raw.fan_level > 120 {
        return Err("fanLevel must be between 0 and 120".to_string());
    }
    if raw.guard_type > 3 {
        return Err("guardType must be between 0 and 3".to_string());
    }

    let uid = match raw.uid {
        Value::String(value) => value,
        Value::Number(value) => value.to_string(),
        _ => return Err("uid must be a string or number".to_string()),
    };

    let timestamp_ms = raw
        .timestamp_ms
        .or_else(|| raw.timestamp.map(|seconds| seconds * 1000))
        .unwrap_or_else(now_ms);

    Ok(DanmuMessage {
        message_id,
        content: raw.content,
        uid,
        nickname: raw.nickname,
        user_level: raw.user_level,
        fan_level: raw.fan_level,
        guard_type: raw.guard_type,
        message_type: raw.message_type,
        super_chat: raw.super_chat,
        timestamp_ms,
        read: false,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw() -> IncomingDanmuRaw {
        IncomingDanmuRaw {
            content: "你好".to_string(),
            uid: json!(100000001u64),
            nickname: "观众A".to_string(),
            user_level: 12,
            fan_level: 8,
            guard_type: 0,
            message_type: MessageType::Danmu,
            super_chat: None,
            timestamp_ms: Some(1_700_000_000_123),
            timestamp: None,
        }
    }

    #[test]
    fn accepts_official_fan_level_upper_bound() {
        let mut raw = raw();
        raw.fan_level = 120;

        let message = normalize_incoming(raw, 1).expect("fan level 120 should be accepted");

        assert_eq!(message.fan_level, 120);
    }

    #[test]
    fn rejects_fan_level_above_official_range() {
        let mut raw = raw();
        raw.fan_level = 121;

        let error = normalize_incoming(raw, 1).expect_err("fan level 121 should be rejected");

        assert!(error.contains("fanLevel"));
        assert!(error.contains("120"));
    }

    #[test]
    fn normalizes_super_chat_metadata_as_independent_message_type() {
        let mut raw = raw();
        raw.message_type = MessageType::SuperChat;
        raw.content = "这是一条醒目留言".to_string();
        raw.super_chat = Some(SuperChatInfo {
            id: Some("9001".to_string()),
            price: Some(30),
            start_time_ms: Some(1_700_000_000_000),
            end_time_ms: Some(1_700_000_060_000),
            duration_sec: Some(60),
        });

        let message = normalize_incoming(raw, 10).expect("super chat should normalize");

        assert_eq!(message.message_type, MessageType::SuperChat);
        assert_eq!(
            message.super_chat.expect("super chat metadata").price,
            Some(30)
        );
    }
}
