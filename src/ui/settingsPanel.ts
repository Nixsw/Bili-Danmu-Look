import type { DanmuClient } from "../api/client";
import { MESSAGE_SIZE_PRESETS, normalizeFontSize } from "../core/displaySettings";

export function createConnectApiUrlPatch(connectApiUrlDraft: string) {
  return {
    connectApiUrl: connectApiUrlDraft.trim()
  };
}

export async function applyConnectApiUrl(
  connectApiUrlDraft: string,
  client: Pick<DanmuClient, "updateConfig" | "reconnect">
) {
  const patch = createConnectApiUrlPatch(connectApiUrlDraft);
  const config = await client.updateConfig(patch);
  if (config.connectApiUrl !== patch.connectApiUrl) {
    throw new Error("接口地址未生效，请填写有效的接口地址");
  }
  // The running retry task keeps its original URL until explicitly restarted.
  // Reconnect even if the URL is unchanged so a manual retry starts immediately.
  await client.reconnect();
  return config;
}

export function getMessageSizeLabel(fontSize: number) {
  return MESSAGE_SIZE_PRESETS.find((preset) => preset.value === normalizeFontSize(fontSize))!.label;
}
