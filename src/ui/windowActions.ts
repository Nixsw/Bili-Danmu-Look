export function getWindowDisplayTitle(anchorName: string | null | undefined) {
  return anchorName?.trim() || "看弹幕工具";
}

export function getSystemWindowTitle(anchorName: string | null | undefined) {
  const name = anchorName?.trim();
  return name ? `${name} - 小小鱼弹幕` : "看弹幕工具 - 小小鱼弹幕";
}

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
