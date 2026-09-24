use crate::bilibili::{
    build_enter_packet, build_heartbeat_packet, clear_cached_connect_info_after_ws_failure,
    decode_frame, is_http_connect_api_url, resolve_connect_info,
};
use crate::commands::emit_snapshot;
use crate::AppState;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, State};
use tokio::time::{sleep, timeout, Duration, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const MIN_CONNECTING_DISPLAY: Duration = Duration::from_secs(1);
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
struct RetryBackoff {
    failures: u8,
}

impl RetryBackoff {
    fn next_delay_seconds(&mut self) -> u64 {
        self.failures = self.failures.saturating_add(1);
        match self.failures {
            1 => 3,
            2 => 5,
            _ => 10,
        }
    }

    fn reset(&mut self) {
        self.failures = 0;
    }
}

enum ConnectionFailure {
    Api(String),
    WebSocket { timed_out: bool },
}

pub async fn connect_ws_inner(app: AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    disconnect_ws_inner(state)?;

    let url = {
        let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
        inner.store.set_connection("对接中...", false);
        inner.config.connect_api_url.clone()
    };
    let connect_cache = state.connect_cache.clone();
    emit_snapshot(&app, state)?;

    let inner_state = state.inner.clone();
    let app_for_task = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut backoff = RetryBackoff::default();
        loop {
            let attempt_started = Instant::now();
            if let Ok(mut inner) = inner_state.lock() {
                inner.store.set_connection("对接中...", false);
            }
            let _ = emit_snapshot_from_arc(&app_for_task, &inner_state);
            // Every failure leaves this block through the same display/backoff path.
            let failure = 'attempt: {
                let connect_info = match resolve_connect_info(&url, connect_cache.clone()).await {
                    Ok(info) => info,
                    Err(error) => break 'attempt ConnectionFailure::Api(error),
                };
                if let Ok(mut inner) = inner_state.lock() {
                    inner.store.set_connection("连接中...", false);
                }
                let _ = emit_snapshot_from_arc(&app_for_task, &inner_state);
                let (mut stream, _) = match timeout(
                    WS_CONNECT_TIMEOUT,
                    connect_async(connect_info.wsurl.as_str()),
                )
                .await
                {
                    Err(_) => break 'attempt ConnectionFailure::WebSocket { timed_out: true },
                    Ok(Err(_)) => break 'attempt ConnectionFailure::WebSocket { timed_out: false },
                    Ok(Ok(connection)) => connection,
                };
                if stream
                    .send(Message::Binary(
                        build_enter_packet(
                            connect_info.uid,
                            connect_info.room_id,
                            &connect_info.token,
                        )
                        .into(),
                    ))
                    .await
                    .is_err()
                {
                    break 'attempt ConnectionFailure::WebSocket { timed_out: false };
                }
                if let Ok(mut inner) = inner_state.lock() {
                    inner.store.set_connection("连接中...", true);
                }
                let _ = emit_snapshot_from_arc(&app_for_task, &inner_state);

                let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
                loop {
                    tokio::select! {
                        _ = heartbeat.tick() => {
                            if stream.send(Message::Binary(build_heartbeat_packet().into())).await.is_err() {
                                break 'attempt ConnectionFailure::WebSocket { timed_out: false };
                            }
                        }
                        next = stream.next() => {
                            match next {
                                Some(Ok(Message::Binary(data))) => {
                                    if let Ok(frame) = decode_frame(&data) {
                                        if frame.room_enter_response {
                                            backoff.reset();
                                            if let Ok(mut inner) = inner_state.lock() {
                                                inner.store.set_connection("已连接！", true);
                                            }
                                        }
                                        for event in frame.events {
                                            if let Ok(mut inner) = inner_state.lock() {
                                                let _ = inner.store.ingest(event.raw);
                                            }
                                        }
                                    }
                                    let _ = emit_snapshot_from_arc(&app_for_task, &inner_state);
                                }
                                Some(Ok(_)) => {}
                                Some(Err(_)) | None => {
                                    break 'attempt ConnectionFailure::WebSocket { timed_out: false };
                                }
                            }
                        }
                    }
                }
            };
            let prefix = match failure {
                ConnectionFailure::Api(error) => api_failure_label(&url, &error),
                ConnectionFailure::WebSocket { timed_out } => {
                    let _ = clear_cached_connect_info_after_ws_failure(&connect_cache);
                    ws_failure_label(timed_out)
                }
            };
            let retry_seconds = backoff.next_delay_seconds();
            wait_before_retry(&inner_state, attempt_started, prefix, retry_seconds, || {
                let _ = emit_snapshot_from_arc(&app_for_task, &inner_state);
            })
            .await;
        }
    });

    let mut guard = state.ws_task.lock().map_err(|error| error.to_string())?;
    *guard = Some(task);
    Ok(())
}

async fn wait_before_retry(
    inner_state: &std::sync::Arc<std::sync::Mutex<crate::RuntimeState>>,
    attempt_started: Instant,
    failure_label: &str,
    retry_seconds: u64,
    emit: impl FnOnce(),
) {
    // Keep fast failures readable without holding the shared store lock. Aborting
    // the connection task also cancels both waits, so an old retry cannot reappear.
    sleep(MIN_CONNECTING_DISPLAY.saturating_sub(attempt_started.elapsed())).await;
    if let Ok(mut inner) = inner_state.lock() {
        inner
            .store
            .set_connection(retry_status(failure_label, retry_seconds), false);
    }
    emit();
    sleep(Duration::from_secs(retry_seconds)).await;
}

