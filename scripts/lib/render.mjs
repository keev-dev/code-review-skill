import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReviewError,
  ensureDir,
  isoNow,
  jsonForHtml,
  pathExists,
  readText,
  toPosix,
  writeText,
} from "./util.mjs";
import {
  loadHistory,
  loadRun,
  runDir,
  saveHistory,
  stateDir,
} from "./context.mjs";
import { loadLensConfig, lensCatalog } from "./lenses.mjs";
import { validateReview, formatIssues } from "./schema.mjs";
import { buildIteration } from "./iteration.mjs";
import { writeCurrent } from "./feedback.mjs";

const SEVERITY_ORDER = ["blocker", "high", "medium", "low", "question", "nit", "praise"];
const ASSESSMENT_ORDER = ["needs-work", "concern", "question", "sound", "not-reviewed"];

function readSnapshot(root, runId, relative) {
  if (!relative) return "";
  const file = path.join(runDir(root, runId), relative);
  if (!pathExists(file)) return "";
  return readText(file);
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severity !== 0) return severity;
    const line = (a.startLine || 0) - (b.startLine || 0);
    if (line !== 0) return line;
    return String(a.id).localeCompare(String(b.id));
  });
}

function placeholderFileReview(file) {
  return {
    file: file.path,
    risk: "low",
    summary: "",
    blocks: (file.blocks || []).map((block) => ({
      id: block.id,
      assessment: "not-reviewed",
      summary: "",
    })),
  };
}

function buildFallbackFlow(context, review, files) {
  const nodes = [];
  const edges = [];
  const findings = review.findings || [];
  const severity = {};
  for (const finding of findings) severity[finding.severity] = (severity[finding.severity] || 0) + 1;

  if (files.length <= 5) {
    for (const file of files) {
      nodes.push({
        id: `file-${file.id}`,
        label: path.basename(file.path),
        kind: "input",
        detail: file.path,
        files: [file.path],
        findingIds: (file.findings || []).map((finding) => finding.id),
        layer: 0,
      });
      edges.push({ from: `file-${file.id}`, to: "review", label: "", kind: "dependency" });
    }
  } else {
    nodes.push({
      id: "changes",
      label: `${files.length} changed files`,
      kind: "input",
      detail: files.slice(0, 6).map((file) => path.basename(file.path)).join(" · "),
      files: files.map((file) => file.path),
      findingIds: [],
      layer: 0,
    });
    edges.push({ from: "changes", to: "review", label: "", kind: "dependency" });
  }

  const activeLenses = [...new Set(files.flatMap((file) => file.lenses || []))];
  nodes.push({
    id: "review",
    label: "Review lenses",
    kind: "transform",
    detail: activeLenses.length ? activeLenses.join(" · ") : "General review",
    files: [],
    findingIds: [],
    layer: 1,
  });
  nodes.push({
    id: "findings",
    label: findings.length ? `${findings.length} findings` : "No findings",
    kind: "output",
    detail: SEVERITY_ORDER.filter((key) => severity[key]).map((key) => `${severity[key]} ${key}`).join(" · "),
    files: [],
    findingIds: findings.map((finding) => finding.id),
    layer: 2,
  });
  edges.push({ from: "review", to: "findings", label: "surfaces", kind: "control" });
  nodes.push({
    id: "verdict",
    label: `Verdict: ${review.verdict}`,
    kind: "output",
    detail: review.headline,
    files: [],
    findingIds: [],
    layer: 3,
  });
  edges.push({ from: "findings", to: "verdict", label: "informs", kind: "control" });

  return {
    title: "Review pipeline",
    subtitle: "Fallback view: this review did not author a change-flow map.",
    nodes,
    edges,
    source: "fallback",
  };
}

