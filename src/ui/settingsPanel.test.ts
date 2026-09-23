import { describe, expect, it, vi } from "vitest";
import type { DisplayConfig } from "../api/client";
import { applyConnectApiUrl, createConnectApiUrlPatch } from "./settingsPanel";

const oldConfig: DisplayConfig = {
  connectApiUrl: "http://127.0.0.1:2333/broken",
  opacity: 0.82,
  fontSize: 14,
  personHistoryCount: 1
};
const newUrl = "http://127.0.0.1:2333/connect";

describe("settings panel actions", () => {
  it("creates a connect api url patch from the edited draft", () => {
    expect(
      createConnectApiUrlPatch(
        "  http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=abc  "
      )
    ).toEqual({
      connectApiUrl:
        "http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=abc"
    });
  });

  it("waits for the new address to be saved before restarting the old retry task", async () => {
    let activeConfig = oldConfig;
    let finishSaving!: (config: DisplayConfig) => void;
    const saved = new Promise<DisplayConfig>((resolve) => {
      finishSaving = resolve;
    });
    const updateConfig = vi.fn(async () => {
      activeConfig = await saved;
      return activeConfig;
    });
    const reconnect = vi.fn(async () => {
      expect(activeConfig.connectApiUrl).toBe(newUrl);
    });

    const applying = applyConnectApiUrl(`  ${newUrl}  `, { updateConfig, reconnect });
    expect(updateConfig).toHaveBeenCalledWith({ connectApiUrl: newUrl });
    expect(reconnect).not.toHaveBeenCalled();

    const nextConfig = { ...oldConfig, connectApiUrl: newUrl };
    finishSaving(nextConfig);
    await expect(applying).resolves.toEqual(nextConfig);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("restarts immediately even when the submitted address has not changed", async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    await applyConnectApiUrl(oldConfig.connectApiUrl, {
      updateConfig: vi.fn().mockResolvedValue(oldConfig),
      reconnect
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not restart with the old address when saving fails", async () => {
    const reconnect = vi.fn();
    await expect(applyConnectApiUrl(newUrl, {
      updateConfig: vi.fn().mockRejectedValue(new Error("无法保存配置")),
      reconnect
    })).rejects.toThrow("无法保存配置");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("reports rejected addresses instead of claiming that the old address was applied", async () => {
    const reconnect = vi.fn();
    await expect(applyConnectApiUrl("invalid-address", {
      updateConfig: vi.fn().mockResolvedValue(oldConfig),
      reconnect
    })).rejects.toThrow("接口地址未生效");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("surfaces a reconnect error even after the new address has been saved", async () => {
    await expect(applyConnectApiUrl(newUrl, {
      updateConfig: vi.fn().mockResolvedValue({ ...oldConfig, connectApiUrl: newUrl }),
      reconnect: vi.fn().mockRejectedValue(new Error("无法重新连接"))
    })).rejects.toThrow("无法重新连接");
  });
});
