import test from "node:test";
import assert from "node:assert/strict";
import { ensurePassengerSelected, PASSENGER_RENDER_TIMEOUT_MS } from "./passenger-selection.mjs";

function confirmationPage({ itemReady = true, controlReady = true, checked = false } = {}) {
  const actions = [];
  const checkbox = {
    async waitFor(options) {
      actions.push(["control-wait", options]);
      if (!controlReady) throw new Error("control unavailable");
    },
    async isChecked() { return checked; },
    async click() { actions.push(["click"]); checked = true; },
  };
  const item = {
    first() { return this; },
    async waitFor(options) {
      actions.push(["item-wait", options]);
      if (!itemReady) throw new Error("passenger list unavailable");
    },
    locator(selector) {
      if (selector === 'input[type="checkbox"]') return checkbox;
      throw new Error(`unexpected item selector ${selector}`);
    },
  };
  const page = {
    locator(selector) {
      if (selector === "#normal_passenger_id li") return { filter: () => item };
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  return { page, actions };
}

test("waits for the passenger list before selecting the matching control", async () => {
  const { page, actions } = confirmationPage();
  await ensurePassengerSelected(page, { passenger_name: "测试乘车人" });
  assert.deepEqual(actions.map(([action]) => action), ["item-wait", "control-wait", "click"]);
  assert.equal(actions[0][1].timeout, PASSENGER_RENDER_TIMEOUT_MS);
});

test("an already selected passenger is not clicked again", async () => {
  const { page, actions } = confirmationPage({ checked: true });
  await ensurePassengerSelected(page, { passenger_name: "测试乘车人" });
  assert.equal(actions.some(([action]) => action === "click"), false);
});

test("missing passenger and incompatible controls remain distinct safe failures", async () => {
  await assert.rejects(
    ensurePassengerSelected(confirmationPage({ itemReady: false }).page, { passenger_name: "测试乘车人" }),
    { classification: "PASSENGER_NOT_RENDERED" },
  );
  await assert.rejects(
    ensurePassengerSelected(confirmationPage({ controlReady: false }).page, { passenger_name: "测试乘车人" }),
    { classification: "PASSENGER_CONTROL_INCOMPATIBLE" },
  );
});
