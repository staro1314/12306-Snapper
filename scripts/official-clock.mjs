// 12306 supplies a wall-clock sample, not a continuously advancing clock. Anchor it to the
// sidecar's monotonic clock; otherwise a two-second login poll quantizes sale-time dispatch.
export const MAX_OFFICIAL_CLOCK_SAMPLE_AGE_MS = 10_000;

export function createOfficialClockSample(epochMs, requestStartedAtMs, responseReceivedAtMs) {
  if (!Number.isFinite(epochMs) || epochMs < 1_000_000_000_000) return null;
  return {
    epochMs,
    // The official timestamp is created during this request. Midpoint anchoring bounds the
    // one-way network delay instead of anchoring it at the next local polling tick.
    monotonicAnchorMs: (requestStartedAtMs + responseReceivedAtMs) / 2,
  };
}

export function estimateOfficialNow(sample, monotonicNowMs) {
  if (!sample) return null;
  const ageMs = monotonicNowMs - sample.monotonicAnchorMs;
  if (ageMs < 0 || ageMs > MAX_OFFICIAL_CLOCK_SAMPLE_AGE_MS) return null;
  return Math.round(sample.epochMs + ageMs);
}
