import type {
  AppSnapshot,
  DanmuMessage,
  FanMedalColors,
  GuardType,
  IncomingDanmuRaw,
  PersonPanelSnapshot,
  SuperChatInfo
} from "./types";

interface MessageStoreOptions {
  mainCapacity?: number;
  perUserCapacity?: number;
  mainViewportSize: number;
  personViewportSize: number;
  personHistoryCount?: number;
}

interface ViewportSizePatch {
  mainViewportSize?: number;
  personViewportSize?: number;
}

const DEFAULT_MAIN_CAPACITY = 1000;
const DEFAULT_PER_USER_CAPACITY = 50;

export function normalizeIncomingDanmu(
  raw: IncomingDanmuRaw,
  messageId: number
): DanmuMessage {
  const messageType = raw.messageType === "superChat" ? "superChat" : "danmu";
  const contentLength = Array.from(raw.content ?? "").length;
  const maxContentLength = messageType === "superChat" ? 120 : 40;
  if (contentLength < 1 || contentLength > maxContentLength) {
    throw new Error(
      `content length must be between 1 and ${maxContentLength} characters`
    );
  }

  assertRange("userLevel", raw.userLevel, 0, 100);
  assertRange("fanLevel", raw.fanLevel, 0, 120);
  assertRange("guardType", raw.guardType, 0, 3);

  const timestampMs =
    typeof raw.timestampMs === "number"
      ? raw.timestampMs
      : typeof raw.timestamp === "number"
        ? raw.timestamp * 1000
        : Date.now();
  const fanMedalColors = normalizeFanMedalColors(raw.fanMedalColors);

  return {
    messageId,
    content: raw.content,
    uid: String(raw.uid),
    nickname: raw.nickname,
    userLevel: raw.userLevel,
    fanLevel: raw.fanLevel,
    guardType: raw.guardType as GuardType,
    messageType,
    ...(messageType === "superChat"
      ? { superChat: normalizeSuperChat(raw.superChat) }
      : {}),
    ...(fanMedalColors ? { fanMedalColors } : {}),
    timestampMs,
    read: false
  };
}

