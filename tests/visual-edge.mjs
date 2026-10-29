import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, launchBrowser, waitForCode, watchExternalRequests } from "./browser.mjs";

const ARTIFACT = path.join(ROOT, "examples", "demo", "review.html");
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
const external = watchExternalRequests(page, "edge visual review");
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

for (const [file, expected] of [
  ["src/utils/money.ts", "deleted"],
  ["src/utils/formatMoney.ts", "added"],
  ["assets/logo.png", "binary"],
  ["src/legacy/legacyPricing.ts", "deleted"],
]) {
  await page.goto(`${pathToFileURL(ARTIFACT).href}#file=${encodeURIComponent(file)}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  if (expected === "binary") {
    assert.equal(await page.locator(".code-state").count(), 1, `${file} shows a code state`);
    assert.equal(await page.locator(".code-state").innerText().then((text) => text.includes("Binary file")), true, `${file} is marked binary`);
    assert.equal(await page.locator(".finding-row").count(), 0, `${file} has no line findings`);
  } else {
    await waitForCode(page);
    assert.equal(await page.locator(".block-row").count() > 0, true, `${file} has a review block`);
  }
  console.log(`${file}: ${expected} ok`);
}

await page.goto(`${pathToFileURL(ARTIFACT).href}#file=src%2Futils%2Fmoney.ts`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(process.env.TEMP, "opencode", "visual-deleted.png") });

await page.goto(`${pathToFileURL(ARTIFACT).href}#file=src%2Forders%2ForderService.ts`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.locator("#theme-btn").click();
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(process.env.TEMP, "opencode", "visual-light-file.png") });

external.assertEmpty();
assert.deepEqual(errors, [], errors.join("\n"));
await browser.close();
console.log("edge visual checks passed");