function buildReviewData({
  root,
  run,
  context,
  review,
  validation,
  iteration,
  history,
  artifactBase,
  draft,
  archived = false,
}) {
  const fileReviews = new Map((review.fileReviews || []).map((file) => [file.file, file]));
  const findingsByFile = new Map();
  for (const finding of sortFindings(review.findings || [])) {
    if (!findingsByFile.has(finding.file)) findingsByFile.set(finding.file, []);
    findingsByFile.get(finding.file).push(finding);
  }

  const files = (context.files || []).map((file) => {
    const fileReview = fileReviews.get(file.path) || placeholderFileReview(file);
    const blocksById = new Map((fileReview.blocks || []).map((block) => [block.id, block]));
    const blocks = (file.blocks || []).map((block) => {
      const assessment = blocksById.get(block.id) || { id: block.id, assessment: "not-reviewed", summary: "" };
      return {
        ...block,
        assessment: assessment.assessment,
        assessmentSummary: assessment.summary,
        findings: (findingsByFile.get(file.path) || []).filter((finding) => finding.blockId === block.id),
      };
    });
    const reviewedBlocks = blocks.filter((block) => block.assessment !== "not-reviewed").length;
    const content = file.contentOmitted
      ? null
      : {
          old: readSnapshot(root, context.runId, file.snapshot?.old),
          new: readSnapshot(root, context.runId, file.snapshot?.new),
        };
    return {
      id: file.id,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      statusCode: file.statusCode,
      language: file.language,
      binary: file.binary,
      tooLarge: file.tooLarge,
      contentOmitted: file.contentOmitted,
      additions: file.additions,
      deletions: file.deletions,
      oldBytes: file.oldBytes,
      newBytes: file.newBytes,
      lineCount: file.lineCount,
      lenses: file.lenses || [],
      lensReasons: file.lensReasons || {},
      warnings: file.warnings || [],
      blocks,
      fileLevelFindings: (findingsByFile.get(file.path) || []).filter((finding) => !finding.blockId),
      findings: findingsByFile.get(file.path) || [],
      coveragePct: blocks.length ? Math.round((reviewedBlocks / blocks.length) * 100) : 100,
      reviewedBlocks,
      totalBlocks: blocks.length,
      fileReview,
      content,
    };
  });

  const allFindings = sortFindings(review.findings || []).map((finding) => {
    const file = files.find((entry) => entry.path === finding.file);
    return {
      ...finding,
      fileStatus: file?.status || "unknown",
      language: file?.language || "text",
    };
  });

  const riskCounts = { low: 0, medium: 0, high: 0 };
  for (const file of files) {
    const risk = file.fileReview?.risk || "low";
    riskCounts[risk] = (riskCounts[risk] || 0) + 1;
  }

  const flow = review.flow || buildFallbackFlow(context, review, files);
  const coveragePct = validation.stats.coveragePct;
  const stats = {
    files: files.length,
    additions: context.stats.additions,
    deletions: context.stats.deletions,
    blocks: context.stats.blocks,
    textFiles: context.stats.textFiles,
    binaryFiles: context.stats.binaryFiles,
    byStatus: context.stats.byStatus,
    findings: allFindings.length,
    severityCounts: validation.stats.severityCounts,
    lensCounts: validation.stats.lensCounts,
    assessmentCounts: validation.stats.assessmentCounts,
    totalBlocks: validation.stats.totalBlocks,
    reviewedBlocks: validation.stats.reviewedBlocks,
    coveragePct,
    riskCounts,
    resolved: validation.stats.resolved.length,
    new: iteration.delta.counts.new,
    carried: iteration.delta.counts.carried,
    unverified: iteration.delta.counts.unverified,
    draft,
  };

  return {
    schemaVersion: 1,
    meta: {
      runId: context.runId,
      iteration: context.iteration,
      createdAt: context.createdAt,
      renderedAt: isoNow(),
      draft,
      generator: "code-review",
      archived: Boolean(archived),
      repo: context.repo,
      scope: context.scope,
      root: context.repo.root,
    },
    summary: {
      verdict: review.verdict,
      headline: review.headline,
      overview: review.overview,
      iterationNote: review.iterationNote,
      risks: review.risks || [],
      nextActions: review.nextActions || [],
    },
    stats,
    files,
    findings: allFindings,
    flow,
    iteration,
    lensCatalog: context.lenses,
    artifactBase,
    flags: {
      draft,
      hasPrevious: Boolean(iteration.previous),
    },
  };
}


function timelineSummary(entry, current) {
  if (current) return "Current review.";
  const parts = [];
  if (entry.findings?.open) parts.push(`${entry.findings.open} open`);
  if (entry.findings?.resolved) parts.push(`${entry.findings.resolved} resolved`);
  return parts.join(" · ") || "Review refreshed.";
}

