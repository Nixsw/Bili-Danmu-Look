import { describe, expect, it } from "vitest";
import {
  createMessageStore,
  normalizeIncomingDanmu
} from "./messageStore";
import type { IncomingDanmuRaw } from "./types";

const baseRaw = (overrides: Partial<IncomingDanmuRaw> = {}): IncomingDanmuRaw => ({
  content: "你好",
  uid: 100000001,
  nickname: "观众A",
  userLevel: 12,
  fanLevel: 8,
  guardType: 0,
  timestampMs: 1_700_000_000_123,
  ...overrides
});

describe("person panel identity", () => {
  it("keeps the latest nickname and guard identity together while browsing history or switching users", () => {
    const store = createMessageStore({ mainViewportSize: 6, personViewportSize: 2 });
    expect(store.getPersonPanel().selectedGuardType).toBeNull();
    for (let index = 0; index < 5; index++) {
      store.ingest(baseRaw({ nickname: "旧昵称", guardType: 3 }));
    }
    store.selectUserAnchor(1);
    store.ingest(baseRaw({ nickname: "新昵称", guardType: 2 }));

    const expectLatestIdentity = () => {
      const panel = store.getPersonPanel();
      expect(panel.selectedNickname).toBe("新昵称");
      expect(panel.selectedGuardType).toBe(2);
    };
    expectLatestIdentity();
    expect(store.getPersonPanel().visibleMessages.map(message => message.messageId)).not.toContain(6);
    store.scrollPersonViewport(99);
    expectLatestIdentity();
    store.scrollPersonViewport(-99);
    expectLatestIdentity();

    const other = store.ingest(baseRaw({ uid: 100000002, nickname: "另一位观众", guardType: 0 }));
    store.selectUserAnchor(other.messageId);
    expect(store.getPersonPanel().selectedNickname).toBe("另一位观众");
    expect(store.getPersonPanel().selectedGuardType).toBe(0);
  });
});

describe("normalizeIncomingDanmu", () => {
  it("normalizes uid and millisecond timestamps", () => {
    const msg = normalizeIncomingDanmu(baseRaw({ uid: "9007199254740993" }), 7);

    expect(msg.messageId).toBe(7);
    expect(msg.uid).toBe("9007199254740993");
    expect(msg.timestampMs).toBe(1_700_000_000_123);
    expect(msg.read).toBe(false);
  });

  it("accepts second timestamps when timestampMs is absent", () => {
    const msg = normalizeIncomingDanmu(
      baseRaw({ timestampMs: undefined, timestamp: 1_700_000_010 }),
      8
    );

    expect(msg.timestampMs).toBe(1_700_000_010_000);
  });

  it("preserves optional Bilibili fan medal color fields", () => {
    const fanMedalColors = {
      start: "#111111",
      end: "#222222",
      border: "#333333",
      text: "#FFFFFF",
      level: "#FFFF00"
    };

    const msg = normalizeIncomingDanmu(baseRaw({ fanMedalColors }), 9);

    expect(msg.fanMedalColors).toEqual(fanMedalColors);
  });

  it("normalizes super chat metadata as an independent message type", () => {
    const msg = normalizeIncomingDanmu(
      baseRaw({
        content: "SC来了",
        messageType: "superChat",
        superChat: {
          id: "9001",
          price: 30,
          startTimeMs: 1_700_000_000_000,
          endTimeMs: 1_700_000_060_000,
          durationSec: 60
        }
      }),
      10
    );

    expect(msg.messageType).toBe("superChat");
    expect(msg.superChat?.price).toBe(30);
  });

  it("rejects invalid content length and level ranges", () => {
    expect(() => normalizeIncomingDanmu(baseRaw({ content: "" }), 1)).toThrow(
      "content length"
    );
    expect(() =>
      normalizeIncomingDanmu(baseRaw({ content: "a".repeat(41) }), 1)
    ).toThrow("content length");
    expect(() => normalizeIncomingDanmu(baseRaw({ userLevel: 101 }), 1)).toThrow(
      "userLevel"
    );
    expect(normalizeIncomingDanmu(baseRaw({ fanLevel: 120 }), 1).fanLevel).toBe(
      120
    );
    expect(() => normalizeIncomingDanmu(baseRaw({ fanLevel: 121 }), 1)).toThrow(
      "fanLevel"
    );
    expect(() => normalizeIncomingDanmu(baseRaw({ fanLevel: -1 }), 1)).toThrow(
      "fanLevel"
    );
    expect(() => normalizeIncomingDanmu(baseRaw({ guardType: 4 }), 1)).toThrow(
      "guardType"
    );
  });
});

