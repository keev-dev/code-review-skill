import fs from "node:fs";
import path from "node:path";
import { pct } from "./util.mjs";

export const SEVERITIES = ["blocker", "high", "medium", "low", "nit", "question", "praise"];
export const ASSESSMENTS = ["sound", "concern", "needs-work", "question", "not-reviewed"];
export const VERDICTS = ["ship", "ship-with-fixes", "needs-work", "blocked"];
export const RISKS = ["low", "medium", "high"];
export const CONFIDENCES = ["high", "medium", "low"];
export const FLOW_NODE_KINDS = ["input", "transform", "output", "store", "external", "decision", "event", "ui"];
export const FLOW_EDGE_KINDS = ["data", "control", "event", "dependency"];
export const RESOLUTION_STATUSES = ["fixed", "dismissed", "invalid", "duplicate"];

const SEVERITY_WEIGHT = { blocker: 6, high: 5, medium: 4, low: 3, question: 2, nit: 1, praise: 0 };

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isNonEmptyString(value) {
  return asString(value) !== "";
}

function asInt(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
}

function intersects(startA, endA, startB, endB) {
  return Math.max(startA, startB) <= Math.min(endA, endB);
}

export function validateReview({
  review,
  context,
  previousReview = null,
  root,
  lensConfig,
  draft = false,
}) {
  const errors = [];
  const warnings = [];
  const error = (location, message) => errors.push({ location, message, severity: "error" });
  const warning = (location, message) => warnings.push({ location, message, severity: "warning" });

  if (!isObject(review)) {
    return {
      errors: [{ location: "review", message: "review.json must contain a JSON object.", severity: "error" }],
      warnings: [],
      review: null,
      stats: null,
    };
  }

  if (review.schemaVersion !== 1) {
    error("schemaVersion", "schemaVersion must be 1.");
  }

  const fileMap = new Map((context.files || []).map((file) => [file.path, file]));
  const lensIds = new Set(Object.keys(lensConfig.lenses || {}));

  // ---------------------------------------------------------------- summary
  const verdict = asString(review.verdict);
  if (!VERDICTS.includes(verdict)) {
    error("verdict", `verdict must be one of: ${VERDICTS.join(", ")}.`);
  }
  const headline = asString(review.headline);
  if (!headline) error("headline", "headline is required.");
  else if (headline.length > 180) error("headline", "headline must be 180 characters or fewer.");
  else if (/^review in progress/i.test(headline)) error("headline", "Replace the scaffold headline with the actual verdict.");
  const overview = asString(review.overview);
  if (!overview) error("overview", "overview is required.");
  else if (overview.length > 900) error("overview", "overview must be 900 characters or fewer.");
  else if (/^replace this with/i.test(overview)) error("overview", "Replace the scaffold overview with the actual summary.");
  const iterationNote = asString(review.iterationNote);
  if (iterationNote.length > 700) error("iterationNote", "iterationNote must be 700 characters or fewer.");

  const risks = [];
  if (review.risks !== undefined) {
    if (!Array.isArray(review.risks)) error("risks", "risks must be an array.");
    else if (review.risks.length > 6) error("risks", "Use at most 6 risks.");
    else {
      review.risks.forEach((risk, index) => {
        const location = `risks[${index}]`;
        if (!isObject(risk)) return error(location, "Risk must be an object.");
        const title = asString(risk.title);
        const detail = asString(risk.detail);
        const severity = asString(risk.severity);
        if (!title) error(location + ".title", "Risk title is required.");
        if (!detail) error(location + ".detail", "Risk detail is required.");
        if (!SEVERITIES.includes(severity)) error(location + ".severity", `Risk severity must be one of: ${SEVERITIES.join(", ")}.`);
        const files = asStringArray(risk.files).map((file) => {
          if (!fileMap.has(file) && !fs.existsSync(path.join(root, file))) {
            warning(location + ".files", `Risk references a file that does not exist: ${file}`);
          }
          return file;
        });
        risks.push({ title, detail, severity, files });
      });
    }
  }

  const nextActions = [];
  if (review.nextActions !== undefined) {
    if (!Array.isArray(review.nextActions)) error("nextActions", "nextActions must be an array.");
    else if (review.nextActions.length > 6) error("nextActions", "Use at most 6 next actions.");
    else {
      review.nextActions.forEach((action, index) => {
        const location = `nextActions[${index}]`;
        if (!isObject(action)) return error(location, "Next action must be an object.");
        const label = asString(action.action);
        const priority = asInt(action.priority) ?? index + 1;
        if (!label) error(location + ".action", "Next action text is required.");
        if (priority < 1 || priority > 9) error(location + ".priority", "Priority must be between 1 and 9.");
        const file = action.file ? asString(action.file) : null;
        if (file && !fileMap.has(file) && !fs.existsSync(path.join(root, file))) {
          warning(location + ".file", `Next action references a file that does not exist: ${file}`);
        }
        nextActions.push({ action: label, priority, file, findingId: action.findingId ? asString(action.findingId) : null });
      });
      nextActions.sort((a, b) => a.priority - b.priority);
    }
  }

  // --------------------------------------------------------------- findings
  const findings = [];
  const findingById = new Map();
  const findingsByFile = new Map();
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  const lensCounts = {};

  if (!Array.isArray(review.findings)) {
    error("findings", "findings must be an array (use [] when there are none).");
  } else {
    review.findings.forEach((raw, index) => {
      const location = `findings[${index}]`;
      if (!isObject(raw)) return error(location, "Finding must be an object.");
      const id = asString(raw.id);
      if (!id) error(location + ".id", "Finding id is required (for example F-001).");
      else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) error(location + ".id", "Finding id may contain letters, numbers, dots, underscores, and dashes.");
      if (id && findingById.has(id)) error(location + ".id", `Duplicate finding id: ${id}`);
      const filePath = asString(raw.file);
      const file = fileMap.get(filePath);
      if (!file) error(location + ".file", `Unknown changed file: ${filePath || "(missing)"}`);
      const severity = asString(raw.severity);
      if (!SEVERITIES.includes(severity)) error(location + ".severity", `Severity must be one of: ${SEVERITIES.join(", ")}.`);
      const lens = asString(raw.lens);
      if (!lens) error(location + ".lens", "lens is required.");
      else if (!lensIds.has(lens)) error(location + ".lens", `Unknown lens "${lens}".`);
      const title = asString(raw.title);
      if (!title) error(location + ".title", "Title is required.");
      else if (title.length > 140) error(location + ".title", "Title must be 140 characters or fewer.");
      const detail = asString(raw.detail);
      if (!detail) error(location + ".detail", "Detail is required.");
      else if (detail.length > 1400) error(location + ".detail", "Detail must be 1400 characters or fewer.");
      const suggestion = asString(raw.suggestion);
      if (suggestion.length > 1400) error(location + ".suggestion", "Suggestion must be 1400 characters or fewer.");
      if (["blocker", "high"].includes(severity) && !suggestion) error(location + ".suggestion", "Blocker and high findings need an actionable suggestion.");
      const suggestionCode = typeof raw.suggestionCode === "string" ? raw.suggestionCode : "";
      if (suggestionCode.length > 5000) error(location + ".suggestionCode", "suggestionCode must be 5000 characters or fewer.");
      const confidence = asString(raw.confidence) || "high";
      if (!CONFIDENCES.includes(confidence)) error(location + ".confidence", `Confidence must be one of: ${CONFIDENCES.join(", ")}.`);
      const tags = asStringArray(raw.tags);

      const side = asString(raw.side) || (file?.status === "deleted" ? "old" : "new");
      if (side !== "old" && side !== "new") error(location + ".side", "side must be old or new.");

      let blockId = raw.blockId === undefined || raw.blockId === null ? null : asString(raw.blockId);
      let block = null;
      if (blockId && file) {
        block = (file.blocks || []).find((entry) => entry.id === blockId) || null;
        if (!block) error(location + ".blockId", `Unknown block ${blockId} in ${file.path}.`);
      }
      if (file && (file.blocks || []).length === 0) {
        if (blockId) error(location + ".blockId", "This file has no review blocks; use a file-level finding instead.");
        if (raw.startLine !== undefined || raw.endLine !== undefined) {
          error(location, "A file with no blocks can only carry file-level findings (omit startLine/endLine).");
        }
      }

      let startLine = asInt(raw.startLine);
      let endLine = asInt(raw.endLine);
      if (blockId) {
        if (startLine === null || endLine === null) {
          error(location, "A block finding needs startLine and endLine.");
        } else if (startLine < 1 || endLine < startLine) {
          error(location, "startLine/endLine are not a valid range.");
        } else if (file) {
          if (block) {
            let blockStart;
            let blockEnd;
            if (side === "old" && block.side === "old") {
              blockStart = Number(block.startLine);
              blockEnd = Number(block.endLine);
            } else if (side === "old") {
              blockStart = Number(block.oldStart ?? block.startLine);
              blockEnd = Number(block.oldEnd ?? block.endLine);
            } else {
              blockStart = Number(block.startLine);
              blockEnd = Number(block.endLine);
            }
            if (!intersects(startLine, endLine, blockStart, blockEnd)) {
              error(location, `Lines ${startLine}–${endLine} do not intersect ${blockId} (${blockStart}–${blockEnd}).`);
            }
          }
          const lineCount = side === "old"
            ? (file.snapshot?.oldLineCount ?? file.lineCount?.old ?? 0)
            : (file.snapshot?.newLineCount ?? file.lineCount?.new ?? 0);
          if (lineCount > 0) {
            if (endLine > lineCount) error(location, `endLine ${endLine} exceeds the ${side} file's ${lineCount} lines.`);
            if (startLine > lineCount) error(location, `startLine ${startLine} exceeds the ${side} file's ${lineCount} lines.`);
          } else if (!file.binary && !file.tooLarge) {
            error(location, `Cannot place a line finding on ${file.path}: no ${side} snapshot is available.`);
          }
        }
      } else {
        if (startLine !== null || endLine !== null) {
          warning(location, "File-level finding has line numbers but no blockId; the UI will show it at file level.");
        }
        startLine = null;
        endLine = null;
      }

      const evidence = [];
      if (raw.evidence !== undefined) {
        if (!Array.isArray(raw.evidence)) error(location + ".evidence", "evidence must be an array.");
        else {
          raw.evidence.forEach((item, evidenceIndex) => {
            const evidenceLocation = `${location}.evidence[${evidenceIndex}]`;
            if (!isObject(item)) return error(evidenceLocation, "Evidence must be an object.");
            const evidencePath = asString(item.path);
            if (!evidencePath) error(evidenceLocation + ".path", "Evidence path is required.");
            const line = asInt(item.line);
            if (item.line !== undefined && line === null) error(evidenceLocation + ".line", "Evidence line must be an integer.");
            if (evidencePath && !fs.existsSync(path.join(root, evidencePath))) {
              warning(evidenceLocation, `Evidence file does not exist now: ${evidencePath}`);
            }
            evidence.push({
              path: evidencePath,
              line: line === null ? null : line,
              note: asString(item.note),
            });
          });
        }
      }

      if (severity === "praise" && !suggestion) {
        // Praise is allowed to stand without a fix.
      }

      const finding = {
        id,
        file: filePath,
        blockId,
        side,
        startLine,
        endLine,
        severity,
        lens,
        tags,
        title,
        detail,
        suggestion,
        suggestionCode,
        confidence,
        evidence,
      };
      if (id && !findingById.has(id)) {
        findingById.set(id, finding);
        findings.push(finding);
        if (!findingsByFile.has(filePath)) findingsByFile.set(filePath, []);
        findingsByFile.get(filePath).push(finding);
        severityCounts[severity] = (severityCounts[severity] || 0) + 1;
        lensCounts[lens] = (lensCounts[lens] || 0) + 1;
      }
    });
  }

  // ----------------------------------------------------------- file reviews
  const fileReviews = [];
  const fileReviewByPath = new Map();
  const assessmentCounts = Object.fromEntries(ASSESSMENTS.map((assessment) => [assessment, 0]));
  let totalBlocks = 0;
  let reviewedBlocks = 0;

  if (!Array.isArray(review.fileReviews)) {
    error("fileReviews", "fileReviews must be an array.");
  } else {
    review.fileReviews.forEach((raw, index) => {
      const location = `fileReviews[${index}]`;
      if (!isObject(raw)) return error(location, "File review must be an object.");
      const filePath = asString(raw.file);
      const file = fileMap.get(filePath);
      if (!file) {
        error(location + ".file", `Unknown changed file: ${filePath || "(missing)"}`);
        return;
      }
      if (fileReviewByPath.has(filePath)) error(location + ".file", `Duplicate file review: ${filePath}`);
      const risk = asString(raw.risk) || "low";
      if (!RISKS.includes(risk)) error(location + ".risk", `risk must be one of: ${RISKS.join(", ")}.`);
      const summary = asString(raw.summary);
      if (!summary) error(location + ".summary", "A file summary is required.");
      else if (summary.length > 600) error(location + ".summary", "File summary must be 600 characters or fewer.");

      const reviewBlocks = new Map();
      if (raw.blocks !== undefined) {
        if (!Array.isArray(raw.blocks)) error(location + ".blocks", "blocks must be an array.");
        else {
          raw.blocks.forEach((blockRaw, blockIndex) => {
            const blockLocation = `${location}.blocks[${blockIndex}]`;
            if (!isObject(blockRaw)) return error(blockLocation, "Block assessment must be an object.");
            const blockId = asString(blockRaw.id);
            const contextBlock = (file.blocks || []).find((entry) => entry.id === blockId);
            if (!contextBlock) {
              error(blockLocation + ".id", `Unknown block ${blockId || "(missing)"} in ${file.path}.`);
              return;
            }
            if (reviewBlocks.has(blockId)) error(blockLocation + ".id", `Duplicate assessment for ${blockId}.`);
            const assessment = asString(blockRaw.assessment) || "not-reviewed";
            if (!ASSESSMENTS.includes(assessment)) error(blockLocation + ".assessment", `assessment must be one of: ${ASSESSMENTS.join(", ")}.`);
            const blockSummary = asString(blockRaw.summary);
            if (assessment !== "not-reviewed" && !blockSummary) error(blockLocation + ".summary", "Reviewed blocks need a short summary.");
            if (blockSummary.length > 500) error(blockLocation + ".summary", "Block summary must be 500 characters or fewer.");
            if (assessment === "not-reviewed" && !draft) {
              error(blockLocation + ".assessment", `${blockId} is not reviewed. Review it or run render with --draft.`);
            }
            reviewBlocks.set(blockId, { id: blockId, assessment, summary: blockSummary });
            assessmentCounts[assessment] = (assessmentCounts[assessment] || 0) + 1;
          });
        }
      }

      for (const block of file.blocks || []) {
        totalBlocks += 1;
        if (reviewBlocks.has(block.id)) {
          const assessment = reviewBlocks.get(block.id).assessment;
          if (assessment !== "not-reviewed") reviewedBlocks += 1;
          const blockFindings = (findingsByFile.get(file.path) || []).filter((finding) => finding.blockId === block.id);
          if (["sound", "question"].includes(assessment) && blockFindings.some((finding) => ["blocker", "high"].includes(finding.severity))) {
            warning(location, `${block.id} is marked ${assessment} but has a high-severity finding.`);
          }
        } else if (!draft) {
          error(location + ".blocks", `Missing assessment for ${block.id} (lines ${block.startLine}–${block.endLine}).`);
        } else {
          warning(location + ".blocks", `Missing assessment for ${block.id}; rendering it as unreviewed.`);
        }
      }

      const normalized = {
        file: file.path,
        risk,
        summary,
        blocks: (file.blocks || []).map((block) => reviewBlocks.get(block.id) || {
          id: block.id,
          assessment: "not-reviewed",
          summary: "",
        }),
      };
      fileReviews.push(normalized);
      fileReviewByPath.set(file.path, normalized);
    });
  }

  for (const file of context.files || []) {
    if (!fileReviewByPath.has(file.path)) {
      error("fileReviews", `Missing file review for ${file.path}.`);
    }
  }

  for (const fileReview of fileReviews) {
    const fileFindings = findings.filter((finding) => finding.file === fileReview.file);
    const severe = fileFindings.some((finding) => ["blocker", "high"].includes(finding.severity));
    if (severe && fileReview.risk === "low") {
      warning("fileReviews", `${fileReview.file} has a high/blocker finding but is marked low risk.`);
    }
  }

  // ------------------------------------------------------------ resolutions
  const previousFindings = new Map(
    (previousReview?.findings || []).map((finding) => [finding.id, finding]),
  );
  const resolutions = [];
  const resolved = [];
  const resolvedIds = new Set();

  if (review.resolutions !== undefined) {
    if (!Array.isArray(review.resolutions)) error("resolutions", "resolutions must be an array.");
    else {
      if (!previousReview && review.resolutions.length > 0) {
        error("resolutions", "This is the first review; there are no previous findings to resolve.");
      }
      review.resolutions.forEach((raw, index) => {
        const location = `resolutions[${index}]`;
        if (!isObject(raw)) return error(location, "Resolution must be an object.");
        const findingId = asString(raw.findingId);
        const status = asString(raw.status);
        const note = asString(raw.note);
        if (!findingId) error(location + ".findingId", "findingId is required.");
        if (!RESOLUTION_STATUSES.includes(status)) error(location + ".status", `status must be one of: ${RESOLUTION_STATUSES.join(", ")}.`);
        if (!note) error(location + ".note", "A short resolution note is required.");
        if (findingId && !previousFindings.has(findingId)) {
          error(location + ".findingId", `No previous finding with id ${findingId}.`);
        }
        if (findingId && findingById.has(findingId)) {
          error(location + ".findingId", `${findingId} is still present; do not resolve it in the same review. Carry it forward instead.`);
        }
        if (findingId && resolvedIds.has(findingId)) error(location + ".findingId", `Duplicate resolution for ${findingId}.`);
        if (findingId && previousFindings.has(findingId) && !resolvedIds.has(findingId)) {
          resolvedIds.add(findingId);
          const previous = previousFindings.get(findingId);
          resolved.push({
            ...previous,
            resolutionStatus: status,
            resolutionNote: note,
          });
          resolutions.push({ findingId, status, note });
        }
      });
    }
  }

  const unresolvedPrevious = [];
  for (const [id, finding] of previousFindings) {
    if (findingById.has(id) || resolvedIds.has(id)) continue;
    unresolvedPrevious.push(finding);
    if (!draft) {
      error("resolutions", `Previous finding ${id} (“${finding.title}”) is missing from this review. Carry it forward with the same id, or add a resolution for it.`);
    } else {
      warning("resolutions", `Previous finding ${id} was not reconciled.`);
    }
  }

  // ------------------------------------------------------------------ flow
  let flow = null;
  const rawFlow = review.flow;
  if (rawFlow !== undefined && rawFlow !== null) {
    if (!isObject(rawFlow)) {
      error("flow", "flow must be an object.");
    } else {
      const nodes = [];
      const nodeIds = new Set();
      if (rawFlow.nodes !== undefined && !Array.isArray(rawFlow.nodes)) error("flow.nodes", "flow.nodes must be an array.");
      else if (Array.isArray(rawFlow.nodes)) {
        if (rawFlow.nodes.length > 18) error("flow.nodes", "Use at most 18 flow nodes.");
        rawFlow.nodes.forEach((rawNode, index) => {
          const location = `flow.nodes[${index}]`;
          if (!isObject(rawNode)) return error(location, "Flow node must be an object.");
          const id = asString(rawNode.id);
          if (!id) error(location + ".id", "Flow node id is required.");
          else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) error(location + ".id", "Flow node id has invalid characters.");
          else if (nodeIds.has(id)) error(location + ".id", `Duplicate flow node id: ${id}`);
          const label = asString(rawNode.label);
          if (!label) error(location + ".label", "Flow node label is required.");
          else if (label.length > 60) error(location + ".label", "Flow node label must be 60 characters or fewer.");
          const kind = asString(rawNode.kind) || "transform";
          if (!FLOW_NODE_KINDS.includes(kind)) error(location + ".kind", `Flow node kind must be one of: ${FLOW_NODE_KINDS.join(", ")}.`);
          const detail = asString(rawNode.detail);
          if (detail.length > 400) error(location + ".detail", "Flow node detail must be 400 characters or fewer.");
          const files = asStringArray(rawNode.files).map((file) => {
            if (!fileMap.has(file) && !fs.existsSync(path.join(root, file))) {
              warning(location + ".files", `Flow node references a file that does not exist: ${file}`);
            }
            return file;
          });
          const findingIds = asStringArray(rawNode.findingIds).filter((findingId) => {
            if (!findingById.has(findingId)) {
              warning(location + ".findingIds", `Flow node references unknown finding ${findingId}.`);
              return false;
            }
            return true;
          });
          const layer = rawNode.layer === undefined ? null : asInt(rawNode.layer);
          if (rawNode.layer !== undefined && (layer === null || layer < 0 || layer > 12)) error(location + ".layer", "Flow node layer must be an integer from 0 to 12.");
          if (id && !nodeIds.has(id)) {
            nodeIds.add(id);
            nodes.push({ id, label, kind, detail, files, findingIds, layer });
          }
        });
      }

      const edges = [];
      if (rawFlow.edges !== undefined && !Array.isArray(rawFlow.edges)) error("flow.edges", "flow.edges must be an array.");
      else if (Array.isArray(rawFlow.edges)) {
        if (rawFlow.edges.length > 40) error("flow.edges", "Use at most 40 flow edges.");
        rawFlow.edges.forEach((rawEdge, index) => {
          const location = `flow.edges[${index}]`;
          if (!isObject(rawEdge)) return error(location, "Flow edge must be an object.");
          const from = asString(rawEdge.from);
          const to = asString(rawEdge.to);
          if (!nodeIds.has(from)) error(location + ".from", `Unknown flow node: ${from || "(missing)"}`);
          if (!nodeIds.has(to)) error(location + ".to", `Unknown flow node: ${to || "(missing)"}`);
          if (from && from === to) error(location, "A flow edge cannot point at itself.");
          const label = asString(rawEdge.label);
          if (label.length > 50) error(location + ".label", "Flow edge label must be 50 characters or fewer.");
          const kind = asString(rawEdge.kind) || "data";
          if (!FLOW_EDGE_KINDS.includes(kind)) error(location + ".kind", `Flow edge kind must be one of: ${FLOW_EDGE_KINDS.join(", ")}.`);
          if (from && to && nodeIds.has(from) && nodeIds.has(to) && from !== to) {
            edges.push({ from, to, label, kind });
          }
        });
      }

      if (nodes.length > 0) {
        flow = {
          title: asString(rawFlow.title) || "Change flow",
          subtitle: asString(rawFlow.subtitle),
          nodes,
          edges,
          source: "agent",
        };
      }
    }
  }
  if (!flow) {
    warning("flow", "No flow was authored. The overview will show a review-pipeline fallback graph; author flow.nodes for a real change-flow map.");
  }

  // ------------------------------------------------------------- reconcile
  if (nextActions.length > 0) {
    for (const action of nextActions) {
      if (action.findingId && !findingById.has(action.findingId)) {
        warning("nextActions", `Next action references unknown finding ${action.findingId}.`);
      }
    }
  }

  const blockerCount = severityCounts.blocker || 0;
  const highCount = severityCounts.high || 0;
  if (verdict === "ship" && blockerCount + highCount > 0) {
    error("verdict", "Cannot ship with blocker or high findings. Use needs-work or blocked.");
  }
  if (verdict === "ship-with-fixes" && blockerCount > 0) {
    error("verdict", "Cannot use ship-with-fixes while a blocker is open. Use blocked.");
  }
  if (verdict === "blocked" && blockerCount === 0) {
    warning("verdict", "Verdict is blocked but there is no blocker finding.");
  }
  if (verdict === "needs-work" && blockerCount + highCount === 0) {
    warning("verdict", "Verdict is needs-work but there are no high or blocker findings.");
  }

  const coveragePct = pct(reviewedBlocks, totalBlocks);
  const maxSeverity = findings.reduce((max, finding) => Math.max(max, SEVERITY_WEIGHT[finding.severity] || 0), 0);

  const normalizedReview = {
    schemaVersion: 1,
    verdict: VERDICTS.includes(verdict) ? verdict : "needs-work",
    headline,
    overview,
    iterationNote,
    risks,
    nextActions,
    flow,
    findings,
    fileReviews,
    resolutions,
  };

  return {
    errors,
    warnings,
    review: normalizedReview,
    stats: {
      severityCounts,
      lensCounts,
      assessmentCounts,
      totalBlocks,
      reviewedBlocks,
      coveragePct,
      findingsCount: findings.length,
      blockerCount,
      highCount,
      maxSeverity,
      resolved,
      unresolvedPrevious,
      riskByFile: Object.fromEntries(fileReviews.map((file) => [file.file, file.risk])),
    },
  };
}

export function formatIssues(errors, warnings) {
  const lines = [];
  if (errors.length) {
    lines.push(`Review validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}):`);
    for (const issue of errors) lines.push(`  ✗ ${issue.location}: ${issue.message}`);
  }
  if (warnings.length) {
    lines.push(`Warnings (${warnings.length}):`);
    for (const issue of warnings) lines.push(`  ! ${issue.location}: ${issue.message}`);
  }
  return lines.join("\n");
}

export function assertValid(result) {
  if (result.errors.length > 0) {
    const error = new Error(formatIssues(result.errors, result.warnings));
    error.code = 2;
    error.details = result;
    throw error;
  }
}