export function renderRun({ root, runId, draft = false, open = false }) {
  const run = loadRun(root, runId);
  const context = run.context;
  const review = run.review;
  if (!review) throw new ReviewError(`No review.json for run ${runId}. Fill the scaffold first.`);

  const history = loadHistory(root);
  const previousEntry = context.previous?.runId
    ? (history.runs || []).find((entry) => entry.id === context.previous.runId) || null
    : null;
  let previousReview = null;
  if (previousEntry) {
    try {
      const previousRun = loadRun(root, previousEntry.id);
      previousReview = previousRun.review;
    } catch {
      previousReview = null;
    }
  }

  const fallbackSkillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const lensConfig = loadLensConfig(context.skillRoot || fallbackSkillRoot);
  const validation = validateReview({
    review,
    context,
    previousReview,
    root,
    lensConfig,
    draft,
  });

  if (validation.errors.length > 0 && !draft) {
    throw new ReviewError(formatIssues(validation.errors, validation.warnings), 2, validation);
  }
  if (!validation.review) {
    throw new ReviewError("review.json is structurally invalid and cannot be rendered.", 2, validation);
  }

  if (validation.errors.length > 0) {
    console.warn(formatIssues(validation.errors, validation.warnings));
    console.warn("Rendering in draft mode: unresolved coverage and reconciliation errors are visible in the artifact.");
  } else if (validation.warnings.length > 0) {
    console.warn(formatIssues([], validation.warnings));
  }

  const normalReview = validation.review;
  const updatedHistory = {
    ...history,
    runs: (history.runs || []).map((entry) => {
      if (entry.id !== runId) return entry;
      return {
        ...entry,
        status: "rendered",
        renderedAt: isoNow(),
        verdict: normalReview.verdict,
        headline: normalReview.headline,
        review: {
          verdict: normalReview.verdict,
          headline: normalReview.headline,
          coveragePct: validation.stats.coveragePct,
          findings: {
            open: validation.stats.findingsCount,
            ...validation.stats.severityCounts,
            resolved: validation.stats.resolved.length,
            unverified: validation.stats.unresolvedPrevious.length,
            new: 0,
            carried: 0,
          },
        },
        artifact: toPosix(path.relative(root, path.join(runDir(root, runId), "review.html"))),
      };
    }),
  };

  const currentEntry = (updatedHistory.runs || []).find((entry) => entry.id === runId);
  const iteration = buildIteration({
    context,
    previousEntry,
    previousReview,
    review: normalReview,
    validation,
    history: updatedHistory,
    currentEntry,
  });

  // The summary counts need the finding delta, which is computed by buildIteration.
  if (currentEntry) {
    currentEntry.review.findings.new = iteration.delta.counts.new;
    currentEntry.review.findings.carried = iteration.delta.counts.carried;
    currentEntry.review.findings.unverified = iteration.delta.counts.unverified;
  }

  const latest = (updatedHistory.runs || [])
    .filter((entry) => entry.status === "rendered")
    .sort((a, b) => b.iteration - a.iteration)[0];
  if (!latest || context.iteration >= latest.iteration) {
    updatedHistory.latestRunId = runId;
  }

  const assetsRoot = path.join(context.skillRoot || fallbackSkillRoot, "assets");
  const template = readText(path.join(assetsRoot, "review-template.html"));
  const stylesheet = readText(path.join(assetsRoot, "review.css"));
  const application = readText(path.join(assetsRoot, "review-app.js"));
  const vendorSource = path.join(assetsRoot, "vendor", "pierre-diffs.js");
  if (!pathExists(vendorSource)) {
    throw new ReviewError("The local code renderer is missing. Reinstall the skill.");
  }
  const vendorTarget = path.join(stateDir(root), "vendor", "pierre-diffs.js");
  ensureDir(path.dirname(vendorTarget));
  if (!pathExists(vendorTarget) || fs.statSync(vendorTarget).size !== fs.statSync(vendorSource).size) {
    fs.copyFileSync(vendorSource, vendorTarget);
  }
  const vendorLicense = path.join(assetsRoot, "vendor", "pierre-diffs.LICENSE.md");
  if (pathExists(vendorLicense)) {
    fs.copyFileSync(vendorLicense, path.join(stateDir(root), "vendor", "pierre-diffs.LICENSE.md"));
  }
  const artifactPath = path.join(runDir(root, runId), "review.html");
  const currentPath = path.join(stateDir(root), "review.html");

  const writeArtifact = (artifactBase, destination, archived = false) => {
    const data = buildReviewData({
      root,
      run,
      context,
      review: normalReview,
      validation,
      iteration,
      history: updatedHistory,
      artifactBase,
      draft,
      archived,
    });
    const title = `Code review · ${context.repo.name} · iteration ${context.iteration}`;
    const vendorRel = toPosix(path.relative(path.dirname(destination), vendorTarget));
    let html = template
      .replace("/*__CSS__*/", () => stylesheet)
      .replace("/*__APP_JS__*/", () => application)
      .replace("__DIFFS_VENDOR__", () => vendorRel)
      .replace("<!--__REVIEW_DATA__-->", () => jsonForHtml(data))
      .replace(/__PAGE_TITLE__/g, () => title.replace(/</g, "&lt;"));
    ensureDir(path.dirname(destination));
    writeText(destination, html);
    return data;
  };

  // The archived copy links to sibling runs; the live copy links into runs/.
  writeArtifact("../", artifactPath, true);
  writeArtifact("runs/", currentPath, false);

  updatedHistory.runs = (updatedHistory.runs || []).map((entry) => (
    entry.id === runId ? { ...entry, artifact: toPosix(path.relative(root, artifactPath)) } : entry
  ));
  saveHistory(root, updatedHistory);
  writeCurrent(root, {
    runId,
    iteration: context.iteration,
    renderedAt: isoNow(),
    artifact: "review.html",
  });

  return {
    runId,
    iteration: context.iteration,
    artifactPath: currentPath,
    archivePath: artifactPath,
    validation,
    data: {
      stats: {
        files: context.stats.files,
        additions: context.stats.additions,
        deletions: context.stats.deletions,
        blocks: context.stats.blocks,
      },
      findings: {
        open: validation.stats.findingsCount,
        ...validation.stats.severityCounts,
        resolved: validation.stats.resolved.length,
        new: iteration.delta.counts.new,
        carried: iteration.delta.counts.carried,
        unverified: iteration.delta.counts.unverified,
      },
      coveragePct: validation.stats.coveragePct,
      verdict: normalReview.verdict,
      headline: normalReview.headline,
      timeline: iteration.timeline.length,
    },
  };
}
