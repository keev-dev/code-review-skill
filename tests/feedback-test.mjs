import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readSession } from "../scripts/lib/feedback.mjs";
import { ROOT, launchBrowser, waitForCode, watchExternalRequests } from "./browser.mjs";

const REVIEW = path.join(ROOT, "scripts", "review.mjs");
const DEMO = path.join(ROOT, "tests", "demo.mjs");
const DEMO_ROOT = path.join(process.env.TEMP || process.env.TMP || ".", "opencode", "code-review-demo-live");

function run(args, options = {}) {
  return execFileSync(process.execPath, [REVIEW, ...args, "--root", DEMO_ROOT], {
    cwd: DEMO_ROOT,
    encoding: "utf8",
    timeout: options.timeout || 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

execFileSync(process.execPath, [DEMO], { cwd: ROOT, stdio: "inherit" });
try { run(["stop"]); } catch {}
run(["open", "--no-render", "--no-browser"]);
const session = readSession(DEMO_ROOT);
assert.equal(Boolean(session?.server?.url), true, "server session has a URL");
console.log("server:", session.server.url);

const baseUrl = session.server.baseUrl;
const unauthorized = await fetch(new URL("/api/state", baseUrl));
assert.equal(unauthorized.status, 401, "API requires a token");
const pageWithoutToken = await fetch(new URL("/", baseUrl));
assert.equal(pageWithoutToken.status, 401, "review page requires a token");
const vendorResponse = await fetch(new URL("/vendor/pierre-diffs.js", baseUrl));
assert.equal(vendorResponse.status, 200, "local code renderer is served");
assert.equal(vendorResponse.headers.get("content-type")?.includes("javascript"), true, "local code renderer has a JavaScript type");

const forbiddenHost = await new Promise((resolve, reject) => {
  const request = http.request({
    hostname: "127.0.0.1",
    port: Number(new URL(baseUrl).port),
    path: "/api/health",
    headers: { Host: "evil.example" },
  }, (response) => {
    response.resume();
    resolve(response.statusCode);
  });
  request.on("error", reject);
  request.end();
});
assert.equal(forbiddenHost, 403, "unexpected Host headers are rejected");

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors = [];
const external = watchExternalRequests(page, "live review");
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

await page.goto(session.server.url, { waitUntil: "networkidle" });
await page.waitForSelector(".overview", { timeout: 15000 });
assert.equal(await page.locator(".file-row").count(), 10, "sidebar lists files");

const [archive] = await Promise.all([
  page.context().waitForEvent("page", { timeout: 10000 }),
  page.locator("[data-open-artifact]").first().click(),
]);
await archive.waitForLoadState("domcontentloaded");
assert.equal(await archive.locator(".overview").count(), 1, "archived iteration opens with the token");
await archive.close();

await page.locator('.file-row[data-file="src/orders/orderService.ts"]').click();
await page.waitForSelector(".file-view", { timeout: 10000 });
await waitForCode(page);
assert.equal(await page.locator(".finding-row").count() >= 5, true, "review pane lists findings");

await page.locator("#annotate-btn").click();
assert.equal(await page.evaluate(() => document.documentElement.dataset.annotate), "on", "annotate mode is on");
await page.locator(".finding-row").first().click();
await page.waitForSelector("#note-dialog[open]", { timeout: 5000 });
await page.locator("#note-text").fill("This still needs one transaction. The order save must commit with the payment.");
await page.locator("#note-save").click();
await page.waitForTimeout(200);

await page.locator("#notes-btn").click();
await page.waitForSelector("#notes-drawer:not([hidden])", { timeout: 5000 });
assert.equal(await page.locator(".note-card").count() >= 1, true, "queued note appears");
await page.locator("#notes-send").click();
await page.waitForTimeout(700);
assert.equal(await page.locator(".notes-drawer").innerText().then((text) => text.includes("This still needs one transaction")), true, "sent note remains visible");

const waitOut = run(["wait"], { timeout: 20000 });
assert.equal(waitOut.includes("This still needs one transaction"), true, "wait returns the browser note");
console.log("wait returned the note");

const replyOut = run(["reply", "--message", "The order and payment now use one transaction. The failure is rethrown."], { timeout: 10000 });
assert.equal(replyOut.includes("Reply posted"), true, "reply is posted");
await page.waitForTimeout(2600);
const drawerText = await page.locator(".notes-drawer").innerText();
assert.equal(drawerText.includes("The order and payment now use one transaction"), true, "agent reply appears in the drawer");
const sessionAfterReply = readSession(DEMO_ROOT);
assert.equal(sessionAfterReply.notes.some((note) => note.status === "done"), true, "delivered notes are marked done");
const closed = page.locator(".notes-drawer details summary").first();
if (await closed.count()) {
  await closed.click();
  await page.waitForTimeout(150);
  assert.equal((await page.locator(".notes-drawer").innerText()).toLowerCase().includes("done"), true, "closed note shows done");
}
external.assertEmpty();
assert.deepEqual(errors, [], errors.join("\n"));
await page.screenshot({ path: path.join(process.env.TEMP, "opencode", "feedback-drawer.png") });
console.log("feedback round-trip passed");

await browser.close();
run(["stop"]);
