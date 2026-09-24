const RETRY_PATTERN = /\((\d+)\)$/;
const CONNECTED_TOAST = "已连接！";
const CONNECTED_TOAST_DURATION_MS = 5_000;

export function getRetryDeadlineMs(status: string, nowMs: number) {
  const retrySeconds = getRetrySeconds(status);
  return retrySeconds === null ? null : nowMs + retrySeconds * 1000;
}

export function formatConnectionStatusWithCountdown(
  status: string,
  retryDeadlineMs: number | null,
  nowMs: number
) {
  if (retryDeadlineMs === null || !RETRY_PATTERN.test(status)) {
    return status;
  }

  const remainingSeconds = Math.max(
    0,
    Math.ceil((retryDeadlineMs - nowMs) / 1000)
  );
  return status.replace(RETRY_PATTERN, `(${remainingSeconds})`);
}

export function getConnectedToastDeadlineMs(status: string, nowMs: number) {
  return status === CONNECTED_TOAST ? nowMs + CONNECTED_TOAST_DURATION_MS : null;
}

export function formatTransientConnectionStatus(
  status: string,
  retryDeadlineMs: number | null,
  connectedToastDeadlineMs: number | null,
  nowMs: number
) {
  if (status === CONNECTED_TOAST && connectedToastDeadlineMs !== null) {
    return nowMs < connectedToastDeadlineMs ? status : "";
  }

  return formatConnectionStatusWithCountdown(status, retryDeadlineMs, nowMs);
}

function getRetrySeconds(status: string) {
  const match = status.match(RETRY_PATTERN);
  if (!match) {
    return null;
  }

  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) ? seconds : null;
}
