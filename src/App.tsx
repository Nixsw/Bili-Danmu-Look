import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  LocateFixed,
  Minus,
  Settings
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createDanmuClient, type DisplayConfig } from "./api/client";
import type { AppSnapshot, DanmuMessage } from "./core/types";
import { formatHhMmSs, formatMmSs, getGuardNicknameColor } from "./ui/format";
import {
  getSplitLayout,
  isPersonPanelVisible,
  MAIN_READABLE_WIDTH,
  PERSON_PANEL_DEFAULT_WIDTH
} from "./ui/layout";
import {
  getFanMedalLevelClass,
  getFanMedalLabelClass,
  getFanMedalLayoutStyle,
  getFanMedalStyle,
  getGuardMedalIconUrl,
  getWealthMedalUrl
} from "./ui/biliBadges";
import {
  getMainUnreadAnchorAction,
  getWindowDismissAction
} from "./ui/windowActions";
import {
  formatTransientConnectionStatus,
  getConnectedToastDeadlineMs,
  getRetryDeadlineMs
} from "./ui/connectionStatus";
import { createViewportCapacityTracker } from "./ui/viewportCapacity";
import { scrollMessageContent } from "./ui/messageScroll";
import {
  getMessageContextMenuLabels,
  shouldSuppressNativeContextMenu,
  type MessageContextMenuScope
} from "./ui/contextMenu";
import { applyConnectApiUrl, getMessageSizeLabel } from "./ui/settingsPanel";
import { createMainListMotion } from "./ui/mainListMotion";
import "./styles.css";

const initialSnapshot: AppSnapshot = {
  connected: false,
  connectionStatus: "启动中",
  mainVisible: [],
  firstUnreadMessageId: null,
  mainHiddenNewerCount: 0,
  mainCacheNearFull: false,
  mainViewportRevision: 0,
  mainViewportMotion: null,
  personPanel: {
    selectedUid: null,
    selectedNickname: null,
    anchorMessageId: null,
    hoverFrozen: false,
    visibleMessages: [],
    hiddenNewerCount: 0
  }
};

interface MessageContextMenuState {
  x: number;
  y: number;
  message: DanmuMessage;
  scope: MessageContextMenuScope;
}

