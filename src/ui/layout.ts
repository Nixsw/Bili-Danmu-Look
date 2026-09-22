export const MAIN_READABLE_WIDTH = 420;
export const MAIN_MIN_WIDTH = 260;
export const PERSON_PANEL_DEFAULT_WIDTH = 180;
export const PERSON_PANEL_MIN_WIDTH = 120;

export interface SplitLayoutInput {
  totalWidth: number;
  personVisible: boolean;
  personRatio?: number | null;
}

export interface SplitLayout {
  personWidth: number;
  mainWidth: number;
}

export function isPersonPanelVisible() {
  return true;
}

export function getSplitLayout({
  totalWidth,
  personVisible,
  personRatio
}: SplitLayoutInput): SplitLayout {
  const width = Math.max(0, Math.round(totalWidth));

  if (!personVisible) {
    return {
      personWidth: 0,
      mainWidth: width
    };
  }

  const maxPersonWidth = Math.max(0, width - MAIN_MIN_WIDTH);
  const minPersonWidth = Math.min(PERSON_PANEL_MIN_WIDTH, maxPersonWidth);

  if (Number.isFinite(personRatio)) {
    const desiredPersonWidth = Math.round(
      width * clamp(Number(personRatio), 0, 1)
    );
    const personWidth = clamp(
      desiredPersonWidth,
      minPersonWidth,
      maxPersonWidth
    );
    return {
      personWidth,
      mainWidth: width - personWidth
    };
  }

  if (width >= MAIN_READABLE_WIDTH + PERSON_PANEL_DEFAULT_WIDTH) {
    return {
      personWidth: width - MAIN_READABLE_WIDTH,
      mainWidth: MAIN_READABLE_WIDTH
    };
  }

  if (width >= MAIN_READABLE_WIDTH + PERSON_PANEL_MIN_WIDTH) {
    return {
      personWidth: width - MAIN_READABLE_WIDTH,
      mainWidth: MAIN_READABLE_WIDTH
    };
  }

  return {
    personWidth: minPersonWidth,
    mainWidth: width - minPersonWidth
  };
}

function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}