function assertRange(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

function normalizeFanMedalColors(colors?: FanMedalColors) {
  if (!colors) {
    return undefined;
  }

  const normalized: FanMedalColors = {};
  for (const key of ["start", "end", "border", "text", "level"] as const) {
    const value = colors[key];
    if (typeof value === "string" && value.trim().length > 0) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeSuperChat(superChat?: SuperChatInfo) {
  if (!superChat) {
    return undefined;
  }

  const normalized: SuperChatInfo = {};
  if (typeof superChat.id === "string" && superChat.id.trim().length > 0) {
    normalized.id = superChat.id;
  }
  for (const key of [
    "price",
    "startTimeMs",
    "endTimeMs",
    "durationSec"
  ] as const) {
    const value = superChat[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function createMessageStore(options: MessageStoreOptions) {
  let nextMessageId = 1;
  let mainStartIndex = 0;
  let mainTopAligned = false;
  let mainViewportRevision = 0;
  let mainViewportMotion: AppSnapshot["mainViewportMotion"] = null;
  let selectedUid: string | null = null;
  let anchorMessageId: number | null = null;
  let personStartIndex = 0;
  let personManualViewport = false;
  let mainViewportSize = options.mainViewportSize;
  let personViewportSize = options.personViewportSize;
  let personHistoryCount = clampPersonHistoryCount(
    options.personHistoryCount ?? 1
  );
  let hoverFrozen = false;
  let connected = false;
  let connectionStatus = "未连接";

  const mainCapacity = Math.max(1, Math.trunc(options.mainCapacity ?? DEFAULT_MAIN_CAPACITY));
  const perUserCapacity = Math.max(1, Math.trunc(options.perUserCapacity ?? DEFAULT_PER_USER_CAPACITY));
  const messages: DanmuMessage[] = [];
  const byId = new Map<number, DanmuMessage>();
  const idsByUid = new Map<string, number[]>();

  const api = {
    ingest(raw: IncomingDanmuRaw) {
      const keepMainPinnedToBottom = isMainViewportAtBottom();
      const protectedPersonIds = getProtectedPersonIds();
      const message = normalizeIncomingDanmu(raw, nextMessageId);
      nextMessageId += 1;
      messages.push(message);
      byId.set(message.messageId, message);

      const userIds = idsByUid.get(message.uid) ?? [];
      userIds.push(message.messageId);
      idsByUid.set(message.uid, userIds);

      trimMainCapacity(protectedPersonIds);
      trimPerUserCapacity(message.uid, protectedPersonIds);
      if (keepMainPinnedToBottom) {
        pinMainViewportToBottom();
      } else {
        clampMainViewportStart();
      }

      return message;
    },

    ackMainMessage(messageId: number) {
      if (firstUnread()?.messageId === messageId) {
        api.ackMessage(messageId);
      }
    },

    ackMessage(messageId: number) {
      const message = byId.get(messageId);
      if (!message || message.read) {
        return;
      }

      const advancesUnread = firstUnread()?.messageId === messageId;
      message.read = true;
      if (advancesUnread) {
        alignMainToUnread("advance");
      }
    },

    ackUserMessages(uid: string) {
      const advancesUnread = firstUnread()?.uid === String(uid);
      const userIds = idsByUid.get(String(uid)) ?? [];
      for (const messageId of userIds) {
        const message = byId.get(messageId);
        if (message) {
          message.read = true;
        }
      }

      for (const message of messages) {
        if (message.uid === String(uid)) {
          message.read = true;
        }
      }

      if (advancesUnread) {
        alignMainToUnread("advance");
      }
    },

    clearReadMessages() {
      let removedCount = 0;
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message.read) continue;
        messages.splice(index, 1);
        byId.delete(message.messageId);
        removeMessageFromUserIndex(message);
        if (index < mainStartIndex) mainStartIndex--;
        removedCount++;
      }
      if (removedCount === 0) return 0;

      // Preserve the first surviving row instead of pulling older rows into view.
      mainStartIndex = Math.min(mainStartIndex, Math.max(0, messages.length - 1));
      mainTopAligned = messages.length > 0;
      mainViewportRevision++;
      mainViewportMotion = null;
      if (anchorMessageId !== null && !byId.has(anchorMessageId)) {
        // Explicit cleanup may remove the anchor. Restore the nearest remaining
        // message for this user, even if its smaller history index had evicted it.
        const remaining = messages.filter(message => message.uid === selectedUid);
        const next = remaining.find(message => message.messageId > anchorMessageId!) ?? remaining.at(-1);
        if (next) api.selectUserAnchor(next.messageId);
        else resetPersonSelection();
      }
      return removedCount;
    },

    clearAllMessages() {
      const removedCount = messages.length;
      messages.length = 0;
      byId.clear();
      idsByUid.clear();
      mainStartIndex = 0;
      mainTopAligned = false;
      mainViewportRevision++;
      mainViewportMotion = null;
      resetPersonSelection();
      // Keep connection state and monotonically increasing IDs: delayed clicks
      // on removed rows must never mark a newly received message as read.
      return removedCount;
    },

    selectUserAnchor(messageId: number) {
      const message = byId.get(messageId);
      if (!message) {
        return;
      }

      selectedUid = message.uid;
      anchorMessageId = message.messageId;
      hoverFrozen = false;
      personManualViewport = false;
      // The main cache can outlive this user's smaller history index.
      const userIds = idsByUid.get(message.uid) ?? [];
      if (!userIds.includes(messageId)) {
        userIds.push(messageId);
        userIds.sort((a, b) => a - b);
        idsByUid.set(message.uid, userIds);
      }
      personStartIndex = computeAnchoredPersonStart();
      trimPerUserCapacity(message.uid, getProtectedPersonIds());
      personStartIndex = computeAnchoredPersonStart();
    },

    setPersonPanelHover(value: boolean) {
      hoverFrozen = value;
    },

    scrollMainViewport(delta: number) {
      if (!Number.isFinite(delta) || delta === 0) return;
      const normalMax = maxViewportStart(messages.length, mainViewportSize);
      // A wheel step from a short, top-aligned tail must not jump backwards.
      const maxStart = mainTopAligned ? Math.max(normalMax, mainStartIndex) : normalMax;
      mainStartIndex = Math.min(maxStart, Math.max(0, mainStartIndex + Math.trunc(delta)));
      mainTopAligned = mainStartIndex > normalMax;
      mainViewportRevision += 1;
      mainViewportMotion = null;
    },

    jumpMainViewportToUnread() {
      alignMainToUnread("locate");
    },

    scrollPersonViewport(delta: number) {
      const userIds = getSelectedUserIds();
      if (userIds.length === 0) {
        return;
      }
      personManualViewport = true;
      personStartIndex = scrollViewportStart(
        personStartIndex,
        delta,
        userIds.length,
        personViewportSize
      );
    },

    setPersonHistoryCount(value: number) {
      personHistoryCount = clampPersonHistoryCount(value);
      if (!personManualViewport) {
        personStartIndex = computeAnchoredPersonStart();
      }
    },

    setViewportSizes(patch: ViewportSizePatch) {
      if (typeof patch.mainViewportSize === "number") {
        const keepMainPinnedToBottom = isMainViewportAtBottom();
        mainViewportSize = clampViewportSize(patch.mainViewportSize);
        if (keepMainPinnedToBottom) {
          pinMainViewportToBottom();
        } else {
          clampMainViewportStart();
        }
      }

      if (typeof patch.personViewportSize === "number" &&
          clampViewportSize(patch.personViewportSize) !== personViewportSize) {
        personViewportSize = clampViewportSize(patch.personViewportSize);
        if (personManualViewport) {
          personStartIndex = clampViewportStart(
            personStartIndex,
            getSelectedUserIds().length,
            personViewportSize
          );
        } else {
          personStartIndex = computeAnchoredPersonStart();
        }
      }
    },

    setConnection(status: string, isConnected: boolean) {
      connectionStatus = status;
      connected = isConnected;
    },

    getMainVisible() {
      return messages.slice(
        mainStartIndex,
        mainStartIndex + mainViewportSize
      );
    },

    getPersonPanel(): PersonPanelSnapshot {
      const userIds = getSelectedUserIds();
      const selectedMessage = getSelectedLatestMessage();
      const visibleIds = userIds.slice(
        personStartIndex,
        personStartIndex + personViewportSize
      );
      const visibleMessages = visibleIds
        .map((id) => byId.get(id))
        .filter((message): message is DanmuMessage => Boolean(message));

      return {
        selectedUid,
        selectedNickname: selectedMessage?.nickname ?? null,
        selectedGuardType: selectedMessage?.guardType ?? null,
        anchorMessageId,
        hoverFrozen,
        visibleMessages,
        hiddenNewerCount: Math.max(
          0,
          userIds.length - (personStartIndex + personViewportSize)
        )
      };
    },

    getSnapshot(): AppSnapshot {
      return {
        connected,
        connectionStatus,
        mainVisible: api.getMainVisible(),
        firstUnreadMessageId: firstUnread()?.messageId ?? null,
        mainHiddenNewerCount: getMainHiddenNewerCount(),
        mainCacheNearFull: messages.filter((message) => !message.read).length >= Math.ceil(mainCapacity * 0.9),
        mainViewportRevision,
        mainViewportMotion,
        personPanel: api.getPersonPanel()
      };
    }
  };

  function resetPersonSelection() {
    selectedUid = null;
    anchorMessageId = null;
    personStartIndex = 0;
    personManualViewport = false;
    hoverFrozen = false;
  }

  function trimMainCapacity(protectedPersonIds: Set<number>) {
    if (messages.length < mainCapacity || messages.length <= 1) return;
    const targetSize = Math.max(1, mainCapacity - Math.ceil(mainCapacity / 10));
    const latestId = messages[messages.length - 1].messageId;
    // Keep the anchor; prefer offscreen rows, then oldest read rows before unread.
    const candidates = messages.filter((message) => message.messageId !== anchorMessageId);
    candidates.sort((a, b) =>
      Number(protectedPersonIds.has(a.messageId) || a.messageId === latestId) -
        Number(protectedPersonIds.has(b.messageId) || b.messageId === latestId) ||
      Number(b.read) - Number(a.read) || a.messageId - b.messageId
    );
    const removedIds = new Set(candidates.slice(0, messages.length - targetSize).map((message) => message.messageId));
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!removedIds.has(message.messageId)) continue;
      messages.splice(index, 1);
      byId.delete(message.messageId);
      removeMessageFromUserIndex(message);
      if (index < mainStartIndex) mainStartIndex--;
    }
  }

  function removeMessageFromUserIndex(message: DanmuMessage) {
    const userIds = idsByUid.get(message.uid);
    if (!userIds) {
      return;
    }

    const removeIndex = userIds.indexOf(message.messageId);
    if (removeIndex < 0) {
      return;
    }

    userIds.splice(removeIndex, 1);
    if (message.uid === selectedUid && removeIndex < personStartIndex) {
      personStartIndex = Math.max(0, personStartIndex - 1);
    }
    if (message.uid === selectedUid) {
      personStartIndex = Math.min(personStartIndex, Math.max(0, userIds.length - 1));
    }
    if (userIds.length === 0) idsByUid.delete(message.uid);
  }

  function trimPerUserCapacity(uid: string, protectedPersonIds: Set<number>) {
    const userIds = idsByUid.get(uid);
    if (!userIds) {
      return;
    }

    while (userIds.length > perUserCapacity) {
      const removeIndex = getPerUserTrimIndex(uid, userIds, protectedPersonIds);
      userIds.splice(removeIndex, 1);
      if (uid === selectedUid) {
        if (removeIndex < personStartIndex) personStartIndex--;
        personStartIndex = Math.min(personStartIndex, Math.max(0, userIds.length - 1));
      }
    }
  }

  function getPerUserTrimIndex(uid: string, userIds: number[], protectedPersonIds: Set<number>) {
    if (selectedUid !== uid || !anchorMessageId) {
      return 0;
    }

    // Reserve the newest arrival too; if the entire tiny cache is visible,
    // the hard capacity still wins, while the selected anchor is never removed.
    const offscreenIndex = userIds.findIndex((id, index) =>
      index < userIds.length - 1 && !protectedPersonIds.has(id)
    );
    if (offscreenIndex >= 0) return offscreenIndex;
    const firstNonAnchorIndex = userIds.findIndex(
      (messageId) => messageId !== anchorMessageId
    );
    return firstNonAnchorIndex >= 0 ? firstNonAnchorIndex : 0;
  }

  function getProtectedPersonIds() {
    const ids = new Set(getSelectedUserIds().slice(personStartIndex, personStartIndex + personViewportSize));
    if (anchorMessageId !== null) ids.add(anchorMessageId);
    return ids;
  }

  function isMainViewportAtBottom() {
    return (
      !mainTopAligned &&
      messages.length > mainViewportSize &&
      mainStartIndex >= maxViewportStart(messages.length, mainViewportSize)
    );
  }

  function pinMainViewportToBottom() {
    mainStartIndex = maxViewportStart(messages.length, mainViewportSize);
  }

  function clampMainViewportStart() {
    mainStartIndex = Math.min(mainStartIndex, mainTopAligned
      ? Math.max(0, messages.length - 1)
      : maxViewportStart(messages.length, mainViewportSize));
  }

  function firstUnread() {
    return messages.find((message) => !message.read);
  }

  function alignMainToUnread(motion: NonNullable<AppSnapshot["mainViewportMotion"]>) {
    const index = messages.findIndex((message) => !message.read);
    const previousStart = mainStartIndex;
    mainTopAligned = index >= 0;
    mainStartIndex = index >= 0 ? index : maxViewportStart(messages.length, mainViewportSize);
    mainViewportRevision += 1;
    mainViewportMotion = index >= 0 && previousStart !== mainStartIndex ? motion : null;
  }

  function getMainHiddenNewerCount() {
    return Math.max(0, messages.length - (mainStartIndex + mainViewportSize));
  }

  function getSelectedUserIds() {
    return selectedUid ? (idsByUid.get(selectedUid) ?? []) : [];
  }

  function getSelectedLatestMessage() {
    if (!selectedUid) {
      return null;
    }

    const userIds = idsByUid.get(selectedUid) ?? [];
    for (let index = userIds.length - 1; index >= 0; index -= 1) {
      const message = byId.get(userIds[index]);
      if (message) {
        return message;
      }
    }

    return null;
  }

  function computeAnchoredPersonStart() {
    const userIds = getSelectedUserIds();
    if (!anchorMessageId || userIds.length === 0) {
      return 0;
    }

    const anchorIndex = userIds.indexOf(anchorMessageId);
    if (anchorIndex < 0) {
      return Math.max(0, userIds.length - personViewportSize);
    }

    const latestStart = Math.max(0, userIds.length - personViewportSize);
    const historyCount = Math.min(personHistoryCount, personViewportSize - 1);
    return Math.min(latestStart, Math.max(0, anchorIndex - historyCount));
  }

  function scrollViewportStart(
    startIndex: number,
    delta: number,
    itemCount: number,
    viewportSize: number
  ) {
    const maxStart = maxViewportStart(itemCount, viewportSize);
    const next = startIndex + Math.trunc(delta);
    return Math.min(maxStart, Math.max(0, next));
  }

  function clampViewportStart(
    startIndex: number,
    itemCount: number,
    viewportSize: number
  ) {
    return Math.min(maxViewportStart(itemCount, viewportSize), startIndex);
  }

  function maxViewportStart(itemCount: number, viewportSize: number) {
    return Math.max(0, itemCount - viewportSize);
  }

  function clampViewportSize(value: number) {
    return Math.min(100, Math.max(1, Math.trunc(value)));
  }

  function clampPersonHistoryCount(value: number) {
    return Math.min(3, Math.max(0, Math.trunc(value)));
  }

  return api;
}
