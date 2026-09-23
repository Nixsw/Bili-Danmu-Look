import { describe, expect, test } from "vitest";
import { canScrollMessageContent } from "./messageScroll";

describe("canScrollMessageContent", () => {
  test("ordinary messages pass the wheel on to the message list", () => {
    expect(canScrollMessageContent({ scrollTop: 0, scrollHeight: 80, clientHeight: 80 }, 100)).toBe(false);
  });

  test("an oversized message consumes downward scrolling until its end", () => {
    expect(canScrollMessageContent({ scrollTop: 0, scrollHeight: 600, clientHeight: 424 }, 100)).toBe(true);
    expect(canScrollMessageContent({ scrollTop: 176, scrollHeight: 600, clientHeight: 424 }, 100)).toBe(false);
  });

  test("scrolling upward reads earlier content before moving to the previous message", () => {
    expect(canScrollMessageContent({ scrollTop: 100, scrollHeight: 600, clientHeight: 424 }, -100)).toBe(true);
    expect(canScrollMessageContent({ scrollTop: 0, scrollHeight: 600, clientHeight: 424 }, -100)).toBe(false);
  });

  test("horizontal wheel events do not claim vertical scrolling", () => {
    expect(canScrollMessageContent({ scrollTop: 100, scrollHeight: 600, clientHeight: 424 }, 0)).toBe(false);
  });
});
