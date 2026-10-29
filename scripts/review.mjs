#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  ReviewError,
  parseArgs,
  pathExists,
  toPosix,
} from "./lib/util.mjs";
import {
  collectReview,
  getRunArtifact,
  listRuns,
  loadHistory,
  loadRun,
  resolveRunId,
} from "./lib/context.mjs";
import { loadLensConfig } from "./lib/lenses.mjs";
import { validateReview, formatIssues } from "./lib/schema.mjs";
import { renderRun } from "./lib/render.mjs";
import { apiJson, openBrowser, serverHealth } from "./lib/client.mjs";
import { startReviewServer } from "./lib/server.mjs";
import {
  markClosed,
  readCurrent,
  readSession,
  writeSession,
} from "./lib/feedback.mjs";

const BOOLEAN = new Set([
  "staged", "untracked", "fresh", "json", "help",
  "draft", "render", "browser", "quiet",
]);
const VALUE = new Set([
  "root", "base", "range", "commit", "path", "run", "out",
  "port", "message", "message-file",
]);

function skillRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function printHelp() {
  console.log(`code-review — visual, line-by-line review of local code changes

USAGE
  node scripts/review.mjs collect [scope options]
  node scripts/review.mjs render [--run <id>] [--draft]
  node scripts/review.mjs lint   [--run <id>]
  node scripts/review.mjs open   [--run <id>] [--draft] [--no-render] [--no-browser]
  node scripts/review.mjs wait
  node scripts/review.mjs reply  --message "what changed" [--message-file <path>]
  node scripts/review.mjs stop
  node scripts/review.mjs serve  [--port <port>]
  node scripts/review.mjs status

SCOPE
  (default)          working tree vs HEAD (staged + unstaged + untracked)
  --staged           staged changes vs HEAD
  --base <ref>       merge-base(<ref>, HEAD) through the working tree
  --range <a..b>     diff between two refs (a...b uses the merge base)
  --commit <sha>     diff for one commit
  --path <spec>      limit to a git pathspec (repeatable)
  --no-untracked     do not include untracked files
  --root <dir>       repository to review (default: current directory)
  --fresh            start a new iteration timeline

OUTPUT
  .code-review/runs/<id>/context.json   machine context + snapshots
  .code-review/runs/<id>/review.json    agent-authored review (scaffolded)
  .code-review/review.html              current review artifact
  .code-review/runs/<id>/review.html    archived iteration artifact
  .code-review/history.json             iteration history
  .code-review/session.json             editor notes, agent replies, server
  .code-review/current.json             current run pointer

The review server is local. It binds to 127.0.0.1 and uses a random token.
Use open, wait, reply, and stop. No hosted service is required.
`);
}

function rootFrom(args) {
  const root = path.resolve(args.root || process.cwd());
  if (!pathExists(root)) throw new ReviewError(`Root does not exist: ${root}`);
  return root;
}

function statusLabel(status) {
  return String(status || "modified").toUpperCase().slice(0, 1);
}

function lensLine(file) {
  return file.lenses && file.lenses.length ? file.lenses.join(", ") : "general";
}