pub fn disconnect_ws_inner(state: &State<'_, AppState>) -> Result<(), String> {
    let mut task = state.ws_task.lock().map_err(|error| error.to_string())?;
    if let Some(handle) = task.take() {
        handle.abort();
    }
    Ok(())
}

fn emit_snapshot_from_arc(
    app: &AppHandle,
    inner_state: &std::sync::Arc<std::sync::Mutex<crate::RuntimeState>>,
) -> Result<(), String> {
    let snapshot = {
        let inner = inner_state.lock().map_err(|error| error.to_string())?;
        inner.store.snapshot()
    };
    use tauri::Emitter;
    app.emit("danmu_state_changed", snapshot)
        .map_err(|error| error.to_string())
}

fn api_failure_label(connect_api_url: &str, error: &str) -> &'static str {
    if !is_http_connect_api_url(connect_api_url) || error.contains("接口地址必须") {
        "接口.未开启"
    } else if is_timeout_error(error) {
        "接口.请求超时"
    } else {
        "接口.解析异常"
    }
}

fn ws_failure_label(timed_out: bool) -> &'static str {
    if timed_out {
        "连接.请求超时"
    } else {
        "连接.意外断开"
    }
}

fn retry_status(prefix: &str, retry_seconds: u64) -> String {
    format!("{prefix}({retry_seconds})")
}

fn is_timeout_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    error.contains("超时") || lower.contains("timeout") || lower.contains("timed out")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn formats_api_retry_statuses_concisely() {
        assert_eq!(
            retry_status(
                api_failure_label("", "接口地址必须是 http:// 或 https://"),
                3
            ),
            "接口.未开启(3)"
        );
        assert_eq!(
            retry_status(
                api_failure_label("http://127.0.0.1:2333/connect", "连接接口请求超时"),
                5
            ),
            "接口.请求超时(5)"
        );
        assert_eq!(
            retry_status(
                api_failure_label(
                    "http://127.0.0.1:2333/connect",
                    "连接接口返回 JSON 解析失败"
                ),
                10
            ),
            "接口.解析异常(10)"
        );
    }

    #[test]
    fn formats_ws_retry_statuses_concisely() {
        assert_eq!(retry_status(ws_failure_label(true), 3), "连接.请求超时(3)");
        assert_eq!(retry_status(ws_failure_label(false), 5), "连接.意外断开(5)");
    }

    #[test]
    fn consecutive_failures_back_off_to_ten_seconds_and_success_resets_them() {
        let mut backoff = RetryBackoff::default();
        assert_eq!(
            (0..4)
                .map(|_| backoff.next_delay_seconds())
                .collect::<Vec<_>>(),
            [3, 5, 10, 10]
        );
        for _ in 0..300 {
            assert_eq!(backoff.next_delay_seconds(), 10);
        }
        backoff.reset();
        assert_eq!(backoff.next_delay_seconds(), 3);
        assert_eq!(backoff.next_delay_seconds(), 5);
    }

    fn runtime() -> Arc<Mutex<crate::RuntimeState>> {
        let mut store = crate::store::MessageStore::new(1000, 50);
        store.set_connection("对接中...", false);
        Arc::new(Mutex::new(crate::RuntimeState {
            store,
            config: crate::app_config::AppConfig::default(),
        }))
    }

    #[tokio::test]
    async fn fast_failure_keeps_connecting_for_one_second_then_waits_the_full_retry_delay() {
        let inner = runtime();
        let started = Instant::now();
        let mut emitted_at = None;
        wait_before_retry(&inner, started, "接口.解析异常", 3, || {
            emitted_at = Some(Instant::now());
            assert!(started.elapsed() >= MIN_CONNECTING_DISPLAY);
            assert_eq!(
                inner.lock().unwrap().store.snapshot().connection_status,
                "接口.解析异常(3)"
            );
        })
        .await;
        assert!(emitted_at.unwrap().elapsed() >= Duration::from_secs(3));
        assert!(started.elapsed() >= Duration::from_secs(4));
    }

    #[tokio::test]
    async fn cancelling_during_the_minimum_display_does_not_publish_a_stale_failure() {
        let inner = runtime();
        let task_inner = inner.clone();
        let task = tokio::spawn(async move {
            wait_before_retry(&task_inner, Instant::now(), "接口.解析异常", 3, || {}).await;
        });
        tokio::task::yield_now().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            inner.lock().unwrap().store.snapshot().connection_status,
            "对接中..."
        );
    }

    #[tokio::test]
    async fn cancelling_during_the_retry_delay_keeps_the_new_connection_state() {
        let inner = runtime();
        let task_inner = inner.clone();
        let (emitted, receive) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            wait_before_retry(
                &task_inner,
                Instant::now() - MIN_CONNECTING_DISPLAY,
                "连接.意外断开",
                10,
                || {
                    let _ = emitted.send(());
                },
            )
            .await;
        });
        receive.await.unwrap();
        task.abort();
        inner
            .lock()
            .unwrap()
            .store
            .set_connection("对接中...", false);
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            inner.lock().unwrap().store.snapshot().connection_status,
            "对接中..."
        );
    }
}
