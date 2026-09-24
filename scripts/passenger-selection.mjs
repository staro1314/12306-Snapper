// Current 12306 confirmation markup renders passengers asynchronously as list items inside
// #normal_passenger_id. The page header can also contain the account holder's name, so only
// the official passenger list is eligible for matching. No identity details enter errors.
export const PASSENGER_RENDER_TIMEOUT_MS = 4_000;

export class PassengerSelectionError extends Error {
  constructor(classification, message) {
    super(message);
    this.name = "PassengerSelectionError";
    this.classification = classification;
  }
}

export async function ensurePassengerSelected(targetPage, passenger) {
  const passengerName = String(passenger?.passenger_name ?? "").trim();
  if (!passengerName) {
    throw new PassengerSelectionError("PASSENGER_REFERENCE_INVALID", "乘车人资料缺少姓名，请重新同步");
  }

  const item = targetPage.locator("#normal_passenger_id li").filter({ hasText: passengerName }).first();
  try {
    await item.waitFor({ state: "visible", timeout: PASSENGER_RENDER_TIMEOUT_MS });
  } catch {
    throw new PassengerSelectionError("PASSENGER_NOT_RENDERED", "官方确认页未在限定时间内展示所选乘车人，已停止提交");
  }

  const checkbox = item.locator('input[type="checkbox"]');
  try {
    await checkbox.waitFor({ state: "attached", timeout: PASSENGER_RENDER_TIMEOUT_MS });
  } catch {
    throw new PassengerSelectionError("PASSENGER_CONTROL_INCOMPATIBLE", "官方确认页乘车人选择控件未就绪，已停止提交");
  }

  try {
    if (!(await checkbox.isChecked())) await checkbox.click({ force: true, timeout: PASSENGER_RENDER_TIMEOUT_MS });
    if (!(await checkbox.isChecked())) throw new Error("checkbox remained unchecked");
  } catch {
    throw new PassengerSelectionError("PASSENGER_SELECTION_FAILED", "官方确认页未能选中乘车人，已停止提交");
  }
}
