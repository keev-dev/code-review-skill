import path from "node:path";
import fs from "node:fs";
import {
  ReviewError,
  countLines,
  ensureDir,
  formatBytes,
  isoNow,
  pathExists,
  readJson,
  timestampId,
  toPosix,
  writeJson,
  writeText,
} from "./util.mjs";
import {
  diffStatBetweenTexts,
  groupHunksIntoBlocks,
  languageFor,
  makeWholeFileHunks,
  parseHunks,
  splitBlocksAtBlankLines,
} from "./diff.mjs";
import { detectLenses, lensCatalog } from "./lenses.mjs";
import {
  getNumstat,
  getPatch,
  listChangedFiles,
  readFileContents,
  resolveScope,
} from "./git.mjs";

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_LENS_SAMPLE = 250_000;

export function stateDir(root) {
  return path.join(root, ".code-review");
}

export function historyPath(root) {
  return path.join(stateDir(root), "history.json");
}

export function runDir(root, runId) {
  return path.join(stateDir(root), "runs", runId);
}

export function loadHistory(root) {
  return readJson(historyPath(root), {
    schemaVersion: 1,
    latestRunId: null,
    runs: [],
  });
}

export function saveHistory(root, history) {
  writeJson(historyPath(root), history);
}

export function latestRenderedEntry(history, beforeIteration = Number.POSITIVE_INFINITY) {
  return (history.runs || [])
    .filter((run) => run.status === "rendered" && run.iteration < beforeIteration)
    .sort((a, b) => b.iteration - a.iteration)[0] || null;
}

export function latestRunEntry(history) {
  if (history.latestRunId) {
    const match = (history.runs || []).find((run) => run.id === history.latestRunId);
    if (match) return match;
  }
  return [...(history.runs || [])].sort((a, b) => b.iteration - a.iteration)[0] || null;
}

export function loadRun(root, runId) {
  const dir = runDir(root, runId);
  const contextFile = path.join(dir, "context.json");
  const reviewFile = path.join(dir, "review.json");
  if (!pathExists(contextFile)) {
    throw new ReviewError(`Run not found: ${runId}\nLooked for ${contextFile}`);
  }
  return {
    id: runId,
    dir,
    contextFile,
    reviewFile,
    context: readJson(contextFile),
    review: pathExists(reviewFile) ? readJson(reviewFile) : null,
  };
}

export function resolveRunId(root, requested) {
  const history = loadHistory(root);
  if (requested) return requested;
  const latest = latestRunEntry(history);
  if (!latest) {
    throw new ReviewError("No review runs yet. Run `collect` first.");
  }
  return latest.id;
}

function readSnapshot(root, runId, relativePath) {
  if (!relativePath) return null;
  const file = path.join(runDir(root, runId), relativePath);
  if (!pathExists(file)) return null;
  return fs.readFileSync(file, "utf8");
}

export function computeCodeDelta(root, previousEntry, previousContext, files) {
  const deltaFiles = [];
  const previousFiles = new Map(
    (previousContext.files || []).map((file) => [file.path, file]),
  );
  const currentPaths = new Set(files.map((file) => file.path));
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;

  for (const file of files) {
    const previous = previousFiles.get(file.path) || previousFiles.get(file.oldPath);
    if (!previous) {
      const status = file.status === "added" ? "added" : "new-to-scope";
      deltaFiles.push({
        path: file.path,
        status,
        additions: file.additions,
        deletions: file.deletions,
      });
      if (status === "added") {
        changedFiles += 1;
        additions += file.additions;
        deletions += file.deletions;
      }
      continue;
    }
    const previousText = readSnapshot(root, previousEntry.id, previous.snapshot?.new);
    const currentText = readCurrentSnapshot(root, file);
    if (previousText === null || currentText === null) {
      deltaFiles.push({
        path: file.path,
        status: "unknown",
        additions: 0,
        deletions: 0,
      });
      continue;
    }
    const stat = diffStatBetweenTexts(previousText, currentText);
    if (stat.additions === 0 && stat.deletions === 0 && previousText === currentText) {
      deltaFiles.push({ path: file.path, status: "unchanged", additions: 0, deletions: 0 });
      continue;
    }
    changedFiles += 1;
    additions += stat.additions;
    deletions += stat.deletions;
    deltaFiles.push({
      path: file.path,
      status: "changed",
      additions: stat.additions,
      deletions: stat.deletions,
    });
  }

  for (const [previousPath, previous] of previousFiles) {
    if (currentPaths.has(previousPath)) continue;
    deltaFiles.push({
      path: previousPath,
      status: "removed",
      additions: 0,
      deletions: previous.deletions || 0,
    });
  }

  return {
    fromRunId: previousEntry.id,
    fromIteration: previousEntry.iteration,
    files: deltaFiles.sort((a, b) => a.path.localeCompare(b.path)),
    totals: {
      filesChanged: changedFiles,
      additions,
      deletions,
    },
  };
}