export default function App() {
  const client = useMemo(() => createDanmuClient(), []);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [config, setConfig] = useState<DisplayConfig>({
    connectApiUrl: "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect",
    opacity: 0.82,
    fontSize: 14,
    personHistoryCount: 1
  });
  const [connectApiUrlDraft, setConnectApiUrlDraft] = useState(
    "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect"
  );
  const [connectApiSaveStatus, setConnectApiSaveStatus] = useState("");
  const [connectApiSubmitting, setConnectApiSubmitting] = useState(false);
  const [statusNowMs, setStatusNowMs] = useState(() => Date.now());
  // A new status and its clock must render together, without borrowing the
  // previous retry's expired deadline for the first frame.
  const statusTiming = useMemo(() => {
    const startedAtMs = Date.now();
    return {
      startedAtMs,
      retryDeadlineMs: getRetryDeadlineMs(snapshot.connectionStatus, startedAtMs),
      connectedToastDeadlineMs: getConnectedToastDeadlineMs(snapshot.connectionStatus, startedAtMs)
    };
  }, [snapshot.connectionStatus]);
  const { retryDeadlineMs, connectedToastDeadlineMs } = statusTiming;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const contentGridRef = useRef<HTMLElement>(null);
  const mainListRef = useRef<HTMLDivElement>(null);
  const mainListMotion = useMemo(() => createMainListMotion(() => mainListRef.current), []);
  const personListRef = useRef<HTMLDivElement>(null);
  const lastMainViewportSizeRef = useRef<number | null>(null);
  const lastPersonViewportSizeRef = useRef<number | null>(null);
  const measureMainCapacity = useMemo(createViewportCapacityTracker, []);
  const measurePersonCapacity = useMemo(createViewportCapacityTracker, []);
  const [contentWidth, setContentWidth] = useState(
    MAIN_READABLE_WIDTH + PERSON_PANEL_DEFAULT_WIDTH
  );
  const [manualPersonRatio, setManualPersonRatio] = useState<number | null>(
    null
  );
  const [splitDragging, setSplitDragging] = useState(false);
  const [messageContextMenu, setMessageContextMenu] =
    useState<MessageContextMenuState | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (!cancelled) {
          getCurrentWindow().show().catch(() => undefined);
        }
      });
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let disposeTrayReconnect: (() => void) | undefined;
    let disposeTrayDisconnect: (() => void) | undefined;
    let disposeTraySettings: (() => void) | undefined;
    client.getConfig().then(setConfig).catch(() => undefined);
    client.init((next) => {
      if (mainListMotion.prepare(next)) setSnapshot(next);
    }).then((unlisten) => {
      dispose = unlisten;
      void client.connect().catch(() => undefined);
    });
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      listen("tray_reconnect_requested", () => client.reconnect()).then((unlisten) => {
        disposeTrayReconnect = unlisten;
      });
      listen("tray_disconnect_requested", () => client.disconnect()).then((unlisten) => {
        disposeTrayDisconnect = unlisten;
      });
      listen("tray_settings_requested", () => setSettingsOpen(true)).then((unlisten) => {
        disposeTraySettings = unlisten;
      });
    }
    return () => {
      dispose?.();
      disposeTrayReconnect?.();
      disposeTrayDisconnect?.();
      disposeTraySettings?.();
    };
  }, [client, mainListMotion]);

  useLayoutEffect(() => {
    mainListMotion.play();
  }, [snapshot, mainListMotion]);

  useEffect(() => {
    const cancel = () => mainListMotion.cancel();
    window.addEventListener("resize", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      cancel();
      window.removeEventListener("resize", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [mainListMotion]);

  useEffect(() => {
    if (!messageContextMenu) {
      return;
    }

    const close = () => setMessageContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [messageContextMenu]);

  useEffect(() => {
    setConnectApiUrlDraft(config.connectApiUrl);
  }, [config.connectApiUrl]);

  useEffect(() => {
    if (retryDeadlineMs === null && connectedToastDeadlineMs === null) {
      return;
    }

    const timer = window.setInterval(() => {
      setStatusNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(timer);
  }, [retryDeadlineMs, connectedToastDeadlineMs]);

  useEffect(() => {
    const suppress = (event: MouseEvent) => {
      if (shouldSuppressNativeContextMenu("background")) {
        event.preventDefault();
      }
    };

    document.addEventListener("contextmenu", suppress, { capture: true });

    return () => {
      document.removeEventListener("contextmenu", suppress, { capture: true });
    };
  }, []);

  const personVisible = isPersonPanelVisible();
  const splitLayout = useMemo(
    () =>
      getSplitLayout({
        totalWidth: contentWidth,
        personVisible,
        personRatio: manualPersonRatio
      }),
    [contentWidth, manualPersonRatio, personVisible]
  );
  const personMeasurementKey = snapshot.personPanel.visibleMessages
    .map((message) => message.messageId)
    .join(":");
  const mainMeasurementKey = snapshot.mainVisible
    .map((message) => message.messageId)
    .join(":");
  useEffect(() => {
    const element = contentGridRef.current;
    if (!element) {
      return;
    }

    let frame = 0;
    const syncWidth = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setContentWidth(Math.round(element.clientWidth));
      });
    };

    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(element);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = contentGridRef.current;
    if (!element) return;
    element.addEventListener("wheel", scrollMessageContent, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", scrollMessageContent, true);
  }, []);

  useEffect(() => {
    const list = mainListRef.current;
    if (!list) {
      return;
    }

    let frame = 0;
    const syncCapacity = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rows = Array.from(
          list.querySelectorAll<HTMLElement>(".message-card")
        );
        if (rows.length === 0) {
          return;
        }

        const style = window.getComputedStyle(list);
        const capacity = measureMainCapacity({
          containerWidth: list.clientWidth,
          containerHeight: list.clientHeight,
          fontSize: config.fontSize,
          minRowHeight: cssNumber(window.getComputedStyle(rows[0]).minHeight),
          rowIds: rows.map((row) => row.dataset.messageId!),
          rowHeights: rows.map((row) => row.getBoundingClientRect().height),
          gap: cssNumber(style.rowGap),
          paddingTop: cssNumber(style.paddingTop),
          paddingBottom: cssNumber(style.paddingBottom),
          max: 100
        });

        if (capacity === lastMainViewportSizeRef.current) {
          return;
        }

        lastMainViewportSizeRef.current = capacity;
        void client.setViewportSizes({ mainViewportSize: capacity });
      });
    };

    syncCapacity();
    const observer = new ResizeObserver(syncCapacity);
    observer.observe(list);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [client, config.fontSize, mainMeasurementKey, measureMainCapacity]);

  useEffect(() => {
    if (!personVisible) {
      return;
    }

    const list = personListRef.current;
    if (!list) {
      return;
    }

    let frame = 0;
    const syncCapacity = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rows = Array.from(
          list.querySelectorAll<HTMLElement>(".person-row")
        );
        if (rows.length === 0) {
          return;
        }

        const style = window.getComputedStyle(list);
        const capacity = measurePersonCapacity({
          containerWidth: list.clientWidth,
          containerHeight: list.clientHeight,
          fontSize: config.fontSize,
          minRowHeight: cssNumber(window.getComputedStyle(rows[0]).minHeight),
          rowIds: rows.map((row) => row.dataset.messageId!),
          rowHeights: rows.map((row) => row.getBoundingClientRect().height),
          gap: cssNumber(style.rowGap),
          paddingTop: cssNumber(style.paddingTop),
          paddingBottom: cssNumber(style.paddingBottom),
          max: 50
        });

        if (capacity === lastPersonViewportSizeRef.current) {
          return;
        }

        lastPersonViewportSizeRef.current = capacity;
        void client.setViewportSizes({ personViewportSize: capacity });
      });
    };

    syncCapacity();
    const observer = new ResizeObserver(syncCapacity);
    observer.observe(list);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [
    client,
    config.fontSize,
    measurePersonCapacity,
    personVisible,
    snapshot.personPanel.hiddenNewerCount,
    personMeasurementKey
  ]);

  const rootStyle = {
    "--glass-opacity": config.opacity.toString(),
    "--app-font-size": `${config.fontSize}px`,
    "--person-panel-width": `${splitLayout.personWidth}px`,
    "--main-panel-width": `${splitLayout.mainWidth}px`
  } as React.CSSProperties;
  const connectionStatusText = formatTransientConnectionStatus(
    snapshot.connectionStatus,
    retryDeadlineMs,
    connectedToastDeadlineMs,
    Math.max(statusNowMs, statusTiming.startedAtMs)
  );
  const mainUnreadAnchorAction = getMainUnreadAnchorAction();
  const windowDismissAction = getWindowDismissAction();
  const backgroundTransparency = Math.round((1 - config.opacity) * 100);

  const updateConfig = async (patch: Partial<DisplayConfig>) => {
    if (patch.personHistoryCount !== undefined) measurePersonCapacity.reset();
    const next = await client.updateConfig(patch);
    setConfig(next);
    return next;
  };

  const saveConnectApiUrl = async () => {
    if (connectApiSubmitting) return;
    setConnectApiSubmitting(true);
    setConnectApiSaveStatus("正在应用接口地址");
    try {
      const next = await applyConnectApiUrl(connectApiUrlDraft, {
        updateConfig,
        reconnect: () => client.reconnect()
      });
      setConnectApiUrlDraft(next.connectApiUrl);
      setConnectApiSaveStatus("已保存，已发起对接");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectApiSaveStatus(`对接失败：${message}`);
    } finally {
      setConnectApiSubmitting(false);
    }
  };

  const onMainMessageClick = async (message: DanmuMessage) => {
    setMessageContextMenu(null);
    measurePersonCapacity.reset();
    await client.selectUserAnchor(message.messageId);
    await client.ackMainMessage(message.messageId);
  };

  const onPersonMessageClick = async (message: DanmuMessage) => {
    setMessageContextMenu(null);
    await client.ackMessage(message.messageId);
  };

  const openMessageContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    message: DanmuMessage,
    scope: MessageContextMenuScope
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMessageContextMenu({
      x: event.clientX,
      y: event.clientY,
      message,
      scope
    });
  };

  const copyFromContextMenu = async (text: string) => {
    await copyText(text).catch(() => undefined);
    setMessageContextMenu(null);
  };

  const ackUserFromContextMenu = async (uid: string) => {
    await client.ackUserMessages(uid);
    setMessageContextMenu(null);
  };

  const wheelToViewportDelta = (event: React.WheelEvent<HTMLElement>) => {
    if (event.deltaY === 0) {
      return 0;
    }
    // The viewport is clipped; React's passive wheel listener cannot cancel scrolling.
    return event.deltaY > 0 ? 1 : -1;
  };

  const onMainWheel = (event: React.WheelEvent<HTMLElement>) => {
    mainListMotion.cancel();
    const delta = wheelToViewportDelta(event);
    if (delta !== 0) {
      measureMainCapacity.reset();
      void client.scrollMainViewport(delta);
    }
  };

  const onMainNewerTipClick = () => {
    setMessageContextMenu(null);
    void client.jumpMainViewportToUnread();
  };

  const onPersonWheel = (event: React.WheelEvent<HTMLElement>) => {
    const delta = wheelToViewportDelta(event);
    if (delta !== 0) {
      measurePersonCapacity.reset();
      void client.scrollPersonViewport(delta);
    }
  };

  const startWindowDrag = (event: React.MouseEvent<HTMLElement>) => {
    if (!isTauriRuntime() || event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea,select,a")) {
      return;
    }
    getCurrentWindow().startDragging().catch(() => undefined);
  };

  const updateManualSplit = (clientX: number) => {
    const grid = contentGridRef.current;
    if (!grid || !personVisible) {
      return;
    }

    const rect = grid.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width));
    if (width <= 0) {
      return;
    }

    const desiredRatio = (clientX - rect.left) / width;
    const nextLayout = getSplitLayout({
      totalWidth: width,
      personVisible: true,
      personRatio: desiredRatio
    });
    setContentWidth(width);
    setManualPersonRatio(nextLayout.personWidth / width);
  };

  const onSplitterPointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (event.button !== 0 || !personVisible) {
      return;
    }

    event.preventDefault();
    mainListMotion.cancel();
    setSplitDragging(true);
    updateManualSplit(event.clientX);

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateManualSplit(moveEvent.clientX);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      updateManualSplit(upEvent.clientX);
      setSplitDragging(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const suppressNativeContextMenu = (
    event: React.MouseEvent<HTMLElement>
  ) => {
    if (shouldSuppressNativeContextMenu("background")) {
      event.preventDefault();
    }
  };

  const mainNewerTip = snapshot.mainHiddenNewerCount > 0 || snapshot.mainCacheNearFull
    ? `还有 ${snapshot.mainHiddenNewerCount} 条更新${snapshot.mainCacheNearFull ? " - 即将爆满" : ""}`
    : "";

  return (
    <main
      className="app-shell"
      style={rootStyle}
      onContextMenu={suppressNativeContextMenu}
    >
      <header
        className="drag-bar"
        onMouseDown={startWindowDrag}
      >
        <div className="drag-title">
          <span>看弹幕工具</span>
          <button
            className="icon-button settings-button"
            title="设置"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <Settings size={15} />
          </button>
          <span className="status-dot" data-state={snapshot.connected ? "on" : "off"} />
          {connectionStatusText ? (
            <span className="connection-status-text" title={snapshot.connectionStatus}>
              {connectionStatusText}
            </span>
          ) : null}
        </div>

        <div className="window-actions">
          <button
            className={mainUnreadAnchorAction.className}
            title={mainUnreadAnchorAction.title}
            aria-label={mainUnreadAnchorAction.title}
            onClick={onMainNewerTipClick}
          >
            <LocateFixed size={15} />
          </button>
          <button
            className="icon-button"
            title={windowDismissAction.title}
            onClick={() => getCurrentWindow().minimize().catch(() => undefined)}
          >
            <Minus size={15} />
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section className="settings-popover">
          <div className="settings-connection">
            <label htmlFor="connect-api-url">接口地址</label>
            <div className="settings-connection-row">
              <input
                id="connect-api-url"
                type="text"
                spellCheck={false}
                disabled={connectApiSubmitting}
                value={connectApiUrlDraft}
                onChange={(event) => {
                  setConnectApiUrlDraft(event.target.value);
                  setConnectApiSaveStatus("");
                }}
              />
              <button
                type="button"
                className="connect-button"
                disabled={connectApiSubmitting}
                onClick={saveConnectApiUrl}
              >
                对接
              </button>
            </div>
            {connectApiSaveStatus && (
              <p className="settings-status" role="status">{connectApiSaveStatus}</p>
            )}
          </div>
          <SettingsSlider
            id="background-transparency"
            label="背景透明度"
            min={2}
            max={55}
            value={backgroundTransparency}
            valueLabel={`${backgroundTransparency}%`}
            onChange={(value) => updateConfig({ opacity: (100 - value) / 100 })}
          />
          <SettingsSlider
            id="message-size"
            label="消息显示大小"
            min={12}
            max={18}
            value={config.fontSize}
            valueLabel={`${getMessageSizeLabel(config.fontSize)} · ${config.fontSize}`}
            onChange={(value) => updateConfig({ fontSize: value })}
          />
          <SettingsSlider
            id="person-history-count"
            label="左侧默认展示历史条数"
            min={0}
            max={3}
            value={config.personHistoryCount}
            valueLabel={`${config.personHistoryCount} 条`}
            onChange={(value) => updateConfig({ personHistoryCount: value })}
          />
        </section>
      )}

      <section
        ref={contentGridRef}
        className={`content-grid ${splitDragging ? "is-splitting" : ""}`}
      >
        <aside
          className="person-panel"
          onMouseEnter={() => client.setPersonPanelHover(true)}
          onMouseLeave={() => client.setPersonPanelHover(false)}
          onWheel={onPersonWheel}
        >
          <div className="panel-header">
            <div>
              <span className="panel-kicker" title={snapshot.personPanel.selectedUid ?? undefined}>
                {snapshot.personPanel.selectedUid
                  ? `UID ${snapshot.personPanel.selectedUid}`
                  : "UID"}
              </span>
              <strong title={snapshot.personPanel.selectedNickname ?? undefined}>
                {snapshot.personPanel.selectedNickname ?? "未选择"}
              </strong>
            </div>
          </div>
          <div
            className="person-list"
            ref={personListRef}
          >
            {snapshot.personPanel.visibleMessages.map((message) => (
              <button
                className={`person-row ${message.read ? "is-read" : ""} ${
                  snapshot.personPanel.anchorMessageId === message.messageId
                    ? "is-anchor"
                    : ""
                } ${
                  message.messageType === "superChat" ? "is-super-chat" : ""
                }`}
                key={message.messageId}
                data-message-id={message.messageId}
                onClick={() => onPersonMessageClick(message)}
                onContextMenu={(event) =>
                  openMessageContextMenu(event, message, "person")
                }
              >
                {snapshot.personPanel.anchorMessageId === message.messageId && (
                  <span
                    className="message-marker person-anchor-marker"
                    role="img"
                    aria-label="当前选中消息"
                    title="当前选中消息"
                  />
                )}
                <span className="time">{formatMmSs(message.timestampMs)}</span>
                <span className="person-content">
                  {message.messageType === "superChat" && (
                    <SuperChatBadge message={message} compact />
                  )}
                  {message.content}
                </span>
              </button>
            ))}
          </div>
          <div
            className="newer-tip"
            data-visible={snapshot.personPanel.hiddenNewerCount > 0}
            aria-hidden={snapshot.personPanel.hiddenNewerCount === 0}
          >
            {snapshot.personPanel.hiddenNewerCount > 0
              ? `还有 ${snapshot.personPanel.hiddenNewerCount} 条更新`
              : null}
          </div>
        </aside>

        {personVisible && (
          <div
            className="panel-splitter"
            role="separator"
            aria-label="调整两栏宽度"
            aria-orientation="vertical"
            title="拖动调整两栏宽度"
            onPointerDown={onSplitterPointerDown}
          />
        )}

        <section className="main-panel" onWheel={onMainWheel}>
          <div className="main-list-viewport">
            <div
              className="message-list"
              ref={mainListRef}
            >
              {snapshot.mainVisible.map((message) => (
                <button
                  key={message.messageId}
                  data-message-id={message.messageId}
                  className={`message-card ${message.read ? "is-read" : ""} ${
                    message.messageType === "superChat" ? "is-super-chat" : ""
                  }`}
                  onClick={() => onMainMessageClick(message)}
                  onContextMenu={(event) => openMessageContextMenu(event, message, "main")}
                >
                  {message.messageId === snapshot.firstUnreadMessageId && (
                    <span
                      className="message-marker first-unread-marker"
                      role="img"
                      aria-label="全局最早未读"
                      title="全局最早未读"
                    />
                  )}
                  <span className="meta-line">
                    {message.messageType === "superChat" && (
                      <SuperChatBadge message={message} />
                    )}
                    <WealthMedal level={message.userLevel} />
                    <FanMedal message={message} />
                    <span className="message-author">
                      <strong
                        className="nickname"
                        style={{ color: getGuardNicknameColor(message.guardType) }}
                        title={message.nickname}
                      >
                        {message.nickname}
                      </strong>
                      <span className="message-time">
                        {formatHhMmSs(message.timestampMs)}
                      </span>
                    </span>
                  </span>
                  <span className="content-line">{message.content}</span>
                </button>
              ))}
            </div>
          </div>
          <div
            className="newer-tip main-newer-tip"
            data-visible={Boolean(mainNewerTip)}
            aria-hidden={!mainNewerTip}
            title={mainNewerTip || undefined}
          >
            {mainNewerTip}
          </div>
        </section>
      </section>

      {messageContextMenu && (
        <div
          className="message-context-menu"
          style={{ left: messageContextMenu.x, top: messageContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {messageContextMenu.scope === "main" ? (
            <>
              <button onClick={() => copyFromContextMenu(messageContextMenu.message.content)}>
                {getMessageContextMenuLabels("main")[0]}
              </button>
              <button onClick={() => copyFromContextMenu(messageContextMenu.message.nickname)}>
                {getMessageContextMenuLabels("main")[1]}
              </button>
              <button onClick={() => copyFromContextMenu(messageContextMenu.message.uid)}>
                {getMessageContextMenuLabels("main")[2]}
              </button>
              <button onClick={() => ackUserFromContextMenu(messageContextMenu.message.uid)}>
                {getMessageContextMenuLabels("main")[3]}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => copyFromContextMenu(messageContextMenu.message.content)}>
                {getMessageContextMenuLabels("person")[0]}
              </button>
              <button onClick={() => ackUserFromContextMenu(messageContextMenu.message.uid)}>
                {getMessageContextMenuLabels("person")[1]}
              </button>
            </>
          )}
        </div>
      )}
    </main>
  );
}

