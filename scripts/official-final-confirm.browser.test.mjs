import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { isOfficialFinalConfirmReady } from "./official-final-confirm.mjs";

test("waits for the official handler binding before clicking final confirmation", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="qr_submit_id" class="btn92">确认</button>');
    await page.evaluate(() => {
      window.confirmClicks = 0;
      setTimeout(() => {
        const button = document.querySelector("#qr_submit_id");
        button.addEventListener("click", () => { window.confirmClicks += 1; });
        button.classList.replace("btn92", "btn92s");
      }, 250);
    });
    assert.equal(await page.evaluate(isOfficialFinalConfirmReady), false);
    await page.waitForFunction(isOfficialFinalConfirmReady, null, { timeout: 2000 });
    await page.locator("#qr_submit_id").click();
    assert.equal(await page.evaluate(() => window.confirmClicks), 1);
  } finally {
    await browser.close();
  }
});
