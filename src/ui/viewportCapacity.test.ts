import { describe, expect, test } from "vitest";
import {
  estimateViewportCapacity,
  createViewportCapacityTracker
} from "./viewportCapacity";

describe("estimateViewportCapacity", () => {
  test("expands a fixed 14-row estimate when the container has room for more compact rows", () => {
    expect(
      estimateViewportCapacity({
        containerHeight: 640,
        rowHeights: Array.from({ length: 14 }, () => 28),
        gap: 4,
        paddingTop: 0,
        paddingBottom: 8
      })
    ).toBe(19);
  });

  test("uses observed average row height when rows wrap", () => {
    expect(
      estimateViewportCapacity({
        containerHeight: 640,
        rowHeights: [28, 44, 44, 28],
        gap: 4,
        paddingTop: 0,
        paddingBottom: 8
      })
    ).toBe(15);
  });

  test("does not overestimate when observed rows already exceed the container", () => {
    expect(
      estimateViewportCapacity({
        containerHeight: 100,
        rowHeights: [80, 20, 20],
        gap: 4,
        paddingTop: 0,
        paddingBottom: 0
      })
    ).toBe(1);
  });
});

describe("createViewportCapacityTracker", () => {
  const layout = {
    containerWidth: 158,
    containerHeight: 462,
    fontSize: 14,
    minRowHeight: 54,
    gap: 7,
    paddingTop: 0,
    paddingBottom: 0
  };

  test("stops alternating between one short row and an overflowing mixed slice", () => {
    const measure = createViewportCapacityTracker();
    const heights = [60, 400, 60, 60, 60, 60, 60];
    let count = heights.length;
    const counts = [];
    for (let pass = 0; pass < 6; pass += 1) {
      count = measure({
        ...layout,
        rowHeights: heights.slice(0, count),
        rowIds: heights.slice(0, count).map((_, index) => String(index))
      });
      counts.push(count);
    }
    expect(counts).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test("measures new scroll positions without forgetting a previously overflowing position", () => {
    const measure = createViewportCapacityTracker();
    measure({ ...layout, rowIds: ["1", "2"], rowHeights: [60, 400] });
    expect(measure({ ...layout, rowIds: ["3"], rowHeights: [60] })).toBe(7);
    expect(measure({ ...layout, rowIds: ["1"], rowHeights: [60] })).toBe(1);
  });

  test("stabilizes when growing a bottom-pinned viewport prepends a row", () => {
    const measure = createViewportCapacityTracker();
    const heights = [70, 70, 70, 119, 119];
    const ids = ["16", "17", "18", "19", "20"];
    let count = 5;
    const counts = [];
    for (let pass = 0; pass < 8; pass += 1) {
      count = measure({ ...layout, rowIds: ids.slice(-count), rowHeights: heights.slice(-count) });
      counts.push(count);
    }
    expect(counts.slice(-4)).toEqual([4, 4, 4, 4]);
  });

  test("stabilizes when an anchor requires removing and restoring a tall history row", () => {
    const measure = createViewportCapacityTracker();
    let count = 2;
    const counts = [];
    for (let pass = 0; pass < 8; pass += 1) {
      count = measure({
        ...layout, containerHeight: 426, paddingBottom: 2, gap: 4, minRowHeight: 28,
        rowIds: count > 1 ? ["19", "20"] : ["20"],
        rowHeights: count > 1 ? [260, 260] : [260]
      });
      counts.push(count);
    }
    expect(counts.slice(-4)).toEqual([1, 1, 1, 1]);
  });

  test("does not transfer a growth limit to an unrelated scroll position", () => {
    const measure = createViewportCapacityTracker();
    measure({ ...layout, rowIds: ["1"], rowHeights: [60] });
    measure({ ...layout, rowIds: ["20", "21"], rowHeights: [400, 100] });
    expect(measure({ ...layout, rowIds: ["1"], rowHeights: [60] })).toBe(7);
  });

  test("starts fresh when manual navigation replaces anchor or tail alignment", () => {
    const measure = createViewportCapacityTracker();
    measure({ ...layout, rowIds: ["1", "2"], rowHeights: [60, 400] });
    expect(measure({ ...layout, rowIds: ["1"], rowHeights: [60] })).toBe(1);
    measure.reset();
    expect(measure({ ...layout, rowIds: ["1"], rowHeights: [60] })).toBe(7);
  });

  test.each([
    { containerHeight: 700 },
    { containerWidth: 300 },
    { fontSize: 12 }
  ])("allows expansion again when the layout changes: %o", (change) => {
    const measure = createViewportCapacityTracker();
    measure({ ...layout, rowIds: ["1", "2"], rowHeights: [60, 400] });
    expect(measure({
      ...layout, ...change, rowIds: ["1"], rowHeights: [60]
    })).toBeGreaterThan(1);
  });

  test("probes a shorter next row instead of leaving space based on a tall row's average", () => {
    const measure = createViewportCapacityTracker();
    expect(measure({
      ...layout,
      containerHeight: 426,
      gap: 4,
      paddingBottom: 2,
      rowIds: ["20"],
      rowHeights: [260]
    })).toBe(2);
    expect(measure({
      ...layout,
      containerHeight: 426,
      gap: 4,
      paddingBottom: 2,
      rowIds: ["20", "21"],
      rowHeights: [260, 140]
    })).toBe(2);
  });

  test("keeps an overflowing candidate outside the painted range on both panels", () => {
    for (const gap of [4, 7]) {
      const measure = createViewportCapacityTracker();
      measure({ ...layout, gap, containerHeight: 150, rowIds: ["1"], rowHeights: [60] });
      expect(measure.getVisibleRange()).toEqual({ start: 0, end: 1 });
      expect(measure({
        ...layout, gap, containerHeight: 150, rowIds: ["1", "2"], rowHeights: [60, 100]
      })).toBe(1);
      expect(measure.getVisibleRange()).toEqual({ start: 0, end: 1 });
    }
  });

  test("a failed prepend probe keeps the fitting tail and its anchor visible", () => {
    const measure = createViewportCapacityTracker();
    expect(measure({
      ...layout, containerHeight: 300, rowIds: ["9", "10"], rowHeights: [60, 160]
    })).toBe(3);
    expect(measure({
      ...layout, containerHeight: 300, rowIds: ["8", "9", "10"], rowHeights: [260, 60, 160]
    })).toBe(2);
    expect(measure.getVisibleRange()).toEqual({ start: 1, end: 3 });
    expect(measure({
      ...layout, containerHeight: 300, rowIds: ["8", "9", "10"], rowHeights: [260, 60, 160]
    })).toBe(2);
    expect(measure.getVisibleRange()).toEqual({ start: 1, end: 3 });
    expect(measure({
      ...layout, containerHeight: 300, rowIds: ["9", "10"], rowHeights: [60, 160]
    })).toBe(2);
    expect(measure.getVisibleRange()).toEqual({ start: 0, end: 2 });
    // A delayed candidate can be replayed after the corrected snapshot.
    expect(measure({
      ...layout, containerHeight: 300, rowIds: ["8", "9", "10"], rowHeights: [260, 60, 160]
    })).toBe(2);
    expect(measure.getVisibleRange()).toEqual({ start: 1, end: 3 });
  });

  test("initial selection paints the anchor while an oversized history slice is corrected", () => {
    const measure = createViewportCapacityTracker();
    expect(measure({
      ...layout, containerHeight: 300, rowIds: ["8", "9", "10"], rowHeights: [60, 160, 160],
      anchorRowId: "10"
    })).toBe(1);
    expect(measure.getVisibleRange()).toEqual({ start: 2, end: 3 });
  });
});
