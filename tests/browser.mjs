import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function executablePath() {
  return CHROME_CANDIDATES.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

export async function launchBrowser() {
  const executable = executablePath();
  if (!executable) {
    throw new Error("Chrome was not found. Set CHROME_PATH to a local Chrome or Edge executable.");
  }
  return chromium.launch({ executablePath: executable, headless: true });
}

export function isLocalRequest(url) {
  try {
    const parsed = new URL(url);
    if (["file:", "data:", "blob:"].includes(parsed.protocol)) return true;
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

export function watchExternalRequests(page, label) {
  const external = [];
  page.on("request", (request) => {
    if (!isLocalRequest(request.url())) external.push(request.url());
  });
  return {
    external,
    assertEmpty() {
      if (external.length) {
        throw new Error(`${label} made external requests: ${external.join(", ")}`);
      }
    },
  };
}

export async function waitForCode(page) {
  await page.waitForFunction(() => Boolean(
    document.querySelector("#code-mount diffs-container")?.shadowRoot?.querySelector("[data-line]"),
  ), { timeout: 20000 });
}