function readCurrentSnapshot(root, file) {
  if (!file.runId) return null;
  return readSnapshot(root, file.runId, file.snapshot?.new);
}

function buildFileEntry({ root, runId, index, file, scope, lensConfig }) {
  const id = `f${index + 1}`;
  const contents = readFileContents(root, scope, file);
  const tooLarge = contents.oldBytes > MAX_SNAPSHOT_BYTES || contents.newBytes > MAX_SNAPSHOT_BYTES;
  const binary = contents.binary;
  const language = languageFor(file.path || file.oldPath || "unknown");
  const side = file.status === "deleted" ? "old" : "new";
  const reviewText = side === "old" ? contents.oldText : contents.newText;
  const lensSample = reviewText.slice(0, MAX_LENS_SAMPLE);
  const detected = detectLenses({
    filePath: file.path,
    content: lensSample,
    language,
    config: lensConfig,
  });

  let hunks = [];
  const warnings = [];
  if (binary) {
    warnings.push("Binary file: content is not shown or reviewed line by line.");
  } else if (tooLarge) {
    warnings.push(`File is larger than ${formatBytes(MAX_SNAPSHOT_BYTES)}; content and blocks are omitted. Review it from the repository if needed.`);
  } else if (file.status === "added" || file.status === "copied") {
    hunks = makeWholeFileHunks(contents.newText, "new");
  } else if (file.status === "deleted") {
    hunks = makeWholeFileHunks(contents.oldText, "old");
  } else {
    const patch = getPatch(root, scope, file);
    hunks = parseHunks(patch);
    if (hunks.length === 0 && contents.oldText !== contents.newText) {
      warnings.push("Git produced no textual hunks for this file (mode, type, or binary change).");
    }
  }

  const groupedBlocks = tooLarge || binary ? [] : groupHunksIntoBlocks(hunks, { side });
  const blocks = tooLarge || binary
    ? []
    : splitBlocksAtBlankLines(groupedBlocks, side === "old" ? contents.oldText : contents.newText, { side });
  const additions = hunks.reduce((sum, hunk) => sum + hunk.additions, 0);
  const deletions = hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
  const numstat = getNumstat(root, scope, file);
  const finalAdditions = additions || numstat.additions;
  const finalDeletions = deletions || numstat.deletions;

  let snapshot = null;
  let contentOmitted = binary || tooLarge;
  if (!contentOmitted) {
    const snapshotDir = "snapshot";
    const oldRel = `${snapshotDir}/${id}.old`;
    const newRel = `${snapshotDir}/${id}.new`;
    const dir = runDir(root, runId);
    writeText(path.join(dir, oldRel), contents.oldText);
    writeText(path.join(dir, newRel), contents.newText);
    snapshot = {
      old: oldRel,
      new: newRel,
      oldLineCount: countLines(contents.oldText),
      newLineCount: countLines(contents.newText),
    };
  }

  return {
    id,
    path: file.path,
    oldPath: file.oldPath || null,
    copiedFrom: file.copiedFrom || null,
    status: file.status,
    statusCode: file.statusCode,
    untracked: Boolean(file.untracked),
    language,
    binary,
    tooLarge,
    contentOmitted,
    additions: finalAdditions,
    deletions: finalDeletions,
    oldBytes: contents.oldBytes,
    newBytes: contents.newBytes,
    lineCount: {
      old: countLines(contents.oldText),
      new: countLines(contents.newText),
    },
    lenses: detected.lenses,
    lensReasons: detected.reasons,
    hunks,
    blocks,
    snapshot,
    side,
    warnings,
  };
}

