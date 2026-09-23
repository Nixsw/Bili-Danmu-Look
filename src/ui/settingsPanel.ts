export function createConnectApiUrlPatch(connectApiUrlDraft: string) {
  return {
    connectApiUrl: connectApiUrlDraft.trim()
  };
}

const MESSAGE_SIZE_LABELS = ["极小", "小", "正常", "稍大", "大", "特大", "超大"];

export function getMessageSizeLabel(fontSize: number) {
  const index = Math.max(0, Math.min(MESSAGE_SIZE_LABELS.length - 1, Math.round(fontSize) - 12));
  return MESSAGE_SIZE_LABELS[index];
}
