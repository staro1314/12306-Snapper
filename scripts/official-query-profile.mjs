// Runtime prewarm may run at T-10 minutes; retain the exact observed request
// just long enough for T0 while still requiring an active login state.
const PROFILE_TTL_MS = 12 * 60_000;

// Store only an exact, observed official request for the same route and date.
// Never synthesize parameter names or reuse a profile for another search.
export function captureOfficialQueryProfile(request, input, stationCodes, now = Date.now()) {
  if (!request || request.method() !== "GET") return null;
  let url;
  try { url = new URL(request.url()); } catch { return null; }
  if (url.origin !== "https://kyfw.12306.cn" || !/^\/otn\/leftTicket\/query/.test(url.pathname)) return null;
  const values = [...url.searchParams.values()];
  if (![input.travelDate, stationCodes.fromCode, stationCodes.toCode].every((value) => values.includes(value))) return null;
  return { url: url.href, fromStation: input.fromStation, toStation: input.toStation, travelDate: input.travelDate, observedAt: now };
}

export function reusableOfficialQueryUrl(profile, input, now = Date.now()) {
  if (!profile || now - profile.observedAt < 0 || now - profile.observedAt > PROFILE_TTL_MS) return null;
  if (profile.fromStation !== input.fromStation || profile.toStation !== input.toStation || profile.travelDate !== input.travelDate) return null;
  return profile.url;
}
