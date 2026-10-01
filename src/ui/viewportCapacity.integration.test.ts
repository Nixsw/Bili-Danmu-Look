import { describe, expect, test } from "vitest";
import { createMessageStore } from "../core/messageStore";
import { createViewportCapacityTracker } from "./viewportCapacity";

const defaultLayout = {
  containerWidth: 158,
  containerHeight: 400,
  fontSize: 14,
  minRowHeight: 54,
  gap: 7,
  paddingTop: 0,
  paddingBottom: 0
};

function createViewportHarness({
  panel = "main",
  initialCapacity = 6,
  layout: layoutPatch = {}
}: {
  panel?: "main" | "person";
  initialCapacity?: number;
  layout?: Partial<typeof defaultLayout>;
} = {}) {
  const store = createMessageStore({
    mainViewportSize: initialCapacity,
    personViewportSize: initialCapacity
  });
  const measure = createViewportCapacityTracker();
  const heights = new Map<number, number>();
  const layout = { ...defaultLayout, ...layoutPatch };
  let lastSubmitted: number | undefined;

  const add = (height: number) => {
    const message = store.ingest({
      content: "测试弹幕", uid: "100000001", nickname: "观众",
      userLevel: 0, fanLevel: 0, guardType: 0, timestampMs: 1
    });
    heights.set(message.messageId, height);
    return message.messageId;
  };
  const candidate = () => {
    const snapshot = store.getSnapshot();
    const rows = panel === "main"
      ? snapshot.mainVisible
      : snapshot.personPanel.visibleMessages;
    return {
      rowIds: rows.map((row) => String(row.messageId)),
      rowHeights: rows.map((row) => heights.get(row.messageId)!),
      anchorRowId: panel === "person"
        ? String(snapshot.personPanel.anchorMessageId)
        : undefined
    };
  };
  const step = (rows = candidate()) => {
    const capacity = measure({ ...layout, ...rows });
    const range = measure.getVisibleRange();
    const result = {
      capacity,
      painted: rows.rowIds.slice(range.start, range.end),
      submitted: capacity !== lastSubmitted
    };
    if (result.submitted) {
      lastSubmitted = capacity;
      store.setViewportSizes(panel === "main"
        ? { mainViewportSize: capacity }
        : { personViewportSize: capacity });
    }
    return result;
  };
  const settle = () => {
    const trace = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const result = step();
      trace.push(result);
      if (!result.submitted) break;
    }
    return trace;
  };

  return { store, measure, layout, add, candidate, step, settle };
}

describe("viewport capacity feedback with the message store", () => {
  test.each([
    {
      containerHeight: 400, shortHeight: 60, tallHeight: 90,
      initialCount: 7, initialCapacity: 6, trailingCount: 6,
      painted: ["9", "10", "11", "12", "13", "14"]
    },
    {
      containerHeight: 548, shortHeight: 59.890625, tallHeight: 97.671875,
      initialCount: 30, initialCapacity: 8, trailingCount: 8,
      painted: ["32", "33", "34", "35", "36", "37", "38", "39"]
    }
  ])("stays settled after a tall row leaves the bottom-pinned slice: $containerHeight px", (fixture) => {
    const viewport = createViewportHarness({
      initialCapacity: fixture.initialCapacity,
      layout: { containerHeight: fixture.containerHeight }
    });
    for (let index = 0; index < fixture.initialCount; index += 1) viewport.add(fixture.shortHeight);
    viewport.store.scrollMainViewport(1000);
    viewport.measure.reset();
    expect(viewport.settle().at(-1)?.submitted).toBe(false);

    viewport.add(fixture.tallHeight);
    expect(viewport.settle().at(-1)?.submitted).toBe(false);
    for (let index = 0; index < fixture.trailingCount; index += 1) {
      viewport.add(fixture.shortHeight);
      expect(viewport.settle().at(-1)?.submitted).toBe(false);
    }

    // Stop arrivals: repeated measurements must keep the same first row and
    // capacity instead of requesting alternating backend slices forever.
    for (let pass = 0; pass < 12; pass += 1) {
      expect(viewport.step()).toEqual({
        capacity: fixture.initialCapacity, painted: fixture.painted, submitted: false
      });
    }
  });

  test("does not resume probing a static overflowing next row when the shorter slice fits", () => {
    const viewport = createViewportHarness({ layout: { containerHeight: 462 } });
    for (const height of [60, 400, 60, 60, 60, 60, 60]) viewport.add(height);
    viewport.settle();

    for (let pass = 0; pass < 12; pass += 1) {
      expect(viewport.step()).toEqual({ capacity: 1, painted: ["1"], submitted: false });
    }
  });

  test("keeps a selected anchor painted through failed history probes and delayed candidates", () => {
    const viewport = createViewportHarness({
      panel: "person", initialCapacity: 2, layout: { containerHeight: 300 }
    });
    for (const height of [260, 60, 160]) viewport.add(height);
    viewport.store.selectUserAnchor(3);
    expect(viewport.step()).toEqual({ capacity: 3, painted: ["2", "3"], submitted: true });
    const failedProbe = viewport.candidate();
    expect(failedProbe.rowIds).toEqual(["1", "2", "3"]);
    expect(viewport.step(failedProbe)).toEqual({ capacity: 2, painted: ["2", "3"], submitted: true });
    expect(viewport.step(failedProbe)).toEqual({ capacity: 2, painted: ["2", "3"], submitted: false });
    expect(viewport.step()).toEqual({ capacity: 2, painted: ["2", "3"], submitted: false });
    expect(viewport.step(failedProbe)).toEqual({ capacity: 2, painted: ["2", "3"], submitted: false });
    for (let pass = 0; pass < 12; pass += 1) {
      expect(viewport.step()).toEqual({ capacity: 2, painted: ["2", "3"], submitted: false });
    }
  });

  test("reconsiders a failed history probe after the container grows", () => {
    const viewport = createViewportHarness({
      initialCapacity: 5, layout: { containerHeight: 462 }
    });
    for (const height of [60, 70, 70, 70, 119, 119]) viewport.add(height);
    viewport.store.scrollMainViewport(1000);
    viewport.settle();
    expect(viewport.step()).toEqual({ capacity: 4, painted: ["3", "4", "5", "6"], submitted: false });

    viewport.layout.containerHeight = 600;
    expect(viewport.settle().at(-1)?.submitted).toBe(false);
    expect(viewport.step().painted).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
});
