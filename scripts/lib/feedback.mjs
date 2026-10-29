import fs from "node:fs";
import path from "node:path";
import { ensureDir, isoNow, readJson, writeJson } from "./util.mjs";

export const SESSION_FILE = "session.json";

export function sessionPath(root) {
  return path.join(root, ".code-review", SESSION_FILE);
}

export function currentPath(root) {
  return path.join(root, ".code-review", "current.json");
}

export function defaultSession() {
  return {
    schemaVersion: 1,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    closed: false,
    closedAt: null,
    server: null,
    agent: {
      waiting: false,
      lastWaitAt: null,
      lastDeliveryAt: null,
      lastReplyAt: null,
    },
    notes: [],
    replies: [],
  };
}

export function readSession(root) {
  const file = sessionPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultSession(),
      ...value,
      agent: { ...defaultSession().agent, ...(value.agent || {}) },
      notes: Array.isArray(value.notes) ? value.notes : [],
      replies: Array.isArray(value.replies) ? value.replies : [],
    };
  } catch {
    return null;
  }
}

export function writeSession(root, session) {
  session.updatedAt = isoNow();
  ensureDir(path.dirname(sessionPath(root)));
  writeJson(sessionPath(root), session);
  return session;
}

export function touchSession(root, { runId, iteration }) {
  const session = readSession(root);
  if (!session) return null;
  session.currentRunId = runId || session.currentRunId || null;
  session.currentIteration = iteration || session.currentIteration || null;
  return writeSession(root, session);
}

export function readCurrent(root) {
  return readJson(currentPath(root), null);
}

export function writeCurrent(root, value) {
  writeJson(currentPath(root), value);
}

export function nextId(prefix, items) {
  let max = 0;
  for (const item of items || []) {
    const match = String(item.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

function cleanText(value, max = 5000) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function cleanAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return { kind: "message" };
  const allowed = ["finding", "block", "line", "text", "flow", "message", "element"];
  const kind = allowed.includes(anchor.kind) ? anchor.kind : "element";
  const out = { kind };
  for (const key of ["file", "blockId", "findingId", "line", "lineEnd", "side", "label", "excerpt", "nodeId"]) {
    if (anchor[key] !== undefined && anchor[key] !== null) {
      if (key === "line" || key === "lineEnd") {
        const number = Number(anchor[key]);
        if (Number.isFinite(number)) out[key] = number;
      } else {
        out[key] = cleanText(anchor[key], key === "excerpt" ? 1000 : 300);
      }
    }
  }
  return out;
}

export function normalizeIncomingNotes(notes, iteration) {
  if (!Array.isArray(notes)) return [];
  return notes.slice(0, 50).map((note) => ({
    id: null,
    text: cleanText(note?.text, 5000),
    anchor: cleanAnchor(note?.anchor),
    iteration: Number(iteration) || null,
    createdAt: isoNow(),
    status: "sent",
  })).filter((note) => note.text !== "");
}

export function appendNotes(root, session, notes, iteration) {
  const normalized = normalizeIncomingNotes(notes, iteration);
  for (const note of normalized) {
    note.id = nextId("N", session.notes);
    session.notes.push(note);
  }
  session.currentIteration = Number(iteration) || session.currentIteration || null;
  writeSession(root, session);
  return normalized;
}

export function appendReply(root, session, text, iteration) {
  const message = cleanText(text, 6000);
  if (!message) return null;
  const reply = {
    id: nextId("A", session.replies),
    text: message,
    iteration: Number(iteration) || session.currentIteration || null,
    createdAt: isoNow(),
  };
  session.replies.push(reply);
  session.agent.waiting = false;
  session.agent.lastReplyAt = reply.createdAt;
  for (const note of session.notes) {
    if (note.status === "seen") {
      note.status = "done";
      note.doneAt = isoNow();
    }
  }
  writeSession(root, session);
  return reply;
}

export function markClosed(root, session) {
  session.closed = true;
  session.closedAt = isoNow();
  session.agent.waiting = false;
  session.server = null;
  writeSession(root, session);
  return session;
}

export function publicState(session, current) {
  return {
    schemaVersion: 1,
    closed: Boolean(session?.closed),
    current: current || null,
    agent: session?.agent || defaultSession().agent,
    notes: (session?.notes || []).slice(-100),
    replies: (session?.replies || []).slice(-100),
    counts: {
      sent: (session?.notes || []).filter((note) => note.status === "sent").length,
      seen: (session?.notes || []).filter((note) => note.status === "seen").length,
      done: (session?.notes || []).filter((note) => note.status === "done").length,
    },
  };
}

export function pendingNotes(session) {
  return (session?.notes || []).filter((note) => note.status === "sent");
}

export function markNotesSeen(session, notes, at = isoNow()) {
  for (const note of notes) {
    const live = session.notes.find((item) => item.id === note.id);
    if (live && live.status === "sent") {
      live.status = "seen";
      live.seenAt = at;
    }
  }
  session.agent.waiting = false;
  session.agent.lastDeliveryAt = at;
  return session;
}