function buildPrevious(root, history, currentIteration) {
  const previousEntry = latestRenderedEntry(history, currentIteration);
  if (!previousEntry) return null;
  const contextFile = path.join(runDir(root, previousEntry.id), "context.json");
  const reviewFile = path.join(runDir(root, previousEntry.id), "review.json");
  if (!pathExists(contextFile) || !pathExists(reviewFile)) return null;
  let previousContext;
  let previousReview;
  try {
    previousContext = readJson(contextFile);
    previousReview = readJson(reviewFile);
  } catch {
    return null;
  }
  const findings = Array.isArray(previousReview.findings) ? previousReview.findings : [];
  const severityCounts = {};
  for (const finding of findings) {
    severityCounts[finding.severity] = (severityCounts[finding.severity] || 0) + 1;
  }
  return {
    entry: previousEntry,
    context: previousContext,
    review: previousReview,
    summary: {
      runId: previousEntry.id,
      iteration: previousEntry.iteration,
      createdAt: previousEntry.createdAt,
      verdict: previousReview.verdict || previousEntry.review?.verdict || "unknown",
      headline: previousReview.headline || "",
      scopeLabel: previousEntry.scope?.label || previousContext.scope?.label || "",
      openFindings: findings.length,
      severityCounts,
      findings: findings.map((finding) => ({
        id: finding.id,
        file: finding.file,
        title: finding.title,
        severity: finding.severity,
        lens: finding.lens || null,
        blockId: finding.blockId || null,
        startLine: finding.startLine ?? null,
        endLine: finding.endLine ?? null,
        side: finding.side || null,
      })),
      files: (previousContext.files || []).map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        blocks: (file.blocks || []).length,
      })),
      reviewPath: toPosix(path.relative(root, reviewFile)),
      contextPath: toPosix(path.relative(root, contextFile)),
      artifactPath: previousEntry.artifact || null,
    },
  };
}

function scaffoldFor(context) {
  return {
    schemaVersion: 1,
    verdict: "ship",
    headline: "Review in progress — replace this headline with the verdict.",
    overview: "Replace this with 2–4 sentences that tell the stakeholder what changed and what needs attention.",
    iterationNote: "",
    risks: [],
    nextActions: [],
    flow: {
      title: "",
      subtitle: "",
      nodes: [],
      edges: [],
    },
    findings: [],
    resolutions: [],
    fileReviews: context.files.map((file) => ({
      file: file.path,
      risk: "low",
      summary: "",
      blocks: (file.blocks || []).map((block) => ({
        id: block.id,
        assessment: "not-reviewed",
        summary: "",
      })),
    })),
  };
}

