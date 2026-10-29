import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  displayPath,
  readJson,
  readText,
  removeRecursive,
  writeJson,
  writeText,
} from "../scripts/lib/util.mjs";
import {
  collectReview,
  historyPath,
  loadHistory,
  loadRun,
  runDir,
  stateDir,
} from "../scripts/lib/context.mjs";
import { getRepoInfo, listChangedFiles, resolveScope } from "../scripts/lib/git.mjs";
import { loadLensConfig } from "../scripts/lib/lenses.mjs";
import { validateReview } from "../scripts/lib/schema.mjs";
import { renderRun } from "../scripts/lib/render.mjs";
import { createFixture } from "./fixture.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(process.env.TEMP || process.env.TMP || ".", "opencode", "code-review-selftest");

function genericReview(context) {
  return {
    schemaVersion: 1,
    verdict: "ship",
    headline: "Synthetic review for the self-test.",
    overview: "Every block is assessed and no findings are open. This fixture is used to exercise the pipeline.",
    iterationNote: "",
    risks: [],
    nextActions: [],
    flow: {
      title: "Test flow",
      subtitle: "A minimal flow used by the self-test.",
      nodes: [
        { id: "input", label: "Changed files", kind: "input", layer: 0, detail: "", files: [], findingIds: [] },
        { id: "output", label: "Verdict", kind: "output", layer: 1, detail: "", files: [], findingIds: [] },
      ],
      edges: [{ from: "input", to: "output", label: "reviewed", kind: "control" }],
    },
    findings: [],
    resolutions: [],
    fileReviews: context.files.map((file) => ({
      file: file.path,
      risk: "low",
      summary: file.binary ? "Binary asset; no line-level review." : "Reviewed the changed file.",
      blocks: (file.blocks || []).map((block) => ({
        id: block.id,
        assessment: "sound",
        summary: "Reviewed this block; no issue found.",
      })),
    })),
  };
}

function addBlocker(review, context) {
  const file = context.files.find((entry) => entry.path === "src/orders/orderService.ts");
  const block = file.blocks[0];
  const copy = structuredClone(review);
  copy.verdict = "ship";
  copy.findings.push({
    id: "F-001",
    file: file.path,
    blockId: block.id,
    side: "new",
    startLine: block.startLine,
    endLine: block.endLine,
    severity: "blocker",
    lens: "database",
    tags: ["test"],
    title: "Synthetic blocker",
    detail: "A blocker used to test verdict validation.",
    suggestion: "Fix the blocker.",
    suggestionCode: "",
    confidence: "high",
    evidence: [],
  });
  const fileReview = copy.fileReviews.find((entry) => entry.file === file.path);
  fileReview.blocks[0].assessment = "needs-work";
  return copy;
}

