import { createViewportCapacityTracker } from "./viewportCapacity";

export function measureViewportLayout(
  list: HTMLElement,
  measure: ReturnType<typeof createViewportCapacityTracker>,
  fontSize: number,
  max: number,
  anchorRowId?: string
) {
  const rows = Array.from(list.children) as HTMLElement[];
  // Restore candidates only during synchronous layout. Overflow probes must
  // remain measurable without being painted, focused, clicked or animated.
  for (const row of rows) row.removeAttribute("data-viewport-hidden");
  if (!rows.length) return { capacity: null, hiddenNewerCount: 0 };

  const number = (value: string) => Number.parseFloat(value) || 0;
  const style = window.getComputedStyle(list);
  const capacity = measure({
    containerWidth: list.clientWidth,
    containerHeight: list.clientHeight,
    fontSize,
    minRowHeight: number(window.getComputedStyle(rows[0]).minHeight),
    rowIds: rows.map((row) => row.dataset.messageId!),
    anchorRowId,
    rowHeights: rows.map((row) => row.getBoundingClientRect().height),
    gap: number(style.rowGap),
    paddingTop: number(style.paddingTop),
    paddingBottom: number(style.paddingBottom),
    max
  });
  const { start, end } = measure.getVisibleRange();
  rows.forEach((row, index) => {
    row.toggleAttribute("data-viewport-hidden", index < start || index >= end);
  });
  return { capacity, hiddenNewerCount: rows.length - end };
}
