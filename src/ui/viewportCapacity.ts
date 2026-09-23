export interface ViewportCapacityInput {
  containerHeight: number;
  rowHeights: number[];
  gap: number;
  paddingTop: number;
  paddingBottom: number;
  min?: number;
  max?: number;
}

export function estimateViewportCapacity({
  containerHeight,
  rowHeights,
  gap,
  paddingTop,
  paddingBottom,
  min = 1,
  max = 100
}: ViewportCapacityInput) {
  if (containerHeight <= 0 || rowHeights.length === 0) {
    return min;
  }

  const averageRowHeight =
    rowHeights.reduce((total, value) => total + value, 0) / rowHeights.length;
  const usableHeight = Math.max(0, containerHeight - paddingTop - paddingBottom);
  let measuredHeight = 0;
  let measuredCapacity = 0;

  for (const rowHeight of rowHeights) {
    const nextHeight =
      measuredHeight + (measuredCapacity > 0 ? gap : 0) + rowHeight;
    if (nextHeight > usableHeight) {
      return Math.min(max, Math.max(min, measuredCapacity));
    }

    measuredHeight = nextHeight;
    measuredCapacity += 1;
  }

  const estimated = Math.floor((usableHeight + gap) / (averageRowHeight + gap));

  return Math.min(max, Math.max(min, estimated));
}

interface MeasuredViewportInput extends ViewportCapacityInput {
  containerWidth: number;
  fontSize: number;
  minRowHeight: number;
  rowIds: string[];
}

export function createViewportCapacityTracker() {
  let layoutKey = "";
  const overflowLimits = new Map<string, number>();
  let pendingGrowth: { firstId: string; rowIds: string[] } | undefined;
  const reset = () => {
    overflowLimits.clear();
    pendingGrowth = undefined;
  };

  const measure = (input: MeasuredViewportInput) => {
    const nextLayoutKey = [
      input.containerWidth, input.containerHeight, input.fontSize,
      input.gap, input.paddingTop, input.paddingBottom, input.minRowHeight,
      input.min, input.max
    ].join(":");
    if (nextLayoutKey !== layoutKey) {
      layoutKey = nextLayoutKey;
      reset();
    }

    let capacity = estimateViewportCapacity(input);
    const firstId = input.rowIds[0];
    if (firstId === undefined) return capacity;

    // Once a measured next row cannot fit, removing it must not make the
    // shorter remaining rows expand the same viewport again indefinitely.
    if (capacity < input.rowHeights.length) {
      overflowLimits.set(firstId, Math.min(
        capacity, overflowLimits.get(firstId) ?? capacity
      ));
      // At the cache tail, or while keeping a person anchor visible, growing
      // the viewport can prepend history instead of appending a newer row.
      // Remember that failed probe at its original start as well, otherwise
      // the two different starts keep requesting each other's slice sizes.
      if (pendingGrowth && pendingGrowth.firstId !== firstId &&
          pendingGrowth.rowIds.every((id) => input.rowIds.includes(id))) {
        overflowLimits.set(pendingGrowth.firstId, Math.min(
          pendingGrowth.rowIds.length,
          overflowLimits.get(pendingGrowth.firstId) ?? pendingGrowth.rowIds.length
        ));
      }
      if (overflowLimits.size > 128) {
        overflowLimits.delete(overflowLimits.keys().next().value!);
      }
    } else {
      // A tall current row does not imply that the next row is equally tall.
      // Probe one more row when a compact row could fit; a measured overflow
      // above provides the stable limit if that next row is too tall.
      const usedHeight = input.rowHeights.reduce((total, height) => total + height, 0)
        + Math.max(0, input.rowHeights.length - 1) * input.gap
        + input.paddingTop + input.paddingBottom;
      if (input.containerHeight - usedHeight >= input.gap + input.minRowHeight) {
        capacity = Math.min(input.max ?? 100, Math.max(capacity, input.rowHeights.length + 1));
      }
    }

    const result = Math.min(capacity, overflowLimits.get(firstId) ?? capacity);
    pendingGrowth = result > input.rowIds.length
      ? { firstId, rowIds: [...input.rowIds] }
      : undefined;
    return result;
  };

  return Object.assign(measure, { reset });
}