function SettingsSlider({
  id, label, min, max, value, valueLabel, onChange
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  valueLabel: string;
  onChange: (value: number) => void;
}) {
  const progress = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <label className="settings-slider" htmlFor={id}>
      <span className="settings-slider-heading">
        <span>{label}</span>
        <output className="settings-value" htmlFor={id}>{valueLabel}</output>
      </span>
      <input
        id={id}
        className="settings-range"
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        aria-valuetext={valueLabel}
        style={{ "--range-progress": `${progress}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function cssNumber(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function SuperChatBadge({
  message,
  compact = false
}: {
  message: DanmuMessage;
  compact?: boolean;
}) {
  const price = message.superChat?.price;
  return (
    <span className={`sc-badge ${compact ? "is-compact" : ""}`}>
      SC{typeof price === "number" && price > 0 ? ` ¥${price}` : ""}
    </span>
  );
}

function WealthMedal({ level }: { level: number }) {
  const src = getWealthMedalUrl(level);
  if (!src) {
    return null;
  }

  return (
    <span className="wealth-medal-ctnr" title="这是 TA 的荣耀等级勋章">
      <img
        className="wealth-medal"
        src={src}
        alt={`UL${Math.trunc(level)}`}
        draggable={false}
      />
    </span>
  );
}

function FanMedal({ message }: { message: DanmuMessage }) {
  if (message.fanLevel <= 0) {
    return null;
  }

  const levelClass = getFanMedalLevelClass(message.fanLevel);
  const className = ["fans-medal-level", levelClass]
    .filter(Boolean)
    .join(" ");
  const guardIconUrl = getGuardMedalIconUrl(message.guardType);

  return (
    <span
      className="fans-medal-item"
      title="这是 TA 的粉丝勋章"
      style={
        {
          ...getFanMedalStyle(message.fanLevel, message.fanMedalColors),
          ...getFanMedalLayoutStyle(message.fanLevel, message.guardType)
        } as React.CSSProperties
      }
    >
      <span
        className={getFanMedalLabelClass(message.guardType)}
        aria-hidden="true"
      >
        {guardIconUrl && (
          <i
            className="medal-deco medal-guard"
            style={{ backgroundImage: `url(${guardIconUrl})` }}
          />
        )}
        <span className="fans-medal-content" />
      </span>
      <span className={className}>
        <span className="fans-medal-level-font">{message.fanLevel}</span>
      </span>
    </span>
  );
}
