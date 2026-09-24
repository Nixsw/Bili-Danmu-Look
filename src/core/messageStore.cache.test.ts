import { describe, expect, it } from "vitest";
import { createMessageStore } from "./messageStore";

const raw = (id: number, uid = 42) => ({
  content: `M${id}`, uid, nickname: `观众${uid}`,
  userLevel: 12, fanLevel: 8, guardType: 0, timestampMs: id
});

describe("main cache batch eviction", () => {
  const mainIds = (store: ReturnType<typeof createMessageStore>) =>
    store.getMainVisible().map((message) => message.messageId);

  it("evicts a rounded-up tenth at the configured limit without changing that limit", () => {
    const store = createMessageStore({ mainCapacity: 21, mainViewportSize: 100, personViewportSize: 3 });
    for (let id = 1; id <= 20; id++) store.ingest(raw(id));
    expect(mainIds(store)).toHaveLength(20);
    store.ingest(raw(21));
    expect(mainIds(store)).toEqual(Array.from({ length: 18 }, (_, index) => index + 4));
    store.ingest(raw(22));
    expect(mainIds(store)).toHaveLength(19);
  });

  it("evicts older read rows before unread, even when the read rows are not at the front", () => {
    const store = createMessageStore({ mainCapacity: 20, mainViewportSize: 100, personViewportSize: 3 });
    for (let id = 1; id <= 19; id++) store.ingest(raw(id));
    store.ackMessage(5);
    store.ackMessage(18);
    store.ingest(raw(20));
    expect(mainIds(store)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1).filter((id) => id !== 5 && id !== 18));
    expect(store.getSnapshot().firstUnreadMessageId).toBe(1);
  });

  it("uses the oldest unread only for the remainder of the batch", () => {
    const store = createMessageStore({ mainCapacity: 21, mainViewportSize: 100, personViewportSize: 3 });
    for (let id = 1; id <= 20; id++) store.ingest(raw(id));
    store.ackMessage(5);
    store.ingest(raw(21));
    expect(mainIds(store)).toEqual(Array.from({ length: 19 }, (_, index) => index + 3).filter((id) => id !== 5));
    expect(store.getSnapshot().firstUnreadMessageId).toBe(3);
  });

  it("preserves both viewport positions when a batch removes rows before and after them", () => {
    const store = createMessageStore({ mainCapacity: 20, mainViewportSize: 3, personViewportSize: 3 });
    for (let id = 1; id <= 19; id++) store.ingest(raw(id));
    store.selectUserAnchor(10);
    store.scrollMainViewport(7);
    store.ackMessage(5);
    store.ackMessage(18);
    const before = personIds(store);
    store.ingest(raw(20));
    expect(mainIds(store)).toEqual([8, 9, 10]);
    expect(personIds(store)).toEqual(before);
  });

  it("keeps the left viewport through many full-cache cycles", () => {
    const store = createMessageStore({ mainCapacity: 20, mainViewportSize: 3, personViewportSize: 3 });
    for (let id = 1; id <= 10; id++) store.ingest(raw(id));
    store.selectUserAnchor(3);
    const before = personIds(store);
    for (let id = 11; id <= 200; id++) store.ingest(raw(id, id));
    expect(personIds(store)).toEqual(before);
    expect(personIds(store)).toContain(3);
    store.scrollMainViewport(999);
    expect(mainIds(store)).toContain(200);
  });

  it("bases the 90% warning on unread count and clears it after reads or eviction", () => {
    const store = createMessageStore({ mainCapacity: 21, mainViewportSize: 3, personViewportSize: 3 });
    for (let id = 1; id <= 18; id++) store.ingest(raw(id));
    expect(store.getSnapshot().mainCacheNearFull).toBe(false);
    store.ingest(raw(19));
    expect(store.getSnapshot().mainCacheNearFull).toBe(true);
    store.ackMessage(19);
    expect(store.getSnapshot().mainCacheNearFull).toBe(false);
    store.ingest(raw(20));
    expect(store.getSnapshot().mainCacheNearFull).toBe(true);
    store.ingest(raw(21));
    expect(store.getSnapshot().mainCacheNearFull).toBe(false);
  });

  it("keeps the default 1000-row limit and warns at 900 unread", () => {
    const store = createMessageStore({ mainViewportSize: 3, personViewportSize: 3 });
    for (let id = 1; id <= 899; id++) store.ingest(raw(id));
    expect(store.getSnapshot().mainCacheNearFull).toBe(false);
    store.ingest(raw(900));
    expect(store.getSnapshot().mainCacheNearFull).toBe(true);
    store.ackMessage(900);
    expect(store.getSnapshot().mainCacheNearFull).toBe(false);
  });
});
const personIds = (store: ReturnType<typeof createMessageStore>) =>
  store.getPersonPanel().visibleMessages.map((message) => message.messageId);

describe("person viewport cache regressions", () => {
  it("keeps a full viewport stationary on arrival and after hover ends", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let id = 1; id <= 5; id++) store.ingest(raw(id));
    store.selectUserAnchor(5);
    store.ingest(raw(6));
    expect(personIds(store)).toEqual([1, 2, 3, 4, 5]);
    store.setPersonPanelHover(true);
    store.ingest(raw(7));
    store.setPersonPanelHover(false);
    store.setViewportSizes({ personViewportSize: 5 });
    expect(personIds(store)).toEqual([1, 2, 3, 4, 5]);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(2);
  });

  it("does not move the selected user when another user's cache is trimmed", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 2, perUserCapacity: 5 });
    for (let id = 1; id <= 5; id++) store.ingest(raw(id));
    store.selectUserAnchor(4);
    store.scrollPersonViewport(1);
    expect(personIds(store)).toEqual([4, 5]);
    for (let id = 6; id <= 20; id++) store.ingest(raw(id, 99));
    expect(personIds(store)).toEqual([4, 5]);
  });

  it("restores an old clicked main message to a full per-user cache", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 5 });
    for (let id = 1; id <= 80; id++) store.ingest(raw(id));
    store.selectUserAnchor(3);
    expect(store.getPersonPanel().anchorMessageId).toBe(3);
    expect(personIds(store)).toContain(3);
    store.ingest(raw(81));
    expect(personIds(store)).toContain(3);
  });

  it("keeps visible rows when the selected user's history reaches its cap", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 3, perUserCapacity: 8 });
    for (let id = 1; id <= 8; id++) store.ingest(raw(id));
    store.selectUserAnchor(3);
    const before = personIds(store);
    for (let id = 9; id <= 20; id++) store.ingest(raw(id));
    expect(personIds(store)).toEqual(before);
    expect(store.getPersonPanel().hiddenNewerCount).toBe(5);
  });

  it("keeps read state when selecting a message outside the per-user index", () => {
    const store = createMessageStore({ mainViewportSize: 8, personViewportSize: 3, perUserCapacity: 5 });
    for (let id = 1; id <= 8; id++) store.ingest(raw(id));
    store.ackUserMessages("42");
    store.selectUserAnchor(1);
    expect(store.getPersonPanel().visibleMessages.find((message) => message.messageId === 1)?.read).toBe(true);
  });
});
