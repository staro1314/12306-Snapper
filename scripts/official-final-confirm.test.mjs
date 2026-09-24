import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isOfficialFinalConfirmReady, officialConfirmationMode } from "./official-final-confirm.mjs";

const originalDocument = globalThis.document;
afterEach(() => { globalThis.document = originalDocument; });

test("visible and enabled is not enough before official click handler is bound", () => {
  globalThis.document = { querySelector: () => ({
    getClientRects: () => [{}],
    classList: { contains: () => false },
    disabled: false,
  }) };
  assert.equal(isOfficialFinalConfirmReady(), false);
});

test("official active class permits the final confirmation click", () => {
  globalThis.document = { querySelector: () => ({
    getClientRects: () => [{}],
    classList: { contains: (name) => name === "btn92s" },
    disabled: false,
  }) };
  assert.equal(isOfficialFinalConfirmReady(), true);
});

test("hidden or disabled official buttons remain blocked", () => {
  const button = { getClientRects: () => [], classList: { contains: () => true }, disabled: false };
  globalThis.document = { querySelector: () => button };
  assert.equal(isOfficialFinalConfirmReady(), false);
  button.getClientRects = () => [{}];
  button.disabled = true;
  assert.equal(isOfficialFinalConfirmReady(), false);
});

test("official acceptance selects queue or direct handling without inventing a queue", () => {
  assert.equal(officialConfirmationMode({ status: true, data: { submitStatus: true, isAsync: "1" } }), "ASYNC_QUEUE");
  assert.equal(officialConfirmationMode({ status: true, data: { submitStatus: true, isAsync: "0" } }), "DIRECT");
  assert.equal(officialConfirmationMode({ status: true, data: { submitStatus: false, isAsync: "1" } }), "REJECTED");
  assert.equal(officialConfirmationMode(null), "REJECTED");
});
