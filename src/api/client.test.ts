import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createDanmuClient } from "./client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser display configuration", () => {
  it("publishes no anchor name in the browser preview", async () => {
    const client = createDanmuClient();
    const onSnapshot = vi.fn();
    const dispose = await client.init(onSnapshot);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ anchorName: null }));
    expect(invoke).not.toHaveBeenCalled();
    dispose();
  });

  it("round trips both reference opacity endpoints and all five font sizes", async () => {
    const client = createDanmuClient();
    expect(await client.getConfig()).toMatchObject({ opacity: 0.82, fontSize: 14 });

    for (const fontSize of [10, 12, 14, 16, 18]) {
      for (const opacity of [0.1, 1]) {
        expect(await client.updateConfig({ fontSize, opacity })).toMatchObject({ fontSize, opacity });
        expect(await client.getConfig()).toMatchObject({ fontSize, opacity });
      }
    }
  });

  it("migrates legacy odd sizes and preserves display settings on unrelated patches", async () => {
    const client = createDanmuClient();
    await client.updateConfig({ opacity: 0.25, fontSize: 15 });
    const config = await client.updateConfig({ connectApiUrl: "http://localhost/custom" });
    expect(config).toMatchObject({ opacity: 0.25, fontSize: 16, connectApiUrl: "http://localhost/custom" });
    expect(await client.updateConfig({ fontSize: undefined, opacity: undefined })).toEqual(config);
  });

  it("clamps ranges and recovers non-finite values at the write boundary", async () => {
    const client = createDanmuClient();
    expect(await client.updateConfig({ opacity: 0, fontSize: 40 })).toMatchObject({ opacity: 0.1, fontSize: 18 });
    expect(await client.updateConfig({ opacity: Infinity, fontSize: NaN })).toMatchObject({ opacity: 0.82, fontSize: 14 });
  });
});

describe("desktop display configuration boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("normalizes legacy configuration returned by the desktop", async () => {
    vi.mocked(invoke).mockResolvedValue({
      connectApiUrl: "http://localhost/custom",
      opacity: 0.98,
      fontSize: 13,
      personHistoryCount: 2
    });
    expect(await createDanmuClient().getConfig()).toEqual({
      connectApiUrl: "http://localhost/custom",
      opacity: 0.98,
      fontSize: 14,
      personHistoryCount: 2
    });
    expect(invoke).toHaveBeenCalledWith("get_config");
  });

  it("sends only the requested normalized fields and normalizes the response", async () => {
    vi.mocked(invoke).mockResolvedValue({
      connectApiUrl: "http://localhost/custom",
      opacity: 0.1,
      fontSize: 17,
      personHistoryCount: 1
    });
    const result = await createDanmuClient().updateConfig({ opacity: 0, fontSize: 11 });
    expect(invoke).toHaveBeenCalledWith("update_config", { patch: { opacity: 0.1, fontSize: 12 } });
    expect(result).toMatchObject({ opacity: 0.1, fontSize: 18 });
  });
});
