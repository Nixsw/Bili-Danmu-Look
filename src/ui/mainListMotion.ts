import type { AppSnapshot } from "../core/types";

export const MAIN_ADVANCE_DURATION_MS = 140;
export const MAIN_LOCATE_DURATION_MS = 180;

interface PendingMotion {
  targetId: number;
  oldFirstId: string;
  oldFirstTop: number;
  targetTop: number | undefined;
  oldShift: number;
  outgoing: HTMLElement;
  duration: number;
}

/** Two compositor translations; no per-frame React updates or backend calls. */
export function createMainListMotion(getList: () => HTMLElement | null) {
  let revision = -1;
  let targetId: number | undefined;
  let pending: PendingMotion | undefined;
  let active: { animations: Animation[]; outgoing: HTMLElement; list: HTMLElement } | undefined;

  function cancel() {
    pending = undefined;
    if (!active) return;
    const previous = active;
    active = undefined;
    previous.animations.forEach((animation) => animation.cancel());
    previous.outgoing.remove();
    previous.list.style.willChange = "";
  }

  return {
    cancel,

    // Capture before React replaces the visible slice, including an interrupted
    // animation's current position. Older polling responses cannot rewind it.
    prepare(snapshot: AppSnapshot) {
      if (snapshot.mainViewportRevision < revision) return false;
      const nextId = snapshot.mainVisible[0]?.messageId;
      if (snapshot.mainViewportRevision === revision) {
        if (targetId !== nextId) cancel();
        targetId = nextId;
        return true;
      }
      revision = snapshot.mainViewportRevision;
      targetId = nextId;
      const list = getList();
      const rows = list ? Array.from(list.children).filter((row) =>
        !row.hasAttribute("data-viewport-hidden")) as HTMLElement[] : [];
      const oldFirst = rows[0];
      if (!list || !oldFirst || nextId === undefined ||
          oldFirst.dataset.messageId === String(nextId) ||
          !snapshot.mainViewportMotion || document.hidden ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
          typeof list.animate !== "function") {
        cancel();
        return true;
      }

      const viewportTop = list.parentElement!.getBoundingClientRect().top;
      const oldShift = list.getBoundingClientRect().top - viewportTop;
      const target = rows.find((row) => row.dataset.messageId === String(nextId));
      const outgoing = list.cloneNode(true) as HTMLElement;
      outgoing.classList.add("main-scroll-outgoing");
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.setAttribute("inert", "");
      const nextIds = new Set(snapshot.mainVisible.map((message) => String(message.messageId)));
      for (const row of Array.from(outgoing.children) as HTMLElement[]) {
        // Shared rows are rendered only by the live list; retain their space.
        if (nextIds.has(row.dataset.messageId ?? "")) row.style.visibility = "hidden";
        if (snapshot.mainViewportMotion === "advance" && Number(row.dataset.messageId) < nextId) {
          row.classList.add("is-read");
        }
      }
      const captured: PendingMotion = {
        targetId: nextId,
        oldFirstId: oldFirst.dataset.messageId!,
        oldFirstTop: oldFirst.getBoundingClientRect().top - viewportTop,
        targetTop: target ? target.getBoundingClientRect().top - viewportTop : undefined,
        oldShift,
        outgoing,
        duration: snapshot.mainViewportMotion === "advance"
          ? MAIN_ADVANCE_DURATION_MS : MAIN_LOCATE_DURATION_MS
      };
      cancel();
      pending = captured;
      return true;
    },

    // Called in a layout effect, before the browser paints the new slice.
    play() {
      const captured = pending;
      if (!captured) return;
      pending = undefined;
      const list = getList();
      if (!list || list.querySelector(":scope > :not([data-viewport-hidden])")?.getAttribute("data-message-id") !== String(captured.targetId)) return;
      const viewport = list.parentElement!;
      const height = viewport.clientHeight;
      if (!height || document.hidden) return;
      let offset = captured.targetTop;
      if (offset === undefined) {
        const shared = Array.from(list.children).find((row) =>
          !row.hasAttribute("data-viewport-hidden") &&
          row.getAttribute("data-message-id") === captured.oldFirstId);
        offset = shared
          ? captured.oldFirstTop - (shared.getBoundingClientRect().top - viewport.getBoundingClientRect().top)
          : (captured.targetId > Number(captured.oldFirstId) ? height : -height);
      }
      // Distant targets use a single-screen transition, independent of cache size.
      offset = Math.max(-height, Math.min(height, offset));
      if (Math.abs(offset) < 0.5) return;
      viewport.appendChild(captured.outgoing);
      list.style.willChange = "transform";
      const timing: KeyframeAnimationOptions = {
        duration: captured.duration,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
        fill: "both"
      };
      const animations = [
        list.animate([
          { transform: `translateY(${offset}px)` },
          { transform: "translateY(0)" }
        ], timing),
        captured.outgoing.animate([
          { transform: `translateY(${captured.oldShift}px)` },
          { transform: `translateY(${captured.oldShift - offset}px)` }
        ], timing)
      ];
      const running = { animations, outgoing: captured.outgoing, list };
      active = running;
      Promise.all(animations.map((animation) => animation.finished))
        .then(() => { if (active === running) cancel(); })
        .catch(() => { /* Cancellation is expected when the user takes over. */ });
    }
  };
}