try {
  const root = createFixture({ dir: TEST_ROOT });
  const first = collectReview({ root, skillRoot: SKILL_ROOT, options: { untracked: true, fresh: true } });
  assert.equal(first.empty, false, "fixture has changes");
  assert.equal(first.iteration, 1, "first iteration");
  assert.equal(first.context.files.length, 10, "all changed files collected");
  assert.equal(first.context.stats.binaryFiles, 1, "binary file detected");

  const byPath = new Map(first.context.files.map((file) => [file.path, file]));
  assert.equal(byPath.get("db/migrations/004_add_order_status.sql").lenses.includes("database"), true, "database lens routes migrations");
  assert.equal(byPath.get("src/orders/orderService.ts").lenses.includes("database"), true, "database lens routes query code");
  assert.equal(byPath.get("src/utils/formatMoney.ts").lenses.includes("database"), false, "formatMoney is not a database file");
  assert.equal(byPath.get("assets/logo.png").binary, true, "binary has no text blocks");
  assert.equal(byPath.get("assets/logo.png").blocks.length, 0, "binary has no blocks");
  assert.equal(byPath.get("src/orders/orderService.ts").blocks.length >= 3, true, "large rewrite is split into several blocks");
  assert.equal(byPath.get("src/orders/orderService.ts").blocks.every((block) => block.id), true, "blocks have ids");
  assert.equal(byPath.get("src/legacy/legacyPricing.ts").status, "deleted", "deleted file status");
  assert.equal(byPath.get("src/utils/formatMoney.ts").status, "added", "added file status");

  const scaffold = readJson(path.join(first.dir, "review.json"));
  assert.equal(scaffold.fileReviews.every((file) => file.blocks.every((block) => block.assessment === "not-reviewed")), true, "scaffold starts unreviewed");

  const lensConfig = loadLensConfig(SKILL_ROOT);
  const scaffoldValidation = validateReview({
    review: scaffold,
    context: first.context,
    previousReview: null,
    root,
    lensConfig,
    draft: false,
  });
  assert.equal(scaffoldValidation.errors.length > 0, true, "unreviewed scaffold fails validation");

  const review = genericReview(first.context);
  const cleanValidation = validateReview({
    review,
    context: first.context,
    previousReview: null,
    root,
    lensConfig,
    draft: false,
  });
  assert.deepEqual(cleanValidation.errors, [], "generic complete review passes validation");
  writeJson(path.join(first.dir, "review.json"), review);
  const renderedFirst = renderRun({ root, runId: first.runId });
  assert.equal(fs.existsSync(renderedFirst.artifactPath), true, "current artifact written");
  assert.equal(fs.existsSync(renderedFirst.archivePath), true, "archive artifact written");
  const html = readText(renderedFirst.artifactPath);
  assert.equal(html.includes('id="review-data"'), true, "artifact carries review data");
  assert.equal(html.includes("__REVIEW_DATA__"), false, "artifact data placeholder replaced");
  assert.equal(html.includes("__APP_JS__"), false, "artifact app placeholder replaced");
  assert.equal(html.includes("__CSS__"), false, "artifact CSS placeholder replaced");

  // Scope parsing without mutating history.
  const repo = getRepoInfo(root);
  const stagedScope = resolveScope({ root, staged: true });
  const stagedFiles = listChangedFiles(root, stagedScope).map((file) => file.path);
  assert.equal(stagedFiles.includes("src/orders/orderRepository.ts"), true, "staged scope includes staged repository change");
  assert.equal(stagedFiles.includes("src/orders/orderService.ts"), false, "staged scope excludes unstaged checkout rewrite");
  const pathScope = resolveScope({ root, paths: ["src/orders/orderService.ts"] });
  const pathFiles = listChangedFiles(root, pathScope).map((file) => file.path);
  assert.deepEqual(pathFiles, ["src/orders/orderService.ts"], "path filter narrows the change set");
  const baseScope = resolveScope({ root, base: "HEAD" });
  assert.equal(listChangedFiles(root, baseScope).length, 10, "base HEAD merge-base reviews the working tree");
  const emptyScope = resolveScope({ root, range: "HEAD..HEAD" });
  assert.equal(listChangedFiles(root, emptyScope).length, 0, "empty commit range has no files");
  const rootCommitScope = resolveScope({ root, commit: "HEAD" });
  assert.equal(listChangedFiles(root, rootCommitScope).length > 0, true, "root commit diff is supported");
  assert.equal(readText(path.join(root, ".git", "info", "exclude")).includes(".code-review/"), true, "review state is locally excluded");

  // Iteration 2: one small edit should become the next iteration with a code delta.
  writeText(path.join(root, "src/orders/orderService.ts"), `${readText(path.join(root, "src/orders/orderService.ts"))}\n// iteration two marker\n`);
  const second = collectReview({ root, skillRoot: SKILL_ROOT, options: { untracked: true } });
  assert.equal(second.empty, false, "iteration two has changes");
  assert.equal(second.iteration, 2, "iteration increments");
  assert.equal(second.previous?.runId, first.runId, "previous run is linked");
  assert.equal(second.previous?.codeDelta?.totals.filesChanged >= 1, true, "code delta records changed files");
  const review2 = genericReview(second.context);
  writeJson(path.join(second.dir, "review.json"), review2);
  renderRun({ root, runId: second.runId });
  const history = loadHistory(root);
  assert.equal(history.latestRunId, second.runId, "latest run updates");
  const renderedRuns = history.runs.filter((run) => run.status === "rendered");
  assert.equal(renderedRuns.length, 2, "both iterations are recorded");
  assert.equal(renderedRuns.every((run) => run.artifact), true, "rendered runs have archives");

  // Validation: a blocker cannot ship.
  const blockerReview = addBlocker(review, first.context);
  const blockerShip = validateReview({
    review: blockerReview,
    context: first.context,
    previousReview: null,
    root,
    lensConfig,
    draft: false,
  });
  assert.equal(blockerShip.errors.some((issue) => issue.location === "verdict"), true, "blocker cannot ship");
  blockerShip.review.verdict = "blocked";
  const blocked = validateReview({
    review: { ...blockerReview, verdict: "blocked" },
    context: first.context,
    previousReview: null,
    root,
    lensConfig,
    draft: false,
  });
  assert.equal(blocked.errors.some((issue) => issue.location === "verdict"), false, "blocked verdict accepts a blocker");

  // Validation: missing coverage.
  const missingBlock = structuredClone(review);
  missingBlock.fileReviews.find((file) => file.file === "src/orders/orderService.ts").blocks.pop();
  const coverage = validateReview({
    review: missingBlock,
    context: first.context,
    previousReview: null,
    root,
    lensConfig,
    draft: false,
  });
  assert.equal(coverage.errors.some((issue) => issue.message.includes("Missing assessment")), true, "missing block coverage fails");

  // Validation: dangling flow edge.
  const badFlow = structuredClone(review);
  badFlow.flow.edges.push({ from: "input", to: "does-not-exist", label: "", kind: "data" });
  const flowValidation = validateReview({
    review: badFlow,
    context: first.context,
    previousReview: null,
    root,
    lensConfig,
    draft: false,
  });
  assert.equal(flowValidation.errors.some((issue) => issue.location.startsWith("flow.edges")), true, "dangling flow edge fails");

  // Validation: previous findings must be carried or resolved.
  const previousReview = {
    findings: [{ id: "F-900", file: "src/orders/orderService.ts", title: "Old issue", severity: "medium", lens: "fowler", blockId: null, side: "new", startLine: null, endLine: null }],
  };
  const unresolved = validateReview({
    review,
    context: first.context,
    previousReview,
    root,
    lensConfig,
    draft: false,
  });
  assert.equal(unresolved.errors.some((issue) => issue.message.includes("F-900")), true, "dropped previous finding fails");
  const withResolution = structuredClone(review);
  withResolution.resolutions.push({ findingId: "F-900", status: "fixed", note: "Closed in this iteration." });
  const resolvedValidation = validateReview({
    review: withResolution,
    context: first.context,
    previousReview,
    root,
    lensConfig,
    draft: false,
  });
  assert.deepEqual(resolvedValidation.errors, [], "explicit resolution closes the previous finding");

  console.log("self-test passed");
  console.log(`fixture: ${root}`);
  console.log(`runs: ${first.runId}, ${second.runId}`);
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
