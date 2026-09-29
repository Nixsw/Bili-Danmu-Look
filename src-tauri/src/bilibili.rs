use crate::models::{IncomingDanmuRaw, MessageType, SuperChatInfo};
use brotli::Decompressor;
use flate2::read::ZlibDecoder;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

const PROTOCOL_PLAIN: u16 = 0;
const PROTOCOL_POPULARITY: u16 = 1;
const PROTOCOL_ZLIB: u16 = 2;
const PROTOCOL_BROTLI: u16 = 3;
const OP_HEARTBEAT: u32 = 2;
const OP_HEARTBEAT_RESPONSE: u32 = 3;
const OP_NOTIFICATION: u32 = 5;
const OP_ROOM_ENTER: u32 = 7;
const OP_ROOM_ENTER_RESPONSE: u32 = 8;
const PACKET_HEADER_LEN: usize = 16;
pub const CONNECT_API_HTTP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectInfo {
    pub token: String,
    pub uid: u64,
    pub room_id: u64,
    pub wsurl: String,
    pub anchor_name: Option<String>,
}

#[derive(Debug, Default)]
pub struct ConnectApiCache {
    pub last_request_at: Option<Instant>,
    pub last_success: Option<ConnectInfo>,
}

impl ConnectApiCache {
    pub fn clear_success_after_ws_failure(&mut self) {
        self.last_success = None;
    }
}