describe("main message viewport", () => {
  it("starts from the first row and does not auto-scroll when messages overflow", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });

    "ABCDEFG".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E"
    ]);
  });

  it("advances by one when the top visible message is acknowledged", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFG".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    store.ackMessage(1);

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "B",
      "C",
      "D",
      "E",
      "F"
    ]);
  });

  it("acknowledges all cached messages from the selected user", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    store.ingest(baseRaw({ content: "A", uid: 1, nickname: "甲" }));
    store.ingest(baseRaw({ content: "B", uid: 2, nickname: "乙" }));
    store.ingest(baseRaw({ content: "C", uid: 1, nickname: "甲" }));
    store.ingest(baseRaw({ content: "D", uid: 1, nickname: "甲" }));
    store.ingest(baseRaw({ content: "E", uid: 2, nickname: "乙" }));

    store.ackUserMessages("1");

    expect(store.getMainVisible().map((msg) => `${msg.content}:${msg.read}`)).toEqual([
      "B:false",
      "C:true",
      "D:true",
      "E:false"
    ]);
  });

  it("waits for unread messages above a clicked message before advancing", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFG".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    store.ackMessage(2);

    expect(store.getMainVisible().map((msg) => `${msg.content}:${msg.read}`)).toEqual([
      "A:false",
      "B:true",
      "C:false",
      "D:false",
      "E:false"
    ]);

    store.ackMessage(1);

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "C",
      "D",
      "E",
      "F",
      "G"
    ]);
  });

  it("puts the next unread first even when fewer than a full page remain", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFG".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    store.ackMessage(1);
    store.ackMessage(2);
    store.ackMessage(3);

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "D",
      "E",
      "F",
      "G"
    ]);
  });

  it("scrolls upward for history and downward for newer messages without auto-following new messages", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFGH".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    store.scrollMainViewport(2);
    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "C",
      "D",
      "E",
      "F",
      "G"
    ]);

    store.scrollMainViewport(-1);
    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "B",
      "C",
      "D",
      "E",
      "F"
    ]);

    store.ingest(baseRaw({ content: "I", uid: 1, timestampMs: 1_009 }));
    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "B",
      "C",
      "D",
      "E",
      "F"
    ]);

    store.scrollMainViewport(99);
    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "E",
      "F",
      "G",
      "H",
      "I"
    ]);
  });

  it("counts hidden newer main messages as the viewport moves", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFG".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    expect(store.getSnapshot().mainHiddenNewerCount).toBe(2);

    store.scrollMainViewport(1);
    expect(store.getSnapshot().mainHiddenNewerCount).toBe(1);

    store.scrollMainViewport(99);
    expect(store.getSnapshot().mainHiddenNewerCount).toBe(0);
  });

  it("jumps the main viewport to the first unread message from the current top", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFGHIJ".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    store.ackMessage(1);
    store.ackMessage(2);
    store.ackMessage(3);
    store.scrollMainViewport(-1);
    expect(store.getMainVisible().map((msg) => `${msg.content}:${msg.read}`)).toEqual([
      "C:true",
      "D:false",
      "E:false",
      "F:false",
      "G:false"
    ]);

    store.jumpMainViewportToUnread();

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "D",
      "E",
      "F",
      "G",
      "H"
    ]);
  });

  it("puts the unread target first near the end and leaves space below", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFGHIJ".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    for (let messageId = 1; messageId <= 7; messageId += 1) {
      store.ackMessage(messageId);
    }
    store.scrollMainViewport(-5);
    expect(store.getMainVisible().map((msg) => `${msg.content}:${msg.read}`)).toEqual([
      "C:true",
      "D:true",
      "E:true",
      "F:true",
      "G:true"
    ]);

    store.jumpMainViewportToUnread();

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "H",
      "I",
      "J"
    ]);
  });

  it("exposes the global unread marker across scrolling, batch reads and cache trimming", () => {
    const store = createMessageStore({
      mainCapacity: 4,
      mainViewportSize: 2,
      personViewportSize: 5
    });
    expect(store.getSnapshot().firstUnreadMessageId).toBeNull();
    store.ingest(baseRaw({ content: "A", uid: 1 }));
    store.ingest(baseRaw({ content: "B", uid: 2 }));
    store.ingest(baseRaw({ content: "C", uid: 1 }));
    store.scrollMainViewport(1);
    expect(store.getMainVisible().map((msg) => msg.messageId)).toEqual([2, 3]);
    expect(store.getSnapshot().firstUnreadMessageId).toBe(1);
    store.ackMainMessage(2);
    expect(store.getSnapshot().firstUnreadMessageId).toBe(1);
    store.ackUserMessages("1");
    expect(store.getSnapshot().firstUnreadMessageId).toBe(2);
    store.ingest(baseRaw({ content: "D", uid: 3 }));
    store.ingest(baseRaw({ content: "E", uid: 3 }));
    expect(store.getSnapshot().firstUnreadMessageId).toBe(2);
    store.ackMainMessage(2);
    expect(store.getSnapshot().firstUnreadMessageId).toBe(4);
    store.ackMessage(4);
    expect(store.getSnapshot().firstUnreadMessageId).toBe(5);
    store.ackMainMessage(5);
    expect(store.getSnapshot().firstUnreadMessageId).toBeNull();
    store.ingest(baseRaw({ content: "F", uid: 3 }));
    expect(store.getSnapshot().firstUnreadMessageId).toBe(6);
  });

  it("rejects later right-side clicks even if the earliest unread is outside the viewport", () => {
    const store = createMessageStore({ mainViewportSize: 3, personViewportSize: 5 });
    "ABCDEFG".split("").forEach((content) => store.ingest(baseRaw({ content })));
    store.scrollMainViewport(3);
    store.selectUserAnchor(4);
    store.ackMainMessage(4);
    expect(store.getMainVisible()[0].read).toBe(false);
    expect(store.getPersonPanel().anchorMessageId).toBe(4);
    store.jumpMainViewportToUnread();
    expect(store.getMainVisible()[0].messageId).toBe(1);
    store.ackMainMessage(3);
    store.ackMainMessage(1);
    expect(store.getMainVisible().map((msg) => [msg.messageId, msg.read])).toEqual([
      [2, false], [3, false], [4, false]
    ]);
  });

  it("allows person reads out of order, then advances past them when the first unread is read", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDE".split("").forEach((content) => store.ingest(baseRaw({ content })));
    store.ackMessage(2);
    store.ackMessage(3);
    expect(store.getMainVisible()[0].messageId).toBe(1);
    expect(store.getSnapshot().mainViewportRevision).toBe(0);
    store.ackMainMessage(1);
    expect(store.getMainVisible().map((msg) => msg.messageId)).toEqual([4, 5]);
    expect(store.getSnapshot().mainViewportMotion).toBe("advance");
  });

  it("keeps a located unread at the top through new messages, capacity changes and trimming", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5, mainCapacity: 6 });
    "ABCDEF".split("").forEach((content) => store.ingest(baseRaw({ content })));
    [1, 2, 3, 4, 5].forEach((id) => store.ackMainMessage(id));
    const revision = store.getSnapshot().mainViewportRevision;
    store.setViewportSizes({ mainViewportSize: 3 });
    store.ingest(baseRaw({ content: "G" }));
    store.setViewportSizes({ mainViewportSize: 8 });
    expect(store.getMainVisible().map((msg) => msg.content)).toEqual(["F", "G"]);
    expect(store.getSnapshot().mainViewportRevision).toBe(revision);
    expect(store.getSnapshot().mainHiddenNewerCount).toBe(0);
  });

  it("locates the global unread in either direction without changing its read state", () => {
    const store = createMessageStore({ mainViewportSize: 3, personViewportSize: 5 });
    "ABCDEFGH".split("").forEach((content) => store.ingest(baseRaw({ content })));
    store.ackMainMessage(1);
    store.scrollMainViewport(99);
    store.jumpMainViewportToUnread();
    expect(store.getMainVisible()[0]).toMatchObject({ messageId: 2, read: false });
    expect(store.getSnapshot().mainViewportMotion).toBe("locate");
    store.scrollMainViewport(-1);
    store.jumpMainViewportToUnread();
    expect(store.getMainVisible()[0]).toMatchObject({ messageId: 2, read: false });
  });

  it("keeps wheel steps continuous when leaving the top-aligned tail", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFGH".split("").forEach((content) => store.ingest(baseRaw({ content })));
    [1, 2, 3, 4, 5, 6].forEach((id) => store.ackMainMessage(id));
    store.scrollMainViewport(1);
    expect(store.getMainVisible()[0].messageId).toBe(7);
    store.scrollMainViewport(-1);
    expect(store.getMainVisible()[0].messageId).toBe(6);
    store.scrollMainViewport(-1);
    expect(store.getMainVisible()[0].messageId).toBe(5);
    expect(store.getSnapshot().mainViewportMotion).toBeNull();
    store.jumpMainViewportToUnread();
    expect(store.getMainVisible()[0].messageId).toBe(7);
  });

  it("ignores stale and missing clicks and does not animate after the last unread", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    store.jumpMainViewportToUnread();
    expect(store.getSnapshot().mainViewportMotion).toBeNull();
    store.ingest(baseRaw({ content: "A" }));
    store.ingest(baseRaw({ content: "B" }));
    store.ackMainMessage(1);
    const revision = store.getSnapshot().mainViewportRevision;
    store.ackMainMessage(1);
    store.ackMessage(1);
    store.ackMessage(999);
    expect(store.getSnapshot().mainViewportRevision).toBe(revision);
    store.ackMainMessage(2);
    expect(store.getMainVisible().every((msg) => msg.read)).toBe(true);
    expect(store.getSnapshot().mainViewportMotion).toBeNull();
  });

  it("jumps the main viewport to the newest page when no unread message remains", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFGH".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    for (let messageId = 1; messageId <= 8; messageId += 1) {
      store.ackMessage(messageId);
    }
    store.scrollMainViewport(-2);

    store.jumpMainViewportToUnread();

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "D",
      "E",
      "F",
      "G",
      "H"
    ]);
  });

  it("keeps the bottom pinned when a new message arrives while already at the bottom", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFG".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    store.scrollMainViewport(99);
    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "C",
      "D",
      "E",
      "F",
      "G"
    ]);

    store.ingest(baseRaw({ content: "H", uid: 1, timestampMs: 1_008 }));

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "D",
      "E",
      "F",
      "G",
      "H"
    ]);
  });

  it("keeps the bottom pinned when the main viewport shrinks at the bottom", () => {
    const store = createMessageStore({ mainViewportSize: 5, personViewportSize: 5 });
    "ABCDEFGHIJ".split("").forEach((content, index) => {
      store.ingest(baseRaw({ content, uid: 1, timestampMs: 1_000 + index }));
    });

    store.scrollMainViewport(99);
    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "F",
      "G",
      "H",
      "I",
      "J"
    ]);

    store.setViewportSizes({ mainViewportSize: 3 });

    expect(store.getMainVisible().map((msg) => msg.content)).toEqual([
      "H",
      "I",
      "J"
    ]);
  });
});

