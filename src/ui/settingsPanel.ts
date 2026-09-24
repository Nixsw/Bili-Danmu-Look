import type { DanmuClient } from "../api/client";

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

const MESSAGE_SIZE_LABELS = ["极小", "小", "正常", "稍大", "大", "特大", "超大"];

export function getMessageSizeLabel(fontSize: number) {
  const index = Math.max(0, Math.min(MESSAGE_SIZE_LABELS.length - 1, Math.round(fontSize) - 12));
  return MESSAGE_SIZE_LABELS[index];
}
