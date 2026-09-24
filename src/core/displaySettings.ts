export const MESSAGE_SIZE_PRESETS = [
  { value: 10, label: "较小" },
  { value: 12, label: "推荐" },
  { value: 14, label: "中等" },
  { value: 16, label: "较大" },
  { value: 18, label: "特大" }
] as const;

export const MIN_BACKGROUND_OPACITY = 0.1;
export const MAX_BACKGROUND_OPACITY = 1;

export function normalizeFontSize(value: number): number {
  if (!Number.isFinite(value)) return 14;
  return Math.round(Math.min(18, Math.max(10, value)) / 2) * 2;
}

export function normalizeOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0.82;
  return Math.min(MAX_BACKGROUND_OPACITY, Math.max(MIN_BACKGROUND_OPACITY, value));
}
