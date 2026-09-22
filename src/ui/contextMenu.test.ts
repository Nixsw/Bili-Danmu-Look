import { describe, expect, test } from "vitest";
import {
  getMessageContextMenuLabels,
  shouldSuppressNativeContextMenu
} from "./contextMenu";

describe("getMessageContextMenuLabels", () => {
  test("uses the full copy menu for main messages", () => {
    expect(getMessageContextMenuLabels("main")).toEqual([
      "复制弹幕",
      "复制昵称",
      "复制UID",
      "全部已读此人"
    ]);
  });

  test("uses the compact action menu for selected-person messages", () => {
    expect(getMessageContextMenuLabels("person")).toEqual([
      "复制弹幕",
      "全部已读"
    ]);
  });
});

describe("shouldSuppressNativeContextMenu", () => {
  test("suppresses the browser menu on blank application areas", () => {
    expect(shouldSuppressNativeContextMenu("background")).toBe(true);
  });

  test("suppresses the browser menu behind custom message menus", () => {
    expect(shouldSuppressNativeContextMenu("main")).toBe(true);
    expect(shouldSuppressNativeContextMenu("person")).toBe(true);
    expect(shouldSuppressNativeContextMenu("menu")).toBe(true);
  });
});
