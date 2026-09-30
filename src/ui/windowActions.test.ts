import { describe, expect, it } from "vitest";
import {
  getMainUnreadAnchorAction,
  getSystemWindowTitle,
  getWindowDisplayTitle,
  getWindowDismissAction
} from "./windowActions";

describe("window actions", () => {
  it.each([null, undefined, "", " \t\n\u3000"])("uses the distinct display and system fallbacks for a missing or blank name: %s", (anchorName) => {
    expect(getWindowDisplayTitle(anchorName)).toBe("看弹幕工具");
    expect(getSystemWindowTitle(anchorName)).toBe("看弹幕工具 - 小小鱼弹幕");
  });

  it("uses the trimmed Chinese anchor name and adds the brand only to the system title", () => {
    expect(getWindowDisplayTitle("  阿萨Aza \t")).toBe("阿萨Aza");
    expect(getSystemWindowTitle("  阿萨Aza \t")).toBe("阿萨Aza - 小小鱼弹幕");
  });

  it("preserves the full long name for system titles and lets layout truncate only the displayed title", () => {
    const anchorName = "很长的主播昵称".repeat(20);
    expect(getWindowDisplayTitle(anchorName)).toBe(anchorName);
    expect(getSystemWindowTitle(anchorName)).toBe(`${anchorName} - 小小鱼弹幕`);
  });

  it("uses minimize as the only window dismiss action", () => {
    expect(getWindowDismissAction()).toEqual({
      icon: "minus",
      title: "最小化"
    });
  });

  it("uses a separated top action for locating the main unread anchor", () => {
    expect(getMainUnreadAnchorAction()).toEqual({
      icon: "locateFixed",
      title: "定位未读消息",
      className: "icon-button main-unread-anchor-button"
    });
  });
});
