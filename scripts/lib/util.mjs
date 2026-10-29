import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export class ReviewError extends Error {
  constructor(message, code = 1, details = undefined) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.details = details;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pathExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new ReviewError(`Cannot read JSON at ${file}: ${error.message}`);
  }
}

export function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

export function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

export function displayPath(root, file) {
  const relative = path.relative(root, file);
  return toPosix(relative || ".");
}

export function timestampId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("") + "-" + crypto.randomBytes(2).toString("hex");
}

export function isoNow(date = new Date()) {
  return date.toISOString();
}

export function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function jsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function truncate(value, max = 200) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function isProbablyBinary(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

export function splitLines(text) {
  return normalizeNewlines(text).split("\n");
}

export function countLines(text) {
  const normalized = normalizeNewlines(text);
  if (normalized === "") return 0;
  return normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0);
}

export function parseArgs(argv, knownBoolean = new Set(), knownValue = new Set()) {
  const result = { _: [] };
  const addValue = (name, value, fromEquals) => {
    if (name === "path") {
      if (!Array.isArray(result.path)) result.path = [];
      result.path.push(value);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(result, name) && result[name] !== true) {
      if (!Array.isArray(result[name])) result[name] = [result[name]];
      result[name].push(value);
      return;
    }
    result[name] = value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      result._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const rawName = eq >= 0 ? body.slice(0, eq) : body;
    const inline = eq >= 0 ? body.slice(eq + 1) : undefined;
    let name = rawName;
    let negated = false;
    if (name.startsWith("no-")) {
      negated = true;
      name = name.slice(3);
    }
    if (!knownBoolean.has(name) && !knownValue.has(name) && !knownBoolean.has(rawName) && !knownValue.has(rawName)) {
      throw new ReviewError(`Unknown option --${rawName}`);
    }
    if (negated) {
      addValue(name, false, inline !== undefined);
      continue;
    }
    if (inline !== undefined) {
      addValue(name, inline, true);
      continue;
    }
    if (knownValue.has(name)) {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new ReviewError(`Option --${name} needs a value`);
      }
      addValue(name, next, false);
      index += 1;
      continue;
    }
    addValue(name, true, false);
  }
  return result;
}

export function run(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    allowFailure = false,
    encoding = "utf8",
    input,
    maxBuffer = 128 * 1024 * 1024,
    env = process.env,
    stdio = "pipe",
  } = options;
  const result = spawnSync(command, args, {
    cwd,
    input,
    env,
    encoding,
    maxBuffer,
    windowsHide: true,
    stdio,
  });
  if (result.error) {
    throw new ReviewError(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr?.toString("utf8") || "";
    throw new ReviewError(`${command} ${args.join(" ")} failed with exit ${result.status}${stderr ? `\n${stderr.trim()}` : ""}`);
  }
  return result;
}

export function runGit(args, options = {}) {
  return run("git", args, options);
}

export function gitText(args, options = {}) {
  const result = runGit(args, options);
  return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
}

export function gitBuffer(args, options = {}) {
  const result = runGit(args, { ...options, encoding: "buffer" });
  return {
    status: result.status,
    stdout: result.stdout || Buffer.alloc(0),
    stderr: result.stderr ? result.stderr.toString("utf8") : "",
  };
}

export function copyRecursive(source, destination, filter = () => true) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    ensureDir(destination);
    for (const entry of fs.readdirSync(source)) {
      const from = path.join(source, entry);
      const to = path.join(destination, entry);
      if (!filter(from, entry)) continue;
      copyRecursive(from, to, filter);
    }
    return;
  }
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

export function removeRecursive(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function sortBy(list, key) {
  return [...list].sort((a, b) => String(key(a)).localeCompare(String(key(b))));
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function unique(list) {
  return [...new Set(list)];
}

export function relativeUrl(fromDir, toFile) {
  const rel = path.relative(fromDir, toFile);
  return toPosix(rel);
}
