type ScrollMetrics = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

export function canScrollMessageContent(row: ScrollMetrics, deltaY: number) {
  const remaining = row.scrollHeight - row.clientHeight;
  if (remaining <= 1) return false;
  return deltaY > 0
    ? row.scrollTop < remaining - 1
    : deltaY < 0 && row.scrollTop > 1;
}

export function scrollMessageContent(event: WheelEvent) {
  const row = event.target instanceof Element
    ? event.target.closest<HTMLElement>(".person-row, .message-card")
    : null;
  if (!row || !canScrollMessageContent(row, event.deltaY)) return;

  // Capture before the browser scrolls. A passive, bubbling handler can see
  // the updated scrollTop and mistakenly navigate past the final screenful.
  event.preventDefault();
  event.stopPropagation();
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? row.clientHeight : 1;
  row.scrollTop += event.deltaY * scale;
}
