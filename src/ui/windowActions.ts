export function getWindowDismissAction() {
  return {
    icon: "minus" as const,
    title: "最小化"
  };
}

export function getMainUnreadAnchorAction() {
  return {
    icon: "locateFixed" as const,
    title: "定位未读消息",
    className: "icon-button main-unread-anchor-button"
  };
}