#[derive(Debug, Clone)]
pub struct Packet {
    pub protocol_version: u16,
    pub operation: u32,
    pub body: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct FrameEvents {
    pub events: Vec<ParsedNotificationEvent>,
    pub heartbeat_response: bool,
    pub room_enter_response: bool,
    pub other_notifications: usize,
}

#[derive(Debug, Clone)]
pub struct ParsedNotificationEvent {
    pub cmd: String,
    pub raw: IncomingDanmuRaw,
    pub confirmed_paths: Vec<ConfirmedPath>,
    pub warnings: Vec<String>,
    pub raw_json: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedPath {
    pub field: String,
    pub path: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEventReport {
    pub cmd: String,
    pub recv_ms: i64,
    pub confirmed_paths: Vec<ConfirmedPath>,
    pub warnings: Vec<String>,
    pub raw_json: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeConnectionInfo {
    pub uid: u64,
    pub room_id: u64,
    pub wsurl: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub connect: ProbeConnectionInfo,
    pub started_ms: i64,
    pub ended_ms: i64,
    pub danmu_samples: Vec<ProbeEventReport>,
    pub super_chat_samples: Vec<ProbeEventReport>,
    pub other_notifications: usize,
    pub super_chat_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProbeOptions {
    pub min_danmu_samples: usize,
    pub max_duration: Duration,
}

impl Default for ProbeOptions {
    fn default() -> Self {
        Self {
            min_danmu_samples: 5,
            max_duration: Duration::from_secs(30),
        }
    }
}

pub fn is_http_connect_api_url(value: &str) -> bool {
    Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn is_ws_url(value: &str) -> bool {
    Url::parse(value)
        .map(|url| matches!(url.scheme(), "ws" | "wss"))
        .unwrap_or(false)
}

pub fn parse_connect_api_response(text: &str) -> Result<ConnectInfo, String> {
    let response: Value = serde_json::from_str(text)
        .map_err(|error| format!("连接接口返回 JSON 解析失败：{error}"))?;
    let token = string_at_paths(&response, &["token", "data.token"])
        .ok_or_else(|| "连接接口返回 token 为空".to_string())?;
    if token.trim().is_empty() {
        return Err("连接接口返回 token 为空".to_string());
    }
    let wsurl = ws_url_at_paths(
        &response,
        &[
            "wsurl",
            "ws_url",
            "data.wsurl",
            "data.ws_url",
            "data.host_list",
        ],
    )
    .ok_or_else(|| "连接接口返回 wsurl 必须包含 ws:// 或 wss://".to_string())?;
    if !is_ws_url(&wsurl) {
        return Err("连接接口返回 wsurl 必须是 ws:// 或 wss://".to_string());
    }
    let uid = u64_at_paths(
        &response,
        &[
            "uid",
            "mid",
            "user_id",
            "userId",
            "data.uid",
            "data.mid",
            "data.user_id",
            "data.userId",
        ],
    )
    .unwrap_or(0);
    let room_id = u64_at_paths(
        &response,
        &[
            "room_id",
            "roomid",
            "roomId",
            "data.room_id",
            "data.roomid",
            "data.roomId",
        ],
    )
    .ok_or_else(|| "连接接口 room_id 无效".to_string())?;
    let anchor_name = ["anchor_name", "data.anchor_name"]
        .iter()
        .filter_map(|path| value_at_path(&response, path).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_owned);

    Ok(ConnectInfo {
        token,
        uid,
        room_id,
        wsurl,
        anchor_name,
    })
}

fn string_at_paths(root: &Value, paths: &[&str]) -> Option<String> {
    paths
        .iter()
        .filter_map(|path| value_at_path(root, path))
        .find_map(value_to_string)
}

fn u64_at_paths(root: &Value, paths: &[&str]) -> Option<u64> {
    paths
        .iter()
        .filter_map(|path| value_at_path(root, path))
        .find_map(value_to_u64)
}

fn ws_url_at_paths(root: &Value, paths: &[&str]) -> Option<String> {
    paths
        .iter()
        .filter_map(|path| value_at_path(root, path))
        .find_map(first_ws_url)
}

fn first_ws_url(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if is_ws_url(value) => Some(value.clone()),
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .find(|value| is_ws_url(value))
            .map(ToOwned::to_owned),
        _ => None,
    }
}

#[cfg(test)]
pub fn connect_api_wait_duration(
    last_request_at: Option<Instant>,
    cached: Option<&ConnectInfo>,
    now: Instant,
) -> Option<Duration> {
    let _ = (last_request_at, cached, now);
    None
}

#[cfg(test)]
pub fn cached_connect_info_during_cooldown<'a>(
    last_request_at: Option<Instant>,
    cached: Option<&'a ConnectInfo>,
    now: Instant,
) -> Option<&'a ConnectInfo> {
    let _ = (last_request_at, cached, now);
    None
}

pub async fn resolve_connect_info(
    connect_api_url: &str,
    cache: Arc<Mutex<ConnectApiCache>>,
) -> Result<ConnectInfo, String> {
    if !is_http_connect_api_url(connect_api_url) {
        return Err("接口地址必须是 http:// 或 https://".to_string());
    }

    {
        let mut guard = cache.lock().map_err(|error| error.to_string())?;
        guard.last_request_at = Some(Instant::now());
    }

    let client = reqwest::Client::builder()
        .timeout(CONNECT_API_HTTP_TIMEOUT)
        .build()
        .map_err(|error| format!("连接接口客户端创建失败：{error}"))?;
    let text = client
        .get(connect_api_url)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "连接接口请求超时".to_string()
            } else {
                format!("连接接口请求失败：{error}")
            }
        })?
        .error_for_status()
        .map_err(|error| format!("连接接口 HTTP 状态失败：{error}"))?
        .text()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "连接接口请求超时".to_string()
            } else {
                format!("连接接口读取失败：{error}")
            }
        })?;
    let info = parse_connect_api_response(&text)?;

    {
        let mut guard = cache.lock().map_err(|error| error.to_string())?;
        guard.last_success = Some(info.clone());
    }

    Ok(info)
}

pub fn clear_cached_connect_info_after_ws_failure(
    cache: &Arc<Mutex<ConnectApiCache>>,
) -> Result<(), String> {
    let mut guard = cache.lock().map_err(|error| error.to_string())?;
    guard.clear_success_after_ws_failure();
    Ok(())
}

pub fn build_enter_packet(uid: u64, room_id: u64, token: &str) -> Vec<u8> {
    let body = json!({
        "uid": uid,
        "buvid": "",
        "roomid": room_id,
        "protover": 3,
        "platform": "danmuji",
        "type": 2,
        "key": token,
    });
    let body = serde_json::to_vec(&body).unwrap_or_default();
    build_packet(PROTOCOL_POPULARITY, OP_ROOM_ENTER, &body)
}

pub fn build_heartbeat_packet() -> Vec<u8> {
    build_packet(PROTOCOL_POPULARITY, OP_HEARTBEAT, &[])
}

