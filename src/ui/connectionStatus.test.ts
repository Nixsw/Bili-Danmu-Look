import { describe, expect, it } from "vitest";
import {
  formatConnectionStatusWithCountdown,
  formatTransientConnectionStatus,
  getConnectedToastDeadlineMs,
  getRetryDeadlineMs
} from "./connectionStatus";

describe("connection status countdown", () => {
  it("creates a retry deadline from a status message", () => {
    expect(getRetryDeadlineMs("接口.未开启(3)", 1_000)).toBe(4_000);
    expect(getRetryDeadlineMs("接口.解析异常(5)", 1_000)).toBe(6_000);
    expect(getRetryDeadlineMs("连接.意外断开(10)", 1_000)).toBe(11_000);
  });

  it("updates concise retry statuses without appending error details", () => {
    const text = formatConnectionStatusWithCountdown(
      "接口.请求超时(3)",
      3_000,
      2_100
    );

    expect(text).toBe("接口.请求超时(1)");
  });

  it("holds the initial number for at least 300 ms and counts whole remaining seconds", () => {
    const status = "接口.解析异常(3)";
    const deadline = getRetryDeadlineMs(status, 1_000);
    for (const now of [1_000, 1_299, 1_300, 1_999]) {
      expect(formatConnectionStatusWithCountdown(status, deadline, now)).toBe("接口.解析异常(3)");
    }
    expect(formatConnectionStatusWithCountdown(status, deadline, 2_000)).toBe("接口.解析异常(2)");
    expect(formatConnectionStatusWithCountdown(status, deadline, 3_000)).toBe("接口.解析异常(1)");
    expect(formatConnectionStatusWithCountdown(status, deadline, 4_000)).toBe("接口.解析异常(0)");
    expect(formatConnectionStatusWithCountdown(status, deadline, 9_000)).toBe("接口.解析异常(0)");
  });

  it("leaves statuses without retry text unchanged", () => {
    expect(formatConnectionStatusWithCountdown("对接中...", null, 2_000)).toBe(
      "对接中..."
    );
  });

  it("creates a five second deadline for the connected toast", () => {
    expect(getConnectedToastDeadlineMs("已连接！", 1_000)).toBe(6_000);
    expect(getConnectedToastDeadlineMs("连接中...", 1_000)).toBeNull();
  });

  it("hides the connected toast after five seconds", () => {
    expect(
      formatTransientConnectionStatus("已连接！", null, 6_000, 5_999)
    ).toBe("已连接！");
    expect(
      formatTransientConnectionStatus("已连接！", null, 6_000, 6_000)
    ).toBe("");
  });
});
