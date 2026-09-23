import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { createMessageStore } from "../core/messageStore";
import type { AppSnapshot, IncomingDanmuRaw } from "../core/types";

export interface DisplayConfig {
  connectApiUrl: string;
  opacity: number;
  fontSize: number;
  personHistoryCount: number;
}

export interface ProbeReport {
  connect: {
    uid: number;
    roomId: number;
    wsurl: string;
  };
  startedMs: number;
  endedMs: number;
  danmuSamples: unknown[];
  superChatSamples: unknown[];
  otherNotifications: number;
  superChatStatus: string;
  reportPath?: string;
}

export interface DanmuClient {
  init(onSnapshot: (snapshot: AppSnapshot) => void): Promise<() => void>;
  getConfig(): Promise<DisplayConfig>;
  updateConfig(config: Partial<DisplayConfig>): Promise<DisplayConfig>;
  probeBilibiliConnection(): Promise<ProbeReport>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  ackMessage(messageId: number): Promise<void>;
  ackMainMessage(messageId: number): Promise<void>;
  ackUserMessages(uid: string): Promise<void>;
  selectUserAnchor(messageId: number): Promise<void>;
  setPersonPanelHover(value: boolean): Promise<void>;
  scrollMainViewport(delta: number): Promise<void>;
  jumpMainViewportToUnread(): Promise<void>;
  scrollPersonViewport(delta: number): Promise<void>;
  setViewportSizes(sizes: {
    mainViewportSize?: number;
    personViewportSize?: number;
  }): Promise<void>;
}

const defaultConfig: DisplayConfig = {
  connectApiUrl: "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect",
  opacity: 0.82,
  fontSize: 14,
  personHistoryCount: 1
};
const BROWSER_MOCK_WS_URL = "ws://127.0.0.1:17878";

