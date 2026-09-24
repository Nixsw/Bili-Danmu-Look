import { describe, expect, it } from "vitest";
import { normalizeFontSize, normalizeOpacity } from "./displaySettings";

describe("message size normalization", () => {
  it.each([
    [10, 10], [12, 12], [14, 14], [16, 16], [18, 18],
    [11, 12], [13, 14], [15, 16], [17, 18],
    [12.9, 12], [13.1, 14], [0, 10], [30, 18]
  ])("normalizes %s to the supported preset %s", (input, expected) => {
    expect(normalizeFontSize(input)).toBe(expected);
  });

  it.each([NaN, Infinity, -Infinity])("defaults invalid size %s to medium", (value) => {
    expect(normalizeFontSize(value)).toBe(14);
  });
});

describe("background opacity normalization", () => {
  it.each([
    [-1, 0.1], [0, 0.1], [0.1, 0.1], [0.45, 0.45],
    [0.82, 0.82], [0.99, 0.99], [1, 1], [2, 1]
  ])("normalizes %s to %s without reversing opacity", (input, expected) => {
    expect(normalizeOpacity(input)).toBe(expected);
  });

  it.each([NaN, Infinity, -Infinity])("defaults invalid opacity %s", (value) => {
    expect(normalizeOpacity(value)).toBe(0.82);
  });
});
