export type MessageContextMenuScope = "main" | "person";
export type NativeContextMenuArea = MessageContextMenuScope | "background" | "menu";

const MAIN_MESSAGE_CONTEXT_MENU_LABELS = [
  "复制弹幕",
  "复制昵称",
  "复制UID",
  "全部已读此人"
] as const;

const PERSON_MESSAGE_CONTEXT_MENU_LABELS = [
  "复制弹幕",
  "全部已读"
] as const;

export function getMessageContextMenuLabels(scope: MessageContextMenuScope) {
  return scope === "person"
    ? [...PERSON_MESSAGE_CONTEXT_MENU_LABELS]
    : [...MAIN_MESSAGE_CONTEXT_MENU_LABELS];
}

export function shouldSuppressNativeContextMenu(_area: NativeContextMenuArea) {
  return true;
}