export function createDanmuClient(): DanmuClient {
  if (isTauriRuntime()) {
    return createTauriClient();
  }

  return createBrowserFallbackClient();
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createTauriClient(): DanmuClient {
  return {
    async init(onSnapshot) {
      const snapshot = await invoke<AppSnapshot>("get_snapshot");
      onSnapshot(snapshot);
      const poll = window.setInterval(() => {
        invoke<AppSnapshot>("get_snapshot")
          .then(onSnapshot)
          .catch(() => undefined);
      }, 500);
      let unlisten: UnlistenFn | undefined;
      listen<AppSnapshot>("danmu_state_changed", (event) => onSnapshot(event.payload))
        .then((dispose) => {
          unlisten = dispose;
        })
        .catch(() => undefined);
      return () => {
        window.clearInterval(poll);
        unlisten?.();
      };
    },
    getConfig: () => invoke<DisplayConfig>("get_config"),
    updateConfig: (config) => invoke<DisplayConfig>("update_config", { patch: config }),
    probeBilibiliConnection: () =>
      invoke<ProbeReport>("probe_bilibili_connection"),
    connect: () => invoke<void>("connect_ws"),
    disconnect: () => invoke<void>("disconnect_ws"),
    reconnect: () => invoke<void>("reconnect_ws"),
    ackMessage: (messageId) => invoke<void>("ack_message", { messageId }),
    ackMainMessage: (messageId) => invoke<void>("ack_main_message", { messageId }),
    ackUserMessages: (uid) => invoke<void>("ack_user_messages", { uid }),
    selectUserAnchor: (messageId) =>
      invoke<void>("select_user_anchor", { messageId }),
    setPersonPanelHover: (value) =>
      invoke<void>("set_person_panel_hover", { value }),
    scrollMainViewport: (delta) =>
      invoke<void>("scroll_main_viewport", { delta }),
    jumpMainViewportToUnread: () =>
      invoke<void>("jump_main_viewport_to_unread"),
    scrollPersonViewport: (delta) =>
      invoke<void>("scroll_person_viewport", { delta }),
    setViewportSizes: (sizes) => invoke<void>("set_viewport_sizes", sizes)
  };
}

function createBrowserFallbackClient(): DanmuClient {
  const store = createMessageStore({
    mainViewportSize: 22,
    personViewportSize: 14,
    personHistoryCount: defaultConfig.personHistoryCount
  });
  let config = { ...defaultConfig };
  let socket: WebSocket | null = null;
  let onChange: (snapshot: AppSnapshot) => void = () => undefined;

  const emit = () => onChange(store.getSnapshot());

  const client: DanmuClient = {
    async init(onSnapshot) {
      onChange = onSnapshot;
      store.setConnection("浏览器预览：未连接", false);
      seedPreviewMessages();
      emit();
      return () => {
        socket?.close();
      };
    },
    async getConfig() {
      return config;
    },
    async updateConfig(patch) {
      config = { ...config, ...patch };
      if (typeof patch.personHistoryCount === "number") {
        config.personHistoryCount = clampPersonHistoryCount(
          patch.personHistoryCount
        );
        store.setPersonHistoryCount(config.personHistoryCount);
        emit();
      }
      return config;
    },
    async probeBilibiliConnection() {
      return {
        connect: {
          uid: 0,
          roomId: 0,
          wsurl: BROWSER_MOCK_WS_URL
        },
        startedMs: Date.now(),
        endedMs: Date.now(),
        danmuSamples: [],
        superChatSamples: [],
        otherNotifications: 0,
        superChatStatus: "浏览器预览不执行真实探测"
      };
    },
    async connect() {
      socket?.close();
      store.setConnection("连接中", false);
      emit();

      socket = new WebSocket(BROWSER_MOCK_WS_URL);
      socket.onopen = () => {
        store.setConnection("已连接", true);
        emit();
      };
      socket.onclose = () => {
        store.setConnection("已断开", false);
        emit();
      };
      socket.onerror = () => {
        store.setConnection("连接错误", false);
        emit();
      };
      socket.onmessage = (event) => {
        try {
          store.ingest(JSON.parse(String(event.data)) as IncomingDanmuRaw);
          emit();
        } catch (error) {
          store.setConnection(`解析失败：${String(error)}`, socket?.readyState === 1);
          emit();
        }
      };
    },
    async disconnect() {
      socket?.close();
      socket = null;
      store.setConnection("已断开", false);
      emit();
    },
    async reconnect() {
      await client.disconnect();
      await client.connect();
    },
    async ackMessage(messageId) {
      store.ackMessage(messageId);
      emit();
    },
    async ackMainMessage(messageId) {
      store.ackMainMessage(messageId);
      emit();
    },
    async ackUserMessages(uid) {
      store.ackUserMessages(uid);
      emit();
    },
    async selectUserAnchor(messageId) {
      store.selectUserAnchor(messageId);
      emit();
    },
    async setPersonPanelHover(value) {
      store.setPersonPanelHover(value);
      emit();
    },
    async scrollMainViewport(delta) {
      store.scrollMainViewport(delta);
      emit();
    },
    async jumpMainViewportToUnread() {
      store.jumpMainViewportToUnread();
      emit();
    },
    async scrollPersonViewport(delta) {
      store.scrollPersonViewport(delta);
      emit();
    },
    async setViewportSizes(sizes) {
      store.setViewportSizes(sizes);
      emit();
    }
  };

  function seedPreviewMessages() {
    const names = ["南桥", "阿晴", "Kira", "月见", "山海", "Dora"];
    for (let i = 0; i < 18; i += 1) {
      const uid = 100000001 + (i % names.length);
      store.ingest({
        content: [
          "主播这波细节拉满",
          "这里能再看一次吗",
          "舰长路过打个卡",
          "这个配置我记一下",
          "弹幕小窗看起来很稳",
          "UID 追踪这个设计好用"
        ][i % 6],
        uid,
        nickname: names[i % names.length],
        userLevel: (i * 7) % 101,
        fanLevel: (i * 5) % 121,
        guardType: (i % 4) as 0 | 1 | 2 | 3,
        ...(i === 6
          ? {
              messageType: "superChat" as const,
              superChat: {
                id: "preview-sc-1",
                price: 30,
                durationSec: 60
              }
            }
          : {}),
        timestampMs: Date.now() - (18 - i) * 15_000
      });
    }
  }

  return client;
}

function clampPersonHistoryCount(value: number) {
  return Math.min(3, Math.max(0, Math.trunc(value)));
}