fn build_packet(protocol_version: u16, operation: u32, body: &[u8]) -> Vec<u8> {
    let mut raw = vec![0u8; PACKET_HEADER_LEN];
    let packet_len = PACKET_HEADER_LEN + body.len();
    raw[0..4].copy_from_slice(&(packet_len as u32).to_be_bytes());
    raw[4..6].copy_from_slice(&(PACKET_HEADER_LEN as u16).to_be_bytes());
    raw[6..8].copy_from_slice(&protocol_version.to_be_bytes());
    raw[8..12].copy_from_slice(&operation.to_be_bytes());
    raw[12..16].copy_from_slice(&1u32.to_be_bytes());
    raw.extend_from_slice(body);
    raw
}

pub fn decode_frame(data: &[u8]) -> Result<FrameEvents, String> {
    let packet = decode_packet(data)?;
    let packets = expand_packet(packet)?;
    let mut frame = FrameEvents::default();

    for packet in packets {
        match packet.operation {
            OP_NOTIFICATION => {
                if let Some(event) = parse_notification_event(&packet.body) {
                    frame.events.push(event);
                } else {
                    frame.other_notifications += 1;
                }
            }
            OP_HEARTBEAT_RESPONSE => frame.heartbeat_response = true,
            OP_ROOM_ENTER_RESPONSE => frame.room_enter_response = true,
            _ => {}
        }
    }

    Ok(frame)
}

fn decode_packet(data: &[u8]) -> Result<Packet, String> {
    if data.len() < PACKET_HEADER_LEN {
        return Err("Bilibili packet 长度不足".to_string());
    }
    let packet_len = u32::from_be_bytes(data[0..4].try_into().unwrap()) as usize;
    if packet_len != data.len() || packet_len < PACKET_HEADER_LEN {
        return Err("Bilibili packet 长度不匹配".to_string());
    }
    let protocol_version = u16::from_be_bytes(data[6..8].try_into().unwrap());
    let operation = u32::from_be_bytes(data[8..12].try_into().unwrap());

    Ok(Packet {
        protocol_version,
        operation,
        body: data[PACKET_HEADER_LEN..packet_len].to_vec(),
    })
}

fn expand_packet(packet: Packet) -> Result<Vec<Packet>, String> {
    match packet.protocol_version {
        PROTOCOL_PLAIN | PROTOCOL_POPULARITY => Ok(vec![packet]),
        PROTOCOL_ZLIB => {
            let mut decoder = ZlibDecoder::new(packet.body.as_slice());
            let mut decoded = Vec::new();
            decoder
                .read_to_end(&mut decoded)
                .map_err(|error| format!("zlib 解压失败：{error}"))?;
            slice_packets(&decoded)
        }
        PROTOCOL_BROTLI => {
            let mut decoder = Decompressor::new(packet.body.as_slice(), 4096);
            let mut decoded = Vec::new();
            decoder
                .read_to_end(&mut decoded)
                .map_err(|error| format!("brotli 解压失败：{error}"))?;
            slice_packets(&decoded)
        }
        _ => Err(format!(
            "未知 Bilibili protocolVersion：{}",
            packet.protocol_version
        )),
    }
}

fn slice_packets(data: &[u8]) -> Result<Vec<Packet>, String> {
    let mut packets = Vec::new();
    let mut cursor = 0usize;
    while cursor < data.len() {
        if cursor + 4 > data.len() {
            return Err("Bilibili packet 分片长度不足".to_string());
        }
        let packet_len = u32::from_be_bytes(data[cursor..cursor + 4].try_into().unwrap()) as usize;
        if packet_len == 0 || cursor + packet_len > data.len() {
            return Err("Bilibili packet 分片长度不匹配".to_string());
        }
        packets.push(decode_packet(&data[cursor..cursor + packet_len])?);
        cursor += packet_len;
    }
    Ok(packets)
}