function printCollect(result, root, json) {
  if (json) {
    console.log(JSON.stringify({
      runId: result.runId,
      iteration: result.iteration,
      dir: toPosix(path.relative(root, result.dir)),
      scope: result.context.scope,
      stats: result.context.stats,
      files: result.context.files.map((file) => ({
        id: file.id,
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        blocks: file.blocks.length,
        lenses: file.lenses,
      })),
      previous: result.previous
        ? {
            runId: result.previous.runId,
            iteration: result.previous.iteration,
            openFindings: result.previous.openFindings,
          }
        : null,
      reviewPath: path.join(result.dir, "review.json"),
      contextPath: path.join(result.dir, "context.json"),
    }, null, 2));
    return;
  }

  const context = result.context;
  console.log(`Code review · ${context.repo.name}`);
  console.log(`Scope      ${context.scope.label}`);
  console.log(`Iteration  ${context.iteration} · run ${result.runId}`);
  console.log(`Changes    ${context.stats.files} files · +${context.stats.additions} −${context.stats.deletions} · ${context.stats.blocks} review blocks`);
  if (context.stats.binaryFiles) console.log(`Binary     ${context.stats.binaryFiles} file(s) not shown line by line`);
  console.log("");

  const maxPath = Math.min(72, Math.max(...context.files.map((file) => file.path.length), 12));
  for (const file of context.files) {
    const pathText = file.path.length > maxPath ? `…${file.path.slice(-(maxPath - 1))}` : file.path;
    const flag = file.binary ? "bin" : `${file.blocks.length} blk`;
    console.log(`  ${statusLabel(file.status)} ${pathText.padEnd(maxPath)}  +${String(file.additions).padStart(4)} −${String(file.deletions).padStart(4)}  ${flag.padEnd(7)}  ${lensLine(file)}`);
  }

  if (result.previous) {
    console.log("");
    console.log(`Compared with iteration ${result.previous.iteration} (${result.previous.runId})`);
    const delta = result.previous.codeDelta?.totals;
    if (delta) {
      console.log(`Code delta since then: ${delta.filesChanged} files · +${delta.additions} −${delta.deletions}`);
    }
    if (result.previous.openFindings) {
      console.log(`Carry forward ${result.previous.openFindings} open finding(s); reuse their ids or resolve them explicitly.`);
    }
  }

  console.log("");
  console.log(`Context    ${toPosix(path.relative(root, path.join(result.dir, "context.json")))}`);
  console.log(`Review     ${toPosix(path.relative(root, path.join(result.dir, "review.json")))}`);
  console.log("");
  console.log("Read before reviewing:");
  console.log(`  ${context.guides.method}`);
  console.log(`  ${context.guides.schema}`);
  const lensDocs = [...new Set(context.files.flatMap((file) => file.lenses || []))]
    .map((lens) => context.guides.lenses[lens])
    .filter(Boolean);
  for (const doc of lensDocs) console.log(`  ${doc}`);
  console.log("");
  console.log("Next:");
  console.log("  1. Review every block in context.files[*].blocks; open the snapshot files for full context.");
  console.log("  2. Fill review.json: verdict, headline, overview, flow, findings, and one assessment per block.");
  console.log(`  3. Run: node "${toPosix(path.join(context.skillRoot, "scripts", "review.mjs"))}" render`);
}

function cmdCollect(args) {
  const root = rootFrom(args);
  const result = collectReview({
    root,
    skillRoot: skillRoot(),
    options: {
      staged: Boolean(args.staged),
      base: args.base,
      range: args.range,
      commit: args.commit,
      path: args.path || [],
      untracked: args.untracked,
      fresh: Boolean(args.fresh),
    },
  });
  if (result.empty) {
    console.log(`No changes to review in ${result.repo.root} (${result.scope.label}).`);
    return 0;
  }
  printCollect(result, result.repo.root, Boolean(args.json));
  return 0;
}

function cmdStatus(args) {
  const root = rootFrom(args);
  const { history, runs } = listRuns(root);
  const session = readSession(root);
  if (runs.length === 0) {
    console.log("No review runs yet.");
    return 0;
  }
  console.log(`Review history · ${root}`);
  for (const run of runs) {
    const current = history.latestRunId === run.id ? "*" : " ";
    const findings = run.review
      ? `${run.review.findings?.open ?? 0} open · ${run.review.findings?.blocker ?? 0} blocker · ${run.review.findings?.high ?? 0} high`
      : "not rendered";
    console.log(`  ${current} #${String(run.iteration).padStart(2)} ${run.id}  ${String(run.status).padEnd(10)}  ${run.scope?.label || ""}`);
    console.log(`      ${findings}  ${run.artifact || ""}`);
  }
  if (session) {
    console.log("");
    console.log(`Review server  ${session.closed ? "closed" : session.server?.url || "not running"}`);
    console.log(`Notes          ${session.counts?.sent ?? 0} sent · ${session.counts?.seen ?? 0} seen · ${session.counts?.done ?? 0} done`);
    console.log(`Agent          ${session.agent?.waiting ? "waiting" : "idle"}`);
  }
  return 0;
}

