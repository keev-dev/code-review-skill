import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import {
  appendNotes,
  appendReply,
  defaultSession,
  markClosed,
  markNotesSeen,
  pendingNotes,
  publicState,
  readCurrent,
  readSession,
  writeSession,
} from "./feedback.mjs";
import { ensureDir, isoNow, pathExists } from "./util.mjs";

const MAX_BODY = 2 * 1024 * 1024;
const HTML_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req, url, token) {
  if (req.headers["x-review-token"] === token) return true;
  return url.searchParams.get("token") === token;
}

function hostAllowed(req) {
  const raw = String(req.headers.host || "").toLowerCase();
  if (!raw) return false;
  const name = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function currentInfo(root, fallback) {
  const current = readCurrent(root);
  if (current && current.runId) return current;
  return fallback || null;
}

function serveFile(res, file) {
  if (!pathExists(file)) return sendText(res, 404, "Not found.");
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Content-Security-Policy": HTML_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(body);
}

function serveVendor(res, file) {
  if (!pathExists(file)) return sendText(res, 404, "Not found.");
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(body);
}

export function startReviewServer({
  root,
  runId,
  iteration,
  port = 0,
  token = crypto.randomBytes(24).toString("hex"),
  host = "127.0.0.1",
}) {
  const stateDir = path.join(root, ".code-review");
  const reviewFile = path.join(stateDir, "review.html");
  if (!pathExists(reviewFile)) {
    throw new Error(`Review artifact not found: ${reviewFile}. Run render first.`);
  }
  ensureDir(stateDir);

  let session = readSession(root) || defaultSession();
  session.closed = false;
  session.closedAt = null;
  session.currentRunId = runId || null;
  session.currentIteration = iteration || null;
  session.agent.waiting = false;

  const waiters = new Set();
  let closing = false;
  let server;

  const writeLog = (message) => {
    try {
      fs.appendFileSync(
        path.join(stateDir, "server.log"),
        `[${isoNow()}] ${message}\n`,
        "utf8",
      );
    } catch {
      // Logging must never break the server.
    }
  };

  const finishWaiter = (res, value) => {
    if (res.writableEnded) return;
    sendJson(res, 200, value);
  };

  const drainWaiters = () => {
    session = readSession(root) || session;
    const current = currentInfo(root, { runId, iteration });
    if (session.closed) {
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        finishWaiter(waiter.res, { closed: true, current });
      }
      return;
    }
    const pending = pendingNotes(session);
    if (pending.length === 0 || waiters.size === 0) return;
    const at = isoNow();
    markNotesSeen(session, pending, at);
    writeSession(root, session);
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      finishWaiter(waiter.res, {
        current,
        notes: pending,
        agent: session.agent,
        iteration: current?.iteration || iteration || null,
      });
    }
  };

  const handleStatic = (req, res, url) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed.");
    if (url.pathname === "/vendor/pierre-diffs.js") {
      return serveVendor(res, path.join(stateDir, "vendor", "pierre-diffs.js"));
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/" || url.pathname === "/review.html") {
      if (!authorized(req, url, token)) return sendText(res, 401, "Unauthorized.");
      return serveFile(res, reviewFile);
    }
    const archive = url.pathname.match(/^\/runs\/([0-9A-Za-z-]+)\/review\.html$/);
    if (archive) {
      if (!authorized(req, url, token)) return sendText(res, 401, "Unauthorized.");
      return serveFile(res, path.join(stateDir, "runs", archive[1], "review.html"));
    }
    return sendText(res, 404, "Not found.");
  };

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}`);
    try {
      if (!hostAllowed(req)) return sendText(res, 403, "Forbidden host.");
      if (url.pathname === "/api/health") {
        const current = currentInfo(root, { runId, iteration });
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          runId: current?.runId || runId || null,
          iteration: current?.iteration || iteration || null,
          closed: Boolean(session.closed),
        });
      }

      if (!url.pathname.startsWith("/api/")) return handleStatic(req, res, url);

      if (!authorized(req, url, token)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      }

      if (url.pathname === "/api/state" && req.method === "GET") {
        session = readSession(root) || session;
        const current = currentInfo(root, { runId, iteration });
        return sendJson(res, 200, publicState(session, current));
      }

      if (url.pathname === "/api/wait" && req.method === "GET") {
        session = readSession(root) || session;
        const current = currentInfo(root, { runId, iteration });
        if (session.closed) return sendJson(res, 200, { closed: true, current });
        const pending = pendingNotes(session);
        if (pending.length > 0) {
          markNotesSeen(session, pending);
          writeSession(root, session);
          return sendJson(res, 200, {
            current,
            notes: pending,
            agent: session.agent,
            iteration: current?.iteration || iteration || null,
          });
        }
        if (waiters.size > 0) {
          return sendJson(res, 409, { ok: false, error: "An agent is already waiting." });
        }
        session.agent.waiting = true;
        session.agent.lastWaitAt = isoNow();
        writeSession(root, session);
        const waiter = { res };
        waiters.add(waiter);
        req.on("close", () => {
          if (!waiters.has(waiter)) return;
          waiters.delete(waiter);
          const live = readSession(root);
          if (live && waiters.size === 0) {
            live.agent.waiting = false;
            writeSession(root, live);
            session = live;
          }
        });
        return undefined;
      }

      if (url.pathname === "/api/feedback" && req.method === "POST") {
        const body = await readBody(req);
        if (!body || !Array.isArray(body.notes)) {
          return sendJson(res, 400, { ok: false, error: "notes must be an array." });
        }
        session = readSession(root) || session;
        const current = currentInfo(root, { runId, iteration });
        const notes = appendNotes(root, session, body.notes, current?.iteration || iteration);
        if (notes.length === 0) {
          return sendJson(res, 400, { ok: false, error: "No note text was sent." });
        }
        drainWaiters();
        return sendJson(res, 200, {
          ok: true,
          accepted: notes.map((note) => ({ id: note.id, status: note.status })),
          state: publicState(readSession(root), current),
        });
      }

      if (url.pathname === "/api/reply" && req.method === "POST") {
        const body = await readBody(req);
        const text = String(body?.message || "").trim();
        if (!text) return sendJson(res, 400, { ok: false, error: "message is required." });
        session = readSession(root) || session;
        const current = currentInfo(root, { runId, iteration });
        const reply = appendReply(root, session, text, current?.iteration || iteration);
        session = readSession(root) || session;
        return sendJson(res, 200, { ok: true, reply, state: publicState(session, current) });
      }

      if (url.pathname === "/api/close" && req.method === "POST") {
        session = readSession(root) || session;
        markClosed(root, session);
        session = readSession(root) || session;
        const current = currentInfo(root, { runId, iteration });
        for (const waiter of [...waiters]) {
          waiters.delete(waiter);
          finishWaiter(waiter.res, { closed: true, current });
        }
        sendJson(res, 200, { ok: true, closed: true });
        if (!closing) {
          closing = true;
          setTimeout(() => {
            try {
              server.close();
              server.closeAllConnections?.();
            } finally {
              process.exitCode = 0;
            }
          }, 60);
        }
        return undefined;
      }

      return sendJson(res, 404, { ok: false, error: "Unknown API route." });
    } catch (error) {
      writeLog(`request failed: ${error?.stack || error}`);
      if (!res.headersSent) {
        return sendJson(res, 500, { ok: false, error: error?.message || "Server error." });
      }
    }
  };

  return new Promise((resolve, reject) => {
    server = http.createServer(handler);
    server.on("error", reject);
    server.listen(port, host, () => {
      const actual = server.address();
      const actualPort = typeof actual === "object" && actual ? actual.port : port;
      const baseUrl = `http://${host}:${actualPort}`;
      const url = `${baseUrl}/?token=${encodeURIComponent(token)}`;
      session.server = {
        pid: process.pid,
        host,
        port: actualPort,
        baseUrl,
        url,
        token,
        startedAt: isoNow(),
      };
      session.currentRunId = runId || session.currentRunId || null;
      session.currentIteration = iteration || session.currentIteration || null;
      writeSession(root, session);
      writeLog(`server started at ${baseUrl}`);
      resolve({
        server,
        port: actualPort,
        token,
        baseUrl,
        url,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