pub fn parse_notification_event(body: &[u8]) -> Option<ParsedNotificationEvent> {
    let raw_json: Value = serde_json::from_slice(body).ok()?;
    let cmd = raw_json
        .get("cmd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .to_string();

    match cmd.as_str() {
        "DANMU_MSG" => parse_danmu_event(cmd, raw_json),
        "SUPER_CHAT_MESSAGE" => parse_super_chat_event(cmd, raw_json),
        _ => None,
    }
}

fn parse_danmu_event(cmd: String, raw_json: Value) -> Option<ParsedNotificationEvent> {
    let mut confirmed_paths = Vec::new();
    let mut warnings = Vec::new();
    let content = string_from_candidates(
        &raw_json,
        "content",
        &["info.1", "info.0.15.extra.content"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let uid = value_from_candidates(
        &raw_json,
        "uid",
        &["info.2.0"],
        &mut confirmed_paths,
        &mut warnings,
    )
    .cloned()
    .unwrap_or_else(|| json!(0));
    let nickname = string_from_candidates(
        &raw_json,
        "nickname",
        &["info.2.1"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let user_level = u8_from_candidates(
        &raw_json,
        "userLevel",
        &["info.16.0", "info.4.0", "info.2.16.0"],
        100,
        &mut confirmed_paths,
        &mut warnings,
    );
    let fan_level = u8_from_candidates(
        &raw_json,
        "fanLevel",
        &["info.3.0"],
        120,
        &mut confirmed_paths,
        &mut warnings,
    );
    let guard_type = u8_from_candidates(
        &raw_json,
        "guardType",
        &["info.7"],
        3,
        &mut confirmed_paths,
        &mut warnings,
    );
    let timestamp = i64_from_candidates(
        &raw_json,
        "timestamp",
        &["info.0.4"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let (timestamp_ms, timestamp) = split_unix_timestamp(timestamp);

    Some(ParsedNotificationEvent {
        cmd,
        raw: IncomingDanmuRaw {
            content,
            uid,
            nickname,
            user_level,
            fan_level,
            guard_type,
            message_type: MessageType::Danmu,
            super_chat: None,
            timestamp_ms,
            timestamp,
        },
        confirmed_paths,
        warnings,
        raw_json,
    })
}

fn parse_super_chat_event(cmd: String, raw_json: Value) -> Option<ParsedNotificationEvent> {
    let mut confirmed_paths = Vec::new();
    let mut warnings = Vec::new();
    let content = string_from_candidates(
        &raw_json,
        "content",
        &["data.message"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let uid = value_from_candidates(
        &raw_json,
        "uid",
        &["data.uid"],
        &mut confirmed_paths,
        &mut warnings,
    )
    .cloned()
    .unwrap_or_else(|| json!(0));
    let nickname = string_from_candidates(
        &raw_json,
        "nickname",
        &["data.user_info.uname"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let user_level = u8_from_candidates(
        &raw_json,
        "userLevel",
        &["data.user_info.user_level"],
        100,
        &mut confirmed_paths,
        &mut warnings,
    );
    let fan_level = u8_from_candidates(
        &raw_json,
        "fanLevel",
        &["data.medal_info.medal_level"],
        120,
        &mut confirmed_paths,
        &mut warnings,
    );
    let guard_type = u8_from_candidates(
        &raw_json,
        "guardType",
        &["data.medal_info.guard_level", "data.user_info.guard_level"],
        3,
        &mut confirmed_paths,
        &mut warnings,
    );
    let start_time = i64_from_candidates(
        &raw_json,
        "timestamp",
        &["data.start_time", "data.ts"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let end_time = i64_from_candidates(
        &raw_json,
        "superChat.endTime",
        &["data.end_time"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let duration_sec = u64_from_candidates(
        &raw_json,
        "superChat.durationSec",
        &["data.time"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let price = u64_from_candidates(
        &raw_json,
        "superChat.price",
        &["data.price"],
        &mut confirmed_paths,
        &mut warnings,
    );
    let id = string_from_candidates(
        &raw_json,
        "superChat.id",
        &["data.id", "data.token"],
        &mut confirmed_paths,
        &mut warnings,
    );

    Some(ParsedNotificationEvent {
        cmd,
        raw: IncomingDanmuRaw {
            content,
            uid,
            nickname,
            user_level,
            fan_level,
            guard_type,
            message_type: MessageType::SuperChat,
            super_chat: Some(SuperChatInfo {
                id: (!id.is_empty()).then_some(id),
                price,
                start_time_ms: start_time.map(|seconds| seconds * 1000),
                end_time_ms: end_time.map(|seconds| seconds * 1000),
                duration_sec,
            }),
            timestamp_ms: None,
            timestamp: start_time,
        },
        confirmed_paths,
        warnings,
        raw_json,
    })
}

pub fn analyze_notification_event(
    event: &ParsedNotificationEvent,
    recv_ms: i64,
) -> ProbeEventReport {
    ProbeEventReport {
        cmd: event.cmd.clone(),
        recv_ms,
        confirmed_paths: event.confirmed_paths.clone(),
        warnings: event.warnings.clone(),
        raw_json: event.raw_json.clone(),
    }
}

pub async fn run_probe_once(
    connect_api_url: &str,
    cache: Arc<Mutex<ConnectApiCache>>,
    options: ProbeOptions,
) -> Result<ProbeReport, String> {
    let connect_info = resolve_connect_info(connect_api_url, cache).await?;
    let started_ms = now_ms();
    let (mut stream, _) = connect_async(connect_info.wsurl.as_str())
        .await
        .map_err(|error| format!("Bilibili WebSocket 连接失败：{error}"))?;
    stream
        .send(Message::Binary(
            build_enter_packet(connect_info.uid, connect_info.room_id, &connect_info.token).into(),
        ))
        .await
        .map_err(|error| format!("Bilibili 入房包发送失败：{error}"))?;

    let started = Instant::now();
    let mut danmu_samples = Vec::new();
    let mut super_chat_samples = Vec::new();
    let mut other_notifications = 0usize;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    let mut read_status = None;

    while started.elapsed() < options.max_duration {
        if danmu_samples.len() >= options.min_danmu_samples
            && started.elapsed() >= Duration::from_secs(8)
        {
            break;
        }

        tokio::select! {
            _ = heartbeat.tick() => {
                if let Err(error) = stream
                    .send(Message::Binary(build_heartbeat_packet().into()))
                    .await
                {
                    read_status = Some(format!("心跳失败：{error}"));
                    break;
                }
            }
            next = stream.next() => {
                let Some(next) = next else {
                    read_status = Some("WebSocket 已关闭".to_string());
                    break;
                };
                let message = match next {
                    Ok(message) => message,
                    Err(error) => {
                        read_status = Some(format!("WebSocket 读取结束：{error}"));
                        break;
                    }
                };
                if let Message::Binary(data) = message {
                    let frame = decode_frame(&data)?;
                    other_notifications += frame.other_notifications;
                    for event in frame.events {
                        let report = analyze_notification_event(&event, now_ms());
                        match event.cmd.as_str() {
                            "DANMU_MSG" if danmu_samples.len() < options.min_danmu_samples => {
                                danmu_samples.push(report);
                            }
                            "SUPER_CHAT_MESSAGE" => super_chat_samples.push(report),
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    let mut super_chat_status = if super_chat_samples.is_empty() {
        "未捕获 SC 样本".to_string()
    } else {
        "已捕获 SC 样本".to_string()
    };
    if let Some(status) = read_status {
        super_chat_status.push('；');
        super_chat_status.push_str(&status);
    }

    Ok(ProbeReport {
        connect: ProbeConnectionInfo {
            uid: connect_info.uid,
            room_id: connect_info.room_id,
            wsurl: connect_info.wsurl,
        },
        started_ms,
        ended_ms: now_ms(),
        danmu_samples,
        super_chat_status,
        super_chat_samples,
        other_notifications,
        report_path: None,
    })
}

fn value_from_candidates<'a>(
    root: &'a Value,
    field: &str,
    paths: &[&str],
    confirmed_paths: &mut Vec<ConfirmedPath>,
    warnings: &mut Vec<String>,
) -> Option<&'a Value> {
    for path in paths {
        if let Some(value) = value_at_path(root, path) {
            confirmed_paths.push(ConfirmedPath {
                field: field.to_string(),
                path: (*path).to_string(),
                value: format_value(value),
            });
            return Some(value);
        }
    }
    warnings.push(format!("{field} 未在候选路径中找到，已降级"));
    None
}

fn string_from_candidates(
    root: &Value,
    field: &str,
    paths: &[&str],
    confirmed_paths: &mut Vec<ConfirmedPath>,
    warnings: &mut Vec<String>,
) -> String {
    value_from_candidates(root, field, paths, confirmed_paths, warnings)
        .and_then(value_to_string)
        .unwrap_or_default()
}

fn u8_from_candidates(
    root: &Value,
    field: &str,
    paths: &[&str],
    max: u8,
    confirmed_paths: &mut Vec<ConfirmedPath>,
    warnings: &mut Vec<String>,
) -> u8 {
    value_from_candidates(root, field, paths, confirmed_paths, warnings)
        .and_then(value_to_u64)
        .map(|value| value.min(max as u64) as u8)
        .unwrap_or(0)
}

fn u64_from_candidates(
    root: &Value,
    field: &str,
    paths: &[&str],
    confirmed_paths: &mut Vec<ConfirmedPath>,
    warnings: &mut Vec<String>,
) -> Option<u64> {
    value_from_candidates(root, field, paths, confirmed_paths, warnings).and_then(value_to_u64)
}

fn i64_from_candidates(
    root: &Value,
    field: &str,
    paths: &[&str],
    confirmed_paths: &mut Vec<ConfirmedPath>,
    warnings: &mut Vec<String>,
) -> Option<i64> {
    value_from_candidates(root, field, paths, confirmed_paths, warnings).and_then(value_to_i64)
}

fn value_at_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = root;
    for segment in path.split('.') {
        current = if let Ok(index) = segment.parse::<usize>() {
            current.as_array()?.get(index)?
        } else {
            current.get(segment)?
        };
    }
    Some(current)
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_to_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(value) => value.as_u64().or_else(|| {
            value
                .as_i64()
                .and_then(|value| (value >= 0).then_some(value as u64))
        }),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn value_to_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(value) => value
            .as_i64()
            .or_else(|| value.as_u64().map(|value| value as i64)),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn split_unix_timestamp(value: Option<i64>) -> (Option<i64>, Option<i64>) {
    match value {
        Some(value) if value >= 10_000_000_000 => (Some(value), None),
        Some(value) => (None, Some(value)),
        None => (None, None),
    }
}

fn format_value(value: &Value) -> String {
    value_to_string(value).unwrap_or_else(|| value.to_string())
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
    use std::time::{Duration, Instant};
    use std::{env, fs, path::PathBuf};

    #[test]
    fn parses_connect_api_response_and_validates_url_schemes() {
        let info = parse_connect_api_response(
            r#"{
                "token": "danmu-token",
                "uid": 10001,
                "room_id": "23058",
                "wsurl": "wss://broadcastlv.chat.bilibili.com/sub"
            }"#,
        )
        .expect("response should parse");

        assert_eq!(info.token, "danmu-token");
        assert_eq!(info.uid, 10001);
        assert_eq!(info.room_id, 23058);
        assert_eq!(info.wsurl, "wss://broadcastlv.chat.bilibili.com/sub");
        assert_eq!(info.anchor_name, None);
        let array_info = parse_connect_api_response(
            r#"{
                "token": "danmu-token",
                "uid": 10001,
                "room_id": 23058,
                "wsurl": [
                    "wss://broadcastlv.chat.bilibili.com/sub",
                    "wss://broadcastlv.chat.bilibili.com/sub2"
                ]
            }"#,
        )
        .expect("array response should parse");
        assert_eq!(array_info.wsurl, "wss://broadcastlv.chat.bilibili.com/sub");
        let wrapped_info = parse_connect_api_response(
            r#"{
                "code": 0,
                "data": {
                    "token": "danmu-token",
                    "uid": "10001",
                    "roomid": 23058,
                    "wsurl": ["wss://broadcastlv.chat.bilibili.com/sub"]
                }
            }"#,
        )
        .expect("wrapped response should parse");
        assert_eq!(wrapped_info.uid, 10001);
        assert_eq!(wrapped_info.room_id, 23058);
        let anonymous_info = parse_connect_api_response(
            r#"{
                "token": "danmu-token",
                "room_id": 23058,
                "mid": 3691005912025498,
                "wsurl": "wss://broadcastlv.chat.bilibili.com/sub"
            }"#,
        )
        .expect("mid should be accepted as uid");
        assert_eq!(anonymous_info.uid, 3691005912025498);
        let anonymous_info = parse_connect_api_response(
            r#"{
                "token": "danmu-token",
                "room_id": 23058,
                "wsurl": "wss://broadcastlv.chat.bilibili.com/sub"
            }"#,
        )
        .expect("missing uid and mid should fall back to anonymous uid");
        assert_eq!(anonymous_info.uid, 0);
        assert!(is_http_connect_api_url(
            "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=abc"
        ));
        assert!(!is_http_connect_api_url("ws://127.0.0.1:17878"));
    }

    #[test]
    fn parses_optional_anchor_name_from_top_level_or_wrapped_response() {
        for (metadata, expected) in [
            (json!({ "anchor_name": "  阿萨Aza  " }), Some("阿萨Aza")),
            (
                json!({ "data": { "anchor_name": "另一位主播" } }),
                Some("另一位主播"),
            ),
            (
                json!({ "anchor_name": "优先顶层", "data": { "anchor_name": "包装字段" } }),
                Some("优先顶层"),
            ),
            (json!({}), None),
            (json!({ "anchor_name": " \t\n " }), None),
            (json!({ "anchor_name": null }), None),
            (json!({ "anchor_name": 123 }), None),
            (json!({ "anchor_name": true }), None),
        ] {
            let mut response = json!({
                "token": "test-token",
                "mid": 10001,
                "room_id": 23058,
                "wsurl": "wss://example.test/sub"
            });
            response
                .as_object_mut()
                .unwrap()
                .extend(metadata.as_object().unwrap().clone());

            let info = parse_connect_api_response(&response.to_string()).unwrap();

            assert_eq!(info.anchor_name.as_deref(), expected);
            assert_eq!(info.uid, 10001);
            assert_eq!(info.room_id, 23058);
        }

        let wrapped = parse_connect_api_response(
            r#"{"data":{"token":"test-token","mid":10001,"room_id":23058,"wsurl":"wss://example.test/sub","anchor_name":"  包装主播  "}}"#,
        )
        .unwrap();
        assert_eq!(wrapped.anchor_name.as_deref(), Some("包装主播"));
    }

    #[test]
    fn does_not_apply_local_cooldown_after_connect_api_failure() {
        let last_request = Instant::now();

        assert_eq!(
            connect_api_wait_duration(
                Some(last_request),
                None,
                last_request + Duration::from_secs(3)
            ),
            None
        );
    }

    #[test]
    fn does_not_reuse_cached_connect_info_for_ws_reconnects() {
        let last_request = Instant::now();
        let cached = ConnectInfo {
            token: "cached-token".to_string(),
            uid: 1,
            room_id: 2,
            wsurl: "wss://example.test/sub".to_string(),
            anchor_name: None,
        };

        assert!(cached_connect_info_during_cooldown(
            Some(last_request),
            Some(&cached),
            last_request + Duration::from_secs(3)
        )
        .is_none());
    }

    #[test]
    fn connect_api_http_timeout_is_twenty_seconds() {
        assert_eq!(CONNECT_API_HTTP_TIMEOUT, Duration::from_secs(20));
    }

    #[test]
    fn clearing_cached_connect_info_after_ws_failure_forces_next_api_fetch() {
        let last_request = Instant::now();
        let mut cache = ConnectApiCache {
            last_request_at: Some(last_request),
            last_success: Some(ConnectInfo {
                token: "stale-token".to_string(),
                uid: 1,
                room_id: 2,
                wsurl: "wss://example.test/sub".to_string(),
                anchor_name: None,
            }),
        };

        cache.clear_success_after_ws_failure();

        assert!(cache.last_success.is_none());
        assert_eq!(
            connect_api_wait_duration(
                cache.last_request_at,
                cache.last_success.as_ref(),
                last_request + Duration::from_secs(3)
            ),
            None
        );
    }

    #[test]
    fn builds_enter_and_heartbeat_packets_with_bilibili_operation_codes() {
        let enter = build_enter_packet(10001, 23058, "danmu-token");
        let heartbeat = build_heartbeat_packet();

        assert_eq!(&enter[4..6], &[0, 16]);
        assert_eq!(&enter[8..12], &[0, 0, 0, 7]);
        assert!(String::from_utf8_lossy(&enter).contains(r#""roomid":23058"#));
        assert!(String::from_utf8_lossy(&enter).contains(r#""key":"danmu-token""#));
        assert_eq!(&heartbeat[8..12], &[0, 0, 0, 2]);
    }

    #[test]
    fn extracts_notification_events_and_records_confirmed_danmu_paths() {
        let body = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1700000000123_i64, 0, 0, "id", 0, 0, 0, "", 0, "{}"],
                "联调字段路径",
                [10001, "观众A", 0, 0, 0, 0, 0, "", 0, 0, 0, 0, 0, 0, 0, 0, [12]],
                [8, "粉丝牌", "主播", 23058],
                [11, 0, 0, 0],
                [],
                0,
                3,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                624,
                [24],
                null
            ]
        });

        let event = parse_notification_event(&serde_json::to_vec(&body).unwrap())
            .expect("danmu event should parse");
        let report = analyze_notification_event(&event, 1_700_000_001_000);

        assert_eq!(event.raw.content, "联调字段路径");
        assert_eq!(event.raw.user_level, 24);
        assert_eq!(event.raw.fan_level, 8);
        assert_eq!(event.raw.guard_type, 3);
        assert_eq!(event.raw.timestamp_ms, Some(1_700_000_000_123));
        assert_eq!(event.raw.timestamp, None);
        assert!(report.confirmed_paths.iter().any(|path| {
            path.field == "userLevel" && path.path == "info.16.0" && path.value == "24"
        }));
        assert!(!report
            .confirmed_paths
            .iter()
            .any(|path| path.field == "userLevel" && path.path == "info.4.0"));
    }

    #[test]
    fn extracts_super_chat_as_independent_message_with_metadata() {
        let body = json!({
            "cmd": "SUPER_CHAT_MESSAGE",
            "data": {
                "id": 9001,
                "uid": 10002,
                "message": "SC来了",
                "price": 30,
                "start_time": 1700000000,
                "end_time": 1700000060,
                "time": 60,
                "user_info": { "uname": "醒目用户", "user_level": 52 },
                "medal_info": { "medal_level": 12, "guard_level": 1 }
            }
        });

        let event = parse_notification_event(&serde_json::to_vec(&body).unwrap())
            .expect("super chat event should parse");

        assert_eq!(
            event.raw.message_type,
            crate::models::MessageType::SuperChat
        );
        assert_eq!(event.raw.content, "SC来了");
        assert_eq!(event.raw.nickname, "醒目用户");
        assert_eq!(event.raw.user_level, 52);
        assert_eq!(event.raw.fan_level, 12);
        assert_eq!(
            event
                .raw
                .super_chat
                .expect("super chat metadata")
                .duration_sec,
            Some(60)
        );
    }

    #[tokio::test]
    #[ignore]
    async fn live_probe_from_env_writes_report() {
        let connect_api_url = env::var("DANMUTOOLS_CONNECT_API_URL")
            .expect("set DANMUTOOLS_CONNECT_API_URL to run the live probe");
        let cache = std::sync::Arc::new(std::sync::Mutex::new(ConnectApiCache::default()));
        let connect_info = resolve_connect_info(&connect_api_url, cache.clone())
            .await
            .expect("live connect api should resolve");
        println!(
            "connect info: uid={}, room_id={}, wsurl={}",
            connect_info.uid, connect_info.room_id, connect_info.wsurl
        );
        println!("connected, waiting for live DANMU_MSG / SUPER_CHAT_MESSAGE samples");
        let probe_seconds = env::var("DANMUTOOLS_PROBE_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(30)
            .clamp(10, 600);
        let min_danmu_samples = env::var("DANMUTOOLS_PROBE_MIN_DANMU")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(ProbeOptions::default().min_danmu_samples)
            .clamp(1, 20);
        let mut report = run_probe_once(
            &connect_api_url,
            cache,
            ProbeOptions {
                min_danmu_samples,
                max_duration: Duration::from_secs(probe_seconds),
                ..ProbeOptions::default()
            },
        )
        .await
        .expect("live probe should complete");
        let report_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("bilibili-probe-report.json");
        report.report_path = Some(report_path.to_string_lossy().to_string());
        fs::create_dir_all(report_path.parent().expect("target dir should exist"))
            .expect("target dir should be created");
        fs::write(
            &report_path,
            serde_json::to_string_pretty(&report).expect("probe report should serialize"),
        )
        .expect("probe report should be written");
        println!("probe report: {}", report_path.display());
        println!(
            "danmu samples: {}, super chat samples: {}, status: {}",
            report.danmu_samples.len(),
            report.super_chat_samples.len(),
            report.super_chat_status
        );
    }
}