function previousForContext(root, context) {
  if (!context.previous?.runId) return { review: null, entry: null };
  const history = loadHistory(root);
  const entry = (history.runs || []).find((run) => run.id === context.previous.runId) || null;
  if (!entry) return { review: null, entry: null };
  try {
    const previous = loadRun(root, entry.id);
    return { review: previous.review, entry };
  } catch {
    return { review: null, entry };
  }
}

function validateRun(root, runId, { draft = false } = {}) {
  const run = loadRun(root, runId);
  if (!run.review) throw new ReviewError(`No review.json for run ${runId}. Fill the scaffold first.`);
  const previous = previousForContext(root, run.context);
  const config = loadLensConfig(run.context.skillRoot || skillRoot());
  const result = validateReview({
    review: run.review,
    context: run.context,
    previousReview: previous.review,
    root,
    lensConfig: config,
    draft,
  });
  return { run, previous, result };
}

function cmdLint(args) {
  const root = rootFrom(args);
  const runId = resolveRunId(root, args.run);
  const { run, result } = validateRun(root, runId, { draft: Boolean(args.draft) });
  if (result.errors.length || result.warnings.length) {
    console.log(formatIssues(result.errors, result.warnings));
  }
  if (result.stats) {
    console.log(`Coverage ${result.stats.coveragePct}% (${result.stats.reviewedBlocks}/${result.stats.totalBlocks}) · ${result.stats.findingsCount} findings · ${result.stats.resolved.length} resolved`);
  }
  if (result.errors.length && !args.draft) return 2;
  console.log(`Run ${runId} · iteration ${run.context.iteration}: valid${result.errors.length ? " with draft warnings" : ""}.`);
  return 0;
}

function printRenderResult(result) {
  const v = result.validation;
  const counts = result.data.findings;
  console.log(`Iteration ${result.iteration} · ${result.data.verdict} · coverage ${result.data.coveragePct}% (${v.stats.reviewedBlocks}/${v.stats.totalBlocks})`);
  console.log(`Findings   ${counts.open} open · ${counts.blocker} blocker · ${counts.high} high · ${counts.medium} medium · ${counts.low} low`);
  console.log(`Movement   +${counts.new} new · −${counts.resolved} resolved · ${counts.carried} carried${counts.unverified ? ` · ${counts.unverified} unverified` : ""}`);
  if (v.warnings.length) {
    console.log("");
    console.log(formatIssues([], v.warnings));
  }
  console.log("");
  console.log(`Artifact   ${toPosix(result.artifactPath)}`);
  console.log(`Archive    ${toPosix(result.archivePath)}`);
}

function cmdRender(args) {
  const root = rootFrom(args);
  const runId = resolveRunId(root, args.run);
  const result = renderRun({ root, runId, draft: Boolean(args.draft) });
  if (args.json) console.log(JSON.stringify(result.data, null, 2));
  else printRenderResult(result);
  return 0;
}

