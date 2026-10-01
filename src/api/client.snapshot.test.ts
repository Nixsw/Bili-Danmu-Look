import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AppSnapshot } from "../core/types";
import { createDanmuClient } from "./client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function snapshot(snapshotSequence: string, patch: Partial<AppSnapshot> = {}) {
  return {
    snapshotSequence,
    connected: true,
    connectionStatus: "已连接",
    anchorName: null,
    anchorAvatarUrl: null,
    anchorAvatarFrameUrl: null,
    mainVisible: [],
    firstUnreadMessageId: null,
    mainHiddenNewerCount: 0,
    mainCacheNearFull: false,
    mainViewportRevision: 7,
    mainViewportMotion: null,
    personPanel: {
      selectedUid: null,
      selectedNickname: null,
      selectedGuardType: null,
      anchorMessageId: null,
      hoverFrozen: false,
      visibleMessages: [],
      hiddenNewerCount: 0
    },
    ...patch
  } satisfies AppSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function emitSnapshot(value: AppSnapshot) {
  const [event, callback] = vi.mocked(listen).mock.calls.at(-1)!;
  callback({ event, id: 1, payload: value });
}

describe("desktop snapshot delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval
    });
    vi.mocked(listen).mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a newer event when an older poll arrives with the same main viewport revision", async () => {
    const oldPoll = deferred<AppSnapshot>();
    vi.mocked(invoke)
      .mockResolvedValueOnce(snapshot("1"))
      .mockReturnValueOnce(oldPoll.promise)
      .mockResolvedValueOnce(snapshot("4", { mainHiddenNewerCount: 8 }));
    const received: AppSnapshot[] = [];
    const dispose = await createDanmuClient().init((value) => received.push(value));

    await vi.advanceTimersByTimeAsync(500);
    emitSnapshot(snapshot("3", {
      mainHiddenNewerCount: 4,
      personPanel: { ...snapshot("3").personPanel, hiddenNewerCount: 7 }
    }));
    oldPoll.resolve(snapshot("2"));
    await vi.advanceTimersByTimeAsync(0);

    expect(received.at(-1)).toMatchObject({
      snapshotSequence: "3",
      mainViewportRevision: 7,
      mainHiddenNewerCount: 4,
      personPanel: { hiddenNewerCount: 7 }
    });
    expect(received).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(received.at(-1)).toMatchObject({ snapshotSequence: "4", mainHiddenNewerCount: 8 });
    dispose();
  });

  it("rejects older events after a poll even beyond the JavaScript safe integer boundary", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(snapshot("9007199254740992"))
      .mockResolvedValueOnce(snapshot("9007199254740993", { mainHiddenNewerCount: 3 }));
    const received: AppSnapshot[] = [];
    const dispose = await createDanmuClient().init((value) => received.push(value));
    await vi.advanceTimersByTimeAsync(500);
    emitSnapshot(snapshot("9007199254740992", { mainHiddenNewerCount: 2 }));

    expect(received.at(-1)).toMatchObject({ snapshotSequence: "9007199254740993", mainHiddenNewerCount: 3 });
    expect(received).toHaveLength(2);
    dispose();
  });

  it("does not deliver an already accepted snapshot sequence twice", async () => {
    vi.mocked(invoke).mockResolvedValue(snapshot("9"));
    const received: AppSnapshot[] = [];
    const dispose = await createDanmuClient().init((value) => received.push(value));
    emitSnapshot(snapshot("9"));
    await vi.advanceTimersByTimeAsync(500);
    expect(received).toHaveLength(1);
    dispose();
  });

  it("ignores in-flight deliveries after disposal and releases a late event subscription", async () => {
    const pendingPoll = deferred<AppSnapshot>();
    const pendingListen = deferred<UnlistenFn>();
    const unlisten = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(pendingListen.promise);
    vi.mocked(invoke).mockResolvedValueOnce(snapshot("1")).mockReturnValueOnce(pendingPoll.promise);
    const received: AppSnapshot[] = [];
    const dispose = await createDanmuClient().init((value) => received.push(value));
    await vi.advanceTimersByTimeAsync(500);
    dispose();
    pendingPoll.resolve(snapshot("2"));
    emitSnapshot(snapshot("3"));
    pendingListen.resolve(unlisten);
    await vi.advanceTimersByTimeAsync(1000);

    expect(received).toHaveLength(1);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("starts a fresh acceptance boundary for a new client lifetime", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(snapshot("50")).mockResolvedValueOnce(snapshot("1"));
    const first: AppSnapshot[] = [];
    const disposeFirst = await createDanmuClient().init((value) => first.push(value));
    const oldCallback = vi.mocked(listen).mock.calls.at(-1)![1];
    disposeFirst();
    const second: AppSnapshot[] = [];
    const disposeSecond = await createDanmuClient().init((value) => second.push(value));
    oldCallback({ event: "danmu_state_changed", id: 1, payload: snapshot("51") });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ snapshotSequence: "1" });
    disposeSecond();
  });
});

describe("browser snapshot delivery", () => {
  it("continues increasing sequences through cleanup and connection changes", async () => {
    const client = createDanmuClient();
    const received: AppSnapshot[] = [];
    const dispose = await client.init((value) => received.push(value));
    await client.clearAllMessages();
    await client.disconnect();
    const sequences = received.map((value) => value.snapshotSequence);
    expect(sequences.every((value) => typeof value === "string")).toBe(true);
    expect(BigInt(sequences[1])).toBeGreaterThan(BigInt(sequences[0]));
    expect(BigInt(sequences[2])).toBeGreaterThan(BigInt(sequences[1]));
    dispose();
  });

  it("stops publishing browser snapshots after disposal", async () => {
    const client = createDanmuClient();
    const received: AppSnapshot[] = [];
    const dispose = await client.init((value) => received.push(value));
    dispose();
    await client.disconnect();
    expect(received).toHaveLength(1);
  });
});
