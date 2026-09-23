import { describe, expect, it } from "vitest";
import { createMessageStore } from "./messageStore";

const raw = (id: number, uid = 42) => ({
  content: `M${id}`, uid, nickname: `观众${uid}`,
  userLevel: 12, fanLevel: 8, guardType: 3, timestampMs: id
});
const makeStore = (perUserCapacity = 50) => createMessageStore({
  mainCapacity: 100, perUserCapacity, mainViewportSize: 3, personViewportSize: 3
});
const mainIds = (store: ReturnType<typeof makeStore>) => store.getMainVisible().map(message => message.messageId);
const personIds = (store: ReturnType<typeof makeStore>) => store.getPersonPanel().visibleMessages.map(message => message.messageId);

describe("explicit message cleanup", () => {
  it("removes read rows from both panels and moves a deleted anchor to the next remaining message", () => {
    const store = makeStore();
    store.setConnection("已连接！", true);
    for (let id = 1; id <= 6; id++) store.ingest(raw(id, id % 2 ? 42 : 99));
    for (const id of [1, 3, 6]) store.ackMessage(id);
    store.selectUserAnchor(3);
    expect(store.clearReadMessages()).toBe(3);
    expect(mainIds(store)).toEqual([2, 4, 5]);
    expect(personIds(store)).toEqual([5]);
    expect(store.getSnapshot()).toMatchObject({
      connected: true, connectionStatus: "已连接！", firstUnreadMessageId: 2,
      mainHiddenNewerCount: 0, mainViewportMotion: null,
      personPanel: { selectedUid: "42", anchorMessageId: 5, hiddenNewerCount: 0 }
    });
    const revision = store.getSnapshot().mainViewportRevision;
    expect(store.clearReadMessages()).toBe(0);
    expect(store.getSnapshot().mainViewportRevision).toBe(revision);
    store.selectUserAnchor(3);
    expect(store.getPersonPanel().anchorMessageId).toBe(5);
  });

  it("preserves surviving viewport rows when read messages before and after them are removed", () => {
    const store = makeStore();
    for (let id = 1; id <= 10; id++) store.ingest(raw(id));
    store.selectUserAnchor(6);
    store.scrollMainViewport(5);
    const beforeMain = mainIds(store);
    const beforePerson = personIds(store);
    for (const id of [2, 4, 9]) store.ackMessage(id);
    expect(store.clearReadMessages()).toBe(3);
    expect(mainIds(store)).toEqual(beforeMain);
    expect(personIds(store)).toEqual(beforePerson);
    expect(store.getPersonPanel().anchorMessageId).toBe(6);
    expect(store.getSnapshot().mainHiddenNewerCount).toBe(1);
    expect(store.getSnapshot().firstUnreadMessageId).toBe(1);
  });

  it("restores an older unread replacement even when it was evicted from the personal index", () => {
    const store = makeStore(2);
    for (let id = 1; id <= 6; id++) store.ingest(raw(id));
    store.selectUserAnchor(5);
    store.ackMessage(5);
    store.ackMessage(6);
    expect(store.clearReadMessages()).toBe(2);
    expect(store.getPersonPanel().anchorMessageId).toBe(4);
    expect(personIds(store)).toContain(4);
    store.selectUserAnchor(5);
    expect(store.getPersonPanel().anchorMessageId).toBe(4);
  });

  it("clears the selected identity when that user has no messages left", () => {
    const store = makeStore();
    store.ingest(raw(1, 42));
    store.ingest(raw(2, 99));
    store.selectUserAnchor(1);
    store.ackMessage(1);
    expect(store.clearReadMessages()).toBe(1);
    expect(mainIds(store)).toEqual([2]);
    expect(store.getPersonPanel()).toMatchObject({
      selectedUid: null, selectedNickname: null, selectedGuardType: null,
      anchorMessageId: null, visibleMessages: [], hiddenNewerCount: 0
    });
  });

  it("keeps a valid short tail after deleting all visible rows and can still locate unread history", () => {
    const store = makeStore();
    for (let id = 1; id <= 8; id++) store.ingest(raw(id));
    store.scrollMainViewport(99);
    for (const id of [6, 7, 8]) store.ackMessage(id);
    expect(store.clearReadMessages()).toBe(3);
    expect(mainIds(store)).toEqual([5]);
    store.jumpMainViewportToUnread();
    expect(mainIds(store)).toEqual([1, 2, 3]);
  });

  it("clears every cache and warning while keeping the connection and fresh IDs for new arrivals", () => {
    const store = createMessageStore({ mainCapacity: 10, perUserCapacity: 5, mainViewportSize: 3, personViewportSize: 2 });
    store.setConnection("已连接！", true);
    for (let id = 1; id <= 9; id++) store.ingest(raw(id));
    store.selectUserAnchor(6);
    store.setPersonPanelHover(true);
    expect(store.getSnapshot().mainCacheNearFull).toBe(true);
    const revision = store.getSnapshot().mainViewportRevision;
    expect(store.clearAllMessages()).toBe(9);
    expect(store.getSnapshot()).toMatchObject({
      connected: true, connectionStatus: "已连接！", mainVisible: [], firstUnreadMessageId: null,
      mainHiddenNewerCount: 0, mainCacheNearFull: false, mainViewportMotion: null,
      personPanel: { selectedUid: null, anchorMessageId: null, hoverFrozen: false, visibleMessages: [], hiddenNewerCount: 0 }
    });
    expect(store.getSnapshot().mainViewportRevision).toBeGreaterThan(revision);
    expect(store.clearAllMessages()).toBe(0);
    expect(store.clearReadMessages()).toBe(0);
    const next = store.ingest(raw(10));
    expect(next.messageId).toBe(10);
    store.ackMessage(1);
    store.selectUserAnchor(6);
    expect(mainIds(store)).toEqual([10]);
    expect(store.getSnapshot().firstUnreadMessageId).toBe(10);
    expect(store.getPersonPanel().selectedUid).toBeNull();
    store.selectUserAnchor(10);
    store.ackMessage(10);
    expect(store.clearReadMessages()).toBe(1);
    expect(mainIds(store)).toEqual([]);
    expect(store.getPersonPanel().selectedUid).toBeNull();
  });
});
