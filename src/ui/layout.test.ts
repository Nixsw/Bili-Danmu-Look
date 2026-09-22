import { describe, expect, test } from "vitest";
import {
  getSplitLayout,
  isPersonPanelVisible,
  MAIN_READABLE_WIDTH,
  PERSON_PANEL_DEFAULT_WIDTH,
  PERSON_PANEL_MIN_WIDTH
} from "./layout";

describe("isPersonPanelVisible", () => {
  test("shows the person panel by default even before a UID is selected", () => {
    expect(isPersonPanelVisible()).toBe(true);
  });

  test("keeps the person panel visible as a permanent layout column", () => {
    expect(isPersonPanelVisible()).toBe(true);
  });
});

describe("getSplitLayout", () => {
  test("keeps the main panel at the readable width and gives extra width to the person panel", () => {
    expect(
      getSplitLayout({
        totalWidth: 760,
        personVisible: true
      })
    ).toEqual({
      mainWidth: MAIN_READABLE_WIDTH,
      personWidth: 340
    });
  });

  test("uses the default 180px person panel at the default 600px window width", () => {
    expect(
      getSplitLayout({
        totalWidth: MAIN_READABLE_WIDTH + PERSON_PANEL_DEFAULT_WIDTH,
        personVisible: true
      })
    ).toEqual({
      mainWidth: MAIN_READABLE_WIDTH,
      personWidth: PERSON_PANEL_DEFAULT_WIDTH
    });
  });

  test("keeps the main panel readable while shrinking the person panel first", () => {
    expect(
      getSplitLayout({
        totalWidth: 560,
        personVisible: true
      })
    ).toEqual({
      mainWidth: MAIN_READABLE_WIDTH,
      personWidth: 140
    });
  });

  test("preserves a dragged split ratio inside minimum width bounds", () => {
    expect(
      getSplitLayout({
        totalWidth: 760,
        personVisible: true,
        personRatio: 0.5
      })
    ).toEqual({
      mainWidth: 380,
      personWidth: 380
    });
  });

  test("clamps a dragged split so the person panel keeps a usable minimum width", () => {
    expect(
      getSplitLayout({
        totalWidth: 500,
        personVisible: true,
        personRatio: 0.1
      })
    ).toEqual({
      mainWidth: 500 - PERSON_PANEL_MIN_WIDTH,
      personWidth: PERSON_PANEL_MIN_WIDTH
    });
  });

  test("gives the full width to the main panel when the person panel is hidden", () => {
    expect(
      getSplitLayout({
        totalWidth: 760,
        personVisible: false
      })
    ).toEqual({
      mainWidth: 760,
      personWidth: 0
    });
  });
});
