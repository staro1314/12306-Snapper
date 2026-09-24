// The current official confirmation page shows an enabled button before its
// countdown binds qr_submitClickEvent. btn92s is applied only after that bind.
// Keep this predicate executable in the page context and test it independently.
export function isOfficialFinalConfirmReady() {
  const button = document.querySelector("#qr_submit_id");
  return Boolean(button && button.getClientRects().length > 0 && button.classList.contains("btn92s") && !button.disabled);
}

export function officialConfirmationMode(body) {
  if (body?.status !== true || body?.data?.submitStatus !== true) return "REJECTED";
  return String(body.data.isAsync) === "1" ? "ASYNC_QUEUE" : "DIRECT";
}