export function collectReview({ root, skillRoot, options = {} }) {
  const scope = resolveScope({
    root,
    staged: Boolean(options.staged),
    base: options.base,
    range: options.range,
    commit: options.commit,
    paths: options.path || [],
    includeUntracked: options.untracked !== false,
  });
  const changedFiles = listChangedFiles(scope.repo.root, scope);
  if (changedFiles.length === 0) {
    return {
      empty: true,
      scope,
      repo: scope.repo,
    };
  }

  const history = loadHistory(scope.repo.root);
  const maxIteration = (history.runs || []).reduce((max, run) => Math.max(max, run.iteration || 0), 0);
  const iteration = options.fresh ? 1 : maxIteration + 1;
  const runId = timestampId();
  const dir = runDir(scope.repo.root, runId);
  ensureDir(dir);
  ensureDir(path.join(dir, "snapshot"));

  const lensConfig = readJson(path.join(skillRoot, "lenses.json"));
  const catalog = lensCatalog(lensConfig);
  const files = changedFiles.map((file, index) => buildFileEntry({
    root: scope.repo.root,
    runId,
    index,
    file,
    scope,
    lensConfig,
  }));

  for (const file of files) {
    file.runId = runId;
  }

  const previous = buildPrevious(scope.repo.root, history, iteration);
  let previousInfo = null;
  if (previous) {
    previousInfo = {
      ...previous.summary,
      codeDelta: computeCodeDelta(scope.repo.root, previous.entry, previous.context, files),
      scopeChanged: previous.entry.scope?.kind !== scope.kind
        || previous.entry.scope?.oldRef !== scope.oldRef
        || previous.entry.scope?.newRef !== scope.newRef,
    };
  }

  const totals = files.reduce(
    (acc, file) => {
      acc.additions += file.additions;
      acc.deletions += file.deletions;
      acc.blocks += file.blocks.length;
      if (file.binary) acc.binaryFiles += 1;
      if (!file.binary && !file.tooLarge) acc.textFiles += 1;
      acc[file.status] = (acc[file.status] || 0) + 1;
      return acc;
    },
    { additions: 0, deletions: 0, blocks: 0, textFiles: 0, binaryFiles: 0 },
  );

  const guides = {
    method: path.join(skillRoot, "references", "method.md"),
    schema: path.join(skillRoot, "references", "schema.md"),
    iterations: path.join(skillRoot, "references", "iterations.md"),
    lenses: Object.fromEntries(
      Object.entries(catalog)
        .filter(([, lens]) => lens.doc)
        .map(([id, lens]) => [id, path.join(skillRoot, lens.doc)]),
    ),
  };

  const context = {
    schemaVersion: 1,
    runId,
    iteration,
    createdAt: isoNow(),
    skillRoot,
    repo: {
      root: scope.repo.root,
      name: scope.repo.name,
      branch: scope.repo.branch,
      head: scope.repo.head,
      headShort: scope.repo.headShort,
      dirty: scope.repo.dirty,
    },
    scope: {
      kind: scope.kind,
      label: scope.label,
      oldRef: scope.oldRef,
      newRef: scope.newRef,
      oldLabel: scope.oldLabel,
      newLabel: scope.newLabel,
      paths: scope.paths,
      includeUntracked: scope.includeUntracked,
    },
    stats: {
      files: files.length,
      additions: totals.additions,
      deletions: totals.deletions,
      blocks: totals.blocks,
      textFiles: totals.textFiles,
      binaryFiles: totals.binaryFiles,
      byStatus: Object.fromEntries(
        files.reduce((map, file) => {
          map.set(file.status, (map.get(file.status) || 0) + 1);
          return map;
        }, new Map()),
      ),
    },
    files,
    lenses: catalog,
    guides,
    previous: previousInfo,
  };

  writeJson(path.join(dir, "context.json"), context);
  const scaffold = scaffoldFor(context);
  writeJson(path.join(dir, "review.json"), scaffold);

  const entry = {
    id: runId,
    iteration,
    createdAt: context.createdAt,
    status: "collecting",
    scope: {
      kind: scope.kind,
      label: scope.label,
      oldRef: scope.oldRef,
      newRef: scope.newRef,
    },
    stats: {
      files: context.stats.files,
      additions: context.stats.additions,
      deletions: context.stats.deletions,
      blocks: context.stats.blocks,
      binaryFiles: context.stats.binaryFiles,
    },
    previousRunId: previousInfo?.runId || null,
    reviewPath: toPosix(path.relative(scope.repo.root, path.join(dir, "review.json"))),
    contextPath: toPosix(path.relative(scope.repo.root, path.join(dir, "context.json"))),
    artifact: null,
    review: null,
  };
  history.runs = [...(history.runs || []), entry];
  saveHistory(scope.repo.root, history);

  return {
    empty: false,
    runId,
    iteration,
    dir,
    context,
    previous: previousInfo,
    history,
    scaffold,
    scope,
    repo: scope.repo,
  };
}

export function listRuns(root) {
  const history = loadHistory(root);
  return {
    history,
    runs: [...(history.runs || [])].sort((a, b) => b.iteration - a.iteration),
  };
}

export function getRunArtifact(root, runId) {
  const dir = runDir(root, runId);
  return {
    current: path.join(stateDir(root), "review.html"),
    archive: path.join(dir, "review.html"),
  };
}