describe("person panel anchored viewport", () => {
  it("keeps the anchor at the bottom when there are no newer messages", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 5; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(5);

    expect(store.getPersonPanel().selectedNickname).toBe("观众A");
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5"
    ]);
  });

  it("moves the anchor no higher than the second row when newer messages exist", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 8; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(3);

    const panel = store.getPersonPanel();
    expect(panel.visibleMessages.map((msg) => msg.content)).toEqual([
      "M2",
      "M3",
      "M4",
      "M5",
      "M6"
    ]);
    expect(panel.hiddenNewerCount).toBe(2);
  });

  it("allows the anchor on the first row when person history count is zero", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 8; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.setPersonHistoryCount(0);
    store.selectUserAnchor(3);

    const panel = store.getPersonPanel();
    expect(panel.visibleMessages.map((msg) => msg.content)).toEqual([
      "M3",
      "M4",
      "M5",
      "M6",
      "M7"
    ]);
    expect(panel.visibleMessages.findIndex((msg) => msg.messageId === panel.anchorMessageId)).toBe(0);
    expect(panel.hiddenNewerCount).toBe(1);
  });

  it("shows three person history messages above the anchor when configured", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 8; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.setPersonHistoryCount(3);
    store.selectUserAnchor(5);

    const panel = store.getPersonPanel();
    expect(panel.visibleMessages.map((msg) => msg.content)).toEqual([
      "M2",
      "M3",
      "M4",
      "M5",
      "M6"
    ]);
    expect(panel.visibleMessages.findIndex((msg) => msg.messageId === panel.anchorMessageId)).toBe(3);
    expect(panel.hiddenNewerCount).toBe(2);
  });

  it("keeps the selected person viewport full near the bottom when history count is high", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 7; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.setPersonHistoryCount(3);
    store.selectUserAnchor(7);

    const panel = store.getPersonPanel();
    expect(panel.visibleMessages.map((msg) => msg.content)).toEqual([
      "M3",
      "M4",
      "M5",
      "M6",
      "M7"
    ]);
    expect(panel.visibleMessages.findIndex((msg) => msg.messageId === panel.anchorMessageId)).toBe(4);
    expect(panel.hiddenNewerCount).toBe(0);
  });

  it("does not override a manually scrolled selected person viewport when history count changes", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 8; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(5);
    store.scrollPersonViewport(-1);
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M3",
      "M4",
      "M5",
      "M6",
      "M7"
    ]);

    store.setPersonHistoryCount(3);

    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M3",
      "M4",
      "M5",
      "M6",
      "M7"
    ]);
  });

  it("keeps the anchor on its current row when newer messages arrive", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 5; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(3);
    store.ingest(baseRaw({ content: "M6", uid: 42, timestampMs: 6 }));
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5"
    ]);

    store.ingest(baseRaw({ content: "M7", uid: 42, timestampMs: 7 }));

    const panel = store.getPersonPanel();
    expect(panel.visibleMessages.map((msg) => msg.content)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5"
    ]);
    expect(panel.visibleMessages.findIndex((msg) => msg.messageId === panel.anchorMessageId)).toBe(2);
    expect(panel.hiddenNewerCount).toBe(2);
  });

  it("preserves the selected anchor when trimming the per-user message cache", () => {
    const store = createMessageStore({
      mainViewportSize: 8,
      personViewportSize: 5,
      perUserCapacity: 5
    });
    for (let i = 1; i <= 5; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(3);
    for (let i = 6; i <= 8; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    const panel = store.getPersonPanel();
    expect(panel.visibleMessages.some((msg) => msg.messageId === panel.anchorMessageId)).toBe(true);
    expect(panel.visibleMessages.map((msg) => msg.content)).toEqual([
      "M3",
      "M5",
      "M6",
      "M7",
      "M8"
    ]);
  });

  it("preserves the selected anchor when trimming the main message cache", () => {
    const store = createMessageStore({
      mainCapacity: 10,
      perUserCapacity: 20,
      mainViewportSize: 5,
      personViewportSize: 3
    });
    for (let i = 1; i <= 5; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(3);
    for (let i = 6; i <= 12; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    const panel = store.getPersonPanel();
    expect(panel.visibleMessages.some((msg) => msg.messageId === panel.anchorMessageId)).toBe(true);
    expect(panel.visibleMessages.map((msg) => msg.content)).toEqual([
      "M2",
      "M3",
      "M4"
    ]);
    expect(panel.hiddenNewerCount).toBe(6);
  });

  it("allows the anchor on the first row when no earlier history exists", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 6; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(1);

    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5"
    ]);
  });

  it("does not shift upward while hovered, but appends new messages when space exists", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 4; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(3);
    store.setPersonPanelHover(true);
    store.ingest(baseRaw({ content: "M5", uid: 42, timestampMs: 5 }));
    store.ingest(baseRaw({ content: "M6", uid: 42, timestampMs: 6 }));

    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5"
    ]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(1);

    store.setPersonPanelHover(false);

    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5"
    ]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(1);
  });

  it("scrolls selected person history and newer messages while keeping newer count accurate", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 9; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(4);
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M3",
      "M4",
      "M5",
      "M6",
      "M7"
    ]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(2);

    store.scrollPersonViewport(-2);
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5"
    ]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(4);

    store.setPersonPanelHover(true);
    store.scrollPersonViewport(99);
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M5",
      "M6",
      "M7",
      "M8",
      "M9"
    ]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(0);

    store.setPersonPanelHover(false);
    store.ingest(baseRaw({ content: "M10", uid: 42, timestampMs: 10 }));
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M5",
      "M6",
      "M7",
      "M8",
      "M9"
    ]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(1);
  });

  it("updates the selected person viewport size to fill a taller panel", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let i = 1; i <= 9; i += 1) {
      store.ingest(baseRaw({ content: `M${i}`, uid: 42, timestampMs: i }));
    }

    store.selectUserAnchor(4);
    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M3",
      "M4",
      "M5",
      "M6",
      "M7"
    ]);

    store.setViewportSizes({ personViewportSize: 8 });

    expect(store.getPersonPanel().visibleMessages.map((msg) => msg.content)).toEqual([
      "M2",
      "M3",
      "M4",
      "M5",
      "M6",
      "M7",
      "M8",
      "M9"
    ]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(0);
  });
});
