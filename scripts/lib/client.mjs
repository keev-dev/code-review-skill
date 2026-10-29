import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

export function apiJson(baseUrl, route, { method = "GET", token, body, longPoll = false, timeoutMs = 8000 } = {}) {
  const url = new URL(route, baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
  const headers = {};
  if (token) headers["X-Review-Token"] = token;
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = payload.length;
  }

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: longPoll ? 0 : timeoutMs,
    }, (res) => {
      let chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          req.destroy(new Error("Response too large."));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (res.statusCode && res.statusCode >= 400) {
          const error = new Error(data?.error || `Request failed with status ${res.statusCode}.`);
          error.status = res.statusCode;
          error.data = data;
          return reject(error);
        }
        resolve(data);
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("The review server did not respond."));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function serverHealth(baseUrl) {
  try {
    return await apiJson(baseUrl, "/api/health", { timeoutMs: 1500 });
  } catch {
    return null;
  }
}

export function openBrowser(url) {
  const command = process.platform === "win32"
    ? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `start "" "${url.replace(/"/g, '\\"')}"`] }
    : process.platform === "darwin"
      ? { file: "open", args: [url] }
      : { file: "xdg-open", args: [url] };
  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
