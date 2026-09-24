import test from "node:test";
import assert from "node:assert/strict";
import { createOfficialClockSample, estimateOfficialNow, MAX_OFFICIAL_CLOCK_SAMPLE_AGE_MS } from "./official-clock.mjs";

test("official time advances between two-second login polls", () => {
  const epochMs = 1_790_000_000_000;
  const sample = createOfficialClockSample(epochMs, 100, 200);
  assert.equal(estimateOfficialNow(sample, 150), epochMs);
  assert.equal(estimateOfficialNow(sample, 2_150), epochMs + 2_000);
});

test("invalid or stale official samples cannot schedule a sale", () => {
  assert.equal(createOfficialClockSample(NaN, 100, 200), null);
  const sample = createOfficialClockSample(1_790_000_000_000, 100, 200);
  assert.equal(estimateOfficialNow(sample, 151 + MAX_OFFICIAL_CLOCK_SAMPLE_AGE_MS), null);
});
