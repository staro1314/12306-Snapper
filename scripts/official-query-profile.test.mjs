import test from "node:test";
import assert from "node:assert/strict";
import { captureOfficialQueryProfile, reusableOfficialQueryUrl } from "./official-query-profile.mjs";

const input = { fromStation: "北京", toStation: "上海", travelDate: "2026-10-01" };
const stations = { fromCode: "BJP", toCode: "SHH" };
const observedUrl = "https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-10-01&leftTicketDTO.from_station=BJP&leftTicketDTO.to_station=SHH";
const request = (url = observedUrl, method = "GET") => ({ url: () => url, method: () => method });

test("reuses only an observed same-route same-date official GET within its lease", () => {
  const profile = captureOfficialQueryProfile(request(), input, stations, 1000);
  assert.equal(reusableOfficialQueryUrl(profile, input, 2000), observedUrl);
  assert.equal(reusableOfficialQueryUrl(profile, { ...input, travelDate: "2026-10-02" }, 2000), null);
  assert.equal(reusableOfficialQueryUrl(profile, { ...input, toStation: "南京" }, 2000), null);
  assert.equal(reusableOfficialQueryUrl(profile, input, 1000 + 12 * 60_000 + 1), null);
});

test("rejects non-official, non-GET, and mismatched station or date requests", () => {
  assert.equal(captureOfficialQueryProfile(request(observedUrl, "POST"), input, stations), null);
  assert.equal(captureOfficialQueryProfile(request(observedUrl.replace("kyfw.12306.cn", "example.org")), input, stations), null);
  assert.equal(captureOfficialQueryProfile(request(observedUrl.replace("SHH", "NJN")), input, stations), null);
  assert.equal(captureOfficialQueryProfile(request(observedUrl.replace("2026-10-01", "2026-10-02")), input, stations), null);
});