function sessionUrl(session) {
  if (!session?.server) return null;
  if (session.server.url) return session.server.url;
  if (session.server.baseUrl && session.server.token) {
    return `${session.server.baseUrl}/?token=${encodeURIComponent(session.server.token)}`;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureServer(root, runId, port = 0) {
  const session = readSession(root);
  if (session?.server?.baseUrl) {
    const health = await serverHealth(session.server.baseUrl);
    if (health?.ok && !health.closed) return session;
  }

  const script = path.join(skillRoot(), "scripts", "review.mjs");
  const child = spawn(process.execPath, [
    script,
    "serve",
    "--root", root,
    "--run", runId,
    "--port", String(port || 0),
  ], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(100);
    const live = readSession(root);
    if (live?.server?.baseUrl) {
      const health = await serverHealth(live.server.baseUrl);
      if (health?.ok && !health.closed) return live;
    }
  }
  let log = "";
  const logFile = path.join(root, ".code-review", "server.log");
  if (pathExists(logFile)) {
    try { log = fs.readFileSync(logFile, "utf8").split("\n").slice(-12).join("\n"); } catch {}
  }
  throw new ReviewError(`The review server did not start.${log ? `\n\n${log}` : ""}`);
}

async function cmdOpen(args) {
  const root = rootFrom(args);
  const runId = resolveRunId(root, args.run);
  if (args.render !== false) {
    const result = renderRun({ root, runId, draft: Boolean(args.draft) });
    printRenderResult(result);
    console.log("");
  }
  const session = await ensureServer(root, runId, Number(args.port) || 0);
  const url = sessionUrl(session);
  if (!url) throw new ReviewError("The review server did not publish a URL.");
  if (args.browser !== false) openBrowser(url);
  const current = readCurrent(root);
  console.log("Review server is ready.");
  console.log(`  URL     ${url}`);
  console.log(`  Run     ${current?.runId || runId} · iteration ${current?.iteration || "?"}`);
  console.log("");
  console.log("Wait for notes:");
  console.log(`  node "${toPosix(path.join(skillRoot(), "scripts", "review.mjs"))}" wait`);
  if (args.browser === false) {
    console.log("");
    console.log("Open the URL above in a browser.");
  }
  return 0;
}

async function cmdWait(args) {
  const root = rootFrom(args);
  const session = readSession(root);
  if (!session?.server?.baseUrl) {
    throw new ReviewError("No review server is running. Run `open` first.");
  }
  const health = await serverHealth(session.server.baseUrl);
  if (!health?.ok) {
    throw new ReviewError("The review server is not responding. Run `open` again.");
  }
  console.log(`Waiting for notes · ${session.server.baseUrl}`);
  let response;
  try {
    response = await apiJson(session.server.baseUrl, "/api/wait", {
      token: session.server.token,
      longPoll: true,
    });
  } catch (error) {
    throw new ReviewError(`The wait request failed: ${error.message}\nRun \`open\` again if the server stopped.`);
  }
  if (response?.closed) {
    console.log("The reviewer closed the session.");
    return 0;
  }
  const notes = response?.notes || [];
  if (!notes.length) {
    console.log("No notes were returned. Run `wait` again.");
    return 0;
  }
  const current = response.current || readCurrent(root);
  console.log("");
  console.log(`Review notes · run ${current?.runId || "?"} · iteration ${current?.iteration || "?"}`);
  console.log("");
  notes.forEach((note, index) => {
    const anchor = note.anchor || {};
    const parts = [];
    if (anchor.findingId) parts.push(`finding ${anchor.findingId}`);
    if (anchor.blockId) parts.push(`block ${anchor.blockId}`);
    if (anchor.file) parts.push(anchor.line ? `${anchor.file}:${anchor.line}` : anchor.file);
    if (anchor.kind === "flow" || anchor.kind === "element" || anchor.kind === "text") {
      if (anchor.label) parts.push(anchor.label);
      else parts.push(anchor.kind);
    }
    if (anchor.kind === "message") parts.push("message");
    console.log(`${index + 1}. ${note.id}${parts.length ? ` · ${parts.join(" · ")}` : ""}`);
    if (anchor.excerpt) console.log(`   Context: ${String(anchor.excerpt).replace(/\n/g, " ").slice(0, 240)}`);
    for (const line of String(note.text || "").split("\n")) console.log(`   ${line}`);
    console.log("");
  });
  console.log("Next:");
  console.log("  1. Apply the feedback.");
  console.log("  2. Run collect again if code changed; update review.json; render.");
  console.log(`  3. Reply: node "${toPosix(path.join(skillRoot(), "scripts", "review.mjs"))}" reply --message "what changed"`);
  console.log(`  4. Wait again: node "${toPosix(path.join(skillRoot(), "scripts", "review.mjs"))}" wait`);
  return 0;
}

function readMessage(args) {
  if (args["message-file"]) {
    const file = path.resolve(String(args["message-file"]));
    if (!pathExists(file)) throw new ReviewError(`Message file does not exist: ${file}`);
    return fs.readFileSync(file, "utf8");
  }
  if (typeof args.message === "string") return args.message;
  throw new ReviewError("Pass --message \"...\" or --message-file <path>.");
}

async function cmdReply(args) {
  const root = rootFrom(args);
  const message = readMessage(args).trim();
  if (!message) throw new ReviewError("The reply is empty.");
  const session = readSession(root);
  if (!session?.server?.baseUrl) throw new ReviewError("No review server is running. Run `open` first.");
  let response;
  try {
    response = await apiJson(session.server.baseUrl, "/api/reply", {
      method: "POST",
      token: session.server.token,
      body: { message },
    });
  } catch (error) {
    throw new ReviewError(`The reply was not sent: ${error.message}`);
  }
  const closed = (response?.state?.counts?.done ?? 0);
  console.log(`Reply posted. ${closed} note(s) marked done.`);
  console.log("");
  console.log("Wait for more notes:");
  console.log(`  node "${toPosix(path.join(skillRoot(), "scripts", "review.mjs"))}" wait`);
  return 0;
}

async function cmdStop(args) {
  const root = rootFrom(args);
  const session = readSession(root);
  if (!session) {
    console.log("No review session.");
    return 0;
  }
  if (session.server?.baseUrl) {
    try {
      await apiJson(session.server.baseUrl, "/api/close", {
        method: "POST",
        token: session.server.token,
        timeoutMs: 2000,
      });
      console.log("Review server closed.");
      return 0;
    } catch {
      if (session.server.pid) {
        try { process.kill(session.server.pid); } catch {}
      }
    }
  }
  const live = readSession(root);
  if (live) markClosed(root, live);
  console.log("Review session closed.");
  return 0;
}

async function cmdServe(args) {
  const root = rootFrom(args);
  const current = readCurrent(root);
  const runId = args.run || current?.runId;
  if (!runId) throw new ReviewError("No current review. Run render first, or pass --run <id>.");
  const iteration = current?.iteration || loadRun(root, runId).context.iteration;
  const info = await startReviewServer({
    root,
    runId,
    iteration,
    port: Number(args.port) || 0,
  });
  console.log(`Review server ready: ${info.url}`);
  console.log("Keep this process running. Press Ctrl+C to stop.");
  const shutdown = async () => {
    try { await info.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  info.server.on("close", () => process.exit(0));
  return new Promise(() => {});
}

function commandMain(argv) {
  const args = parseArgs(argv, BOOLEAN, VALUE);
  if (args.help || args._.length === 0) {
    printHelp();
    return 0;
  }
  const command = args._[0];
  switch (command) {
    case "collect":
      return cmdCollect(args);
    case "status":
      return cmdStatus(args);
    case "lint":
      return cmdLint(args);
    case "render":
      return cmdRender(args);
    case "open":
      return cmdOpen(args);
    case "wait":
      return cmdWait(args);
    case "reply":
      return cmdReply(args);
    case "stop":
      return cmdStop(args);
    case "serve":
      return cmdServe(args);
    case "help":
      printHelp();
      return 0;
    default:
      throw new ReviewError(`Unknown command: ${command}\nRun with --help for usage.`);
  }
}

try {
  process.exitCode = await commandMain(process.argv.slice(2));
} catch (error) {
  if (error instanceof ReviewError) {
    console.error(`error: ${error.message}`);
    if (error.details?.warnings?.length) console.error(formatIssues([], error.details.warnings));
    process.exitCode = error.code || 1;
  } else {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
