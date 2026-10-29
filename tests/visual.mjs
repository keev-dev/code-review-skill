import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, launchBrowser, waitForCode, watchExternalRequests } from "./browser.mjs";

const ARTIFACT = path.join(ROOT, "examples", "demo", "review.html");
const OUT = path.join(process.env.TEMP || process.env.TMP || ".", "opencode");

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const external = watchExternalRequests(page, "static review");
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

await page.goto(pathToFileURL(ARTIFACT).href, { waitUntil: "networkidle" });
await page.waitForSelector(".overview", { timeout: 15000 });
await page.waitForTimeout(500);

assert.equal(await page.locator(".file-row").count(), 10, "sidebar lists every changed file");
assert.equal(await page.locator(".metric").count(), 5, "overview metrics render");
assert.equal(await page.locator(".flow-node").count() >= 6, true, "authored flow renders");
assert.equal(await page.locator(".timeline-item").count() >= 2, true, "iteration timeline renders");
assert.equal(await page.locator(".verdict-badge").count(), 1, "verdict renders");
assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 1, "content security policy is present");
assert.equal(await page.evaluate(() => Boolean(window.PierreDiffs?.FileDiff)), true, "local code renderer loads");
const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
assert.equal(overflow.width <= overflow.viewport + 1, true, `page overflows: ${overflow.width} > ${overflow.viewport}`);
await page.screenshot({ path: path.join(OUT, "visual-overview.png"), fullPage: false });

await page.locator('.file-row[data-file="src/orders/orderService.ts"]').click();
await page.waitForSelector(".file-view", { timeout: 10000 });
await waitForCode(page);
assert.equal(await page.locator(".finding-row").count() >= 5, true, "review pane lists findings");
assert.equal(await page.locator(".agent-summary").count(), 1, "agent summary renders");
assert.equal(await page.locator(".block-row").count(), 4, "four review blocks render");
await page.locator('.block-row[data-block-id="B3"]').click();
await page.waitForTimeout(400);
const hitRows = await page.evaluate(() => {
  const host = document.querySelector("#code-mount diffs-container");
  return host.shadowRoot.querySelectorAll('[data-review-hit="true"]').length;
});
assert.equal(hitRows > 0, true, "block click highlights code");
await page.locator(".finding-row").first().hover();
await page.waitForTimeout(300);
const findingHits = await page.evaluate(() => {
  const host = document.querySelector("#code-mount diffs-container");
  return host.shadowRoot.querySelectorAll('[data-review-hit="true"]').length;
});
assert.equal(findingHits > 0, true, "finding hover highlights code");
await page.screenshot({ path: path.join(OUT, "visual-file.png"), fullPage: false });

await page.locator('[data-code-mode="file"]').click();
await page.waitForTimeout(700);
assert.equal(await page.locator("#code-mode-label").innerText(), "new file", "file mode label updates");
await page.locator('[data-code-mode="diff"]').click();
await page.waitForTimeout(500);

await page.locator("#annotate-btn").click();
assert.equal(await page.evaluate(() => document.documentElement.dataset.annotate), "on", "annotate mode turns on");
await page.locator(".finding-row").first().click();
await page.waitForSelector("#note-dialog[open]", { timeout: 5000 });
assert.equal(await page.locator("#note-anchor").innerText().then((text) => text.includes("orderService.ts")), true, "note dialog anchors to the finding");
await page.locator("[data-close-note]").first().click();
await page.locator("#annotate-btn").click();
assert.equal(await page.evaluate(() => document.documentElement.dataset.annotate), "off", "annotate mode turns off");

await page.locator("#notes-btn").click();
await page.waitForSelector("#notes-drawer:not([hidden])", { timeout: 5000 });
assert.equal(await page.locator(".notes-drawer").innerText().then((text) => text.includes("Preview only")), true, "static preview warns that the server is off");
await page.locator("#notes-close").click();

await page.locator("#theme-btn").click();
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light", "light theme toggles");
await page.screenshot({ path: path.join(OUT, "visual-light.png"), fullPage: false });

await page.locator('.file-row[data-file="db/migrations/004_add_order_status.sql"]').click();
await waitForCode(page);
assert.equal(await page.locator(".file-view").count(), 1, "SQL file renders with the local renderer");

external.assertEmpty();
assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
await browser.close();
console.log("visual checks passed");
console.log(`screenshots: ${OUT}\\visual-*.png`);
