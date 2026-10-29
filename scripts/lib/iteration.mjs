function severityCounts(findings) {
  const counts = {
    blocker: 0, high: 0, medium: 0, low: 0, nit: 0, question: 0, praise: 0,
  };
  for (const finding of findings || []) {
    if (Object.prototype.hasOwnProperty.call(counts, finding.severity)) counts[finding.severity] += 1;
  }
  return counts;
}

export function computeFindingDelta(currentReview, previousReview, resolved) {
  const currentFindings = currentReview.findings || [];
  const previousFindings = previousReview?.findings || [];
  const previousById = new Map(previousFindings.map((finding) => [finding.id, finding]));
  const currentById = new Map(currentFindings.map((finding) => [finding.id, finding]));
  const resolvedById = new Map((resolved || []).map((finding) => [finding.id, finding]));

  const statusById = {};
  const newFindings = [];
  const carriedFindings = [];
  const changedFindings = [];

  for (const finding of currentFindings) {
    const previous = previousById.get(finding.id);
    if (!previous) {
      newFindings.push(finding);
      statusById[finding.id] = { status: "new" };
      continue;
    }
    const changed = previous.severity !== finding.severity || previous.title !== finding.title;
    if (changed) changedFindings.push({ finding, previous });
    else carriedFindings.push(finding);
    statusById[finding.id] = {
      status: changed ? "changed" : "carried",
      previousId: previous.id,
      previousSeverity: previous.severity,
      previousTitle: previous.title,
    };
  }

  const removed = [];
  const unverified = [];
  for (const previous of previousFindings) {
    if (currentById.has(previous.id)) continue;
    if (resolvedById.has(previous.id)) {
      removed.push({ ...previous, ...resolvedById.get(previous.id) });
      continue;
    }
    unverified.push(previous);
  }

  return {
    statusById,
    newFindings,
    carriedFindings,
    changedFindings,
    resolved: resolved || [],
    unverified,
    counts: {
      new: newFindings.length,
      carried: carriedFindings.length + changedFindings.length,
      changed: changedFindings.length,
      resolved: (resolved || []).length,
      unverified: unverified.length,
      open: currentFindings.length,
    },
  };
}

function timelineEntryFromRun(run) {
  const review = run.review || {};
  const counts = review.findings || {};
  return {
    id: run.id,
    iteration: run.iteration,
    createdAt: run.createdAt,
    verdict: review.verdict || run.verdict || "unknown",
    headline: review.headline || run.headline || "",
    findings: {
      open: counts.open ?? 0,
      blocker: counts.blocker ?? 0,
      high: counts.high ?? 0,
      resolved: counts.resolved ?? 0,
      new: counts.new ?? 0,
    },
    coveragePct: review.coveragePct ?? 0,
    stats: run.stats || {},
    artifact: run.artifact || null,
    status: run.status,
  };
}

export function buildTimeline(history, current) {
  const runs = (history.runs || [])
    .filter((run) => run.status === "rendered" && run.iteration <= current.iteration && run.id !== current.id)
    .sort((a, b) => a.iteration - b.iteration)
    .map(timelineEntryFromRun);
  const currentEntry = {
    id: current.id,
    iteration: current.iteration,
    createdAt: current.createdAt,
    verdict: current.verdict,
    headline: current.headline,
    findings: current.findings,
    coveragePct: current.coveragePct,
    stats: current.stats,
    artifact: current.artifact,
    status: "rendered",
    current: true,
  };
  return [...runs, currentEntry].slice(-8);
}

export function buildIteration({
  context,
  previousEntry,
  previousReview,
  review,
  validation,
  history,
  currentEntry,
}) {
  const delta = computeFindingDelta(review, previousReview, validation.stats.resolved);
  const codeDelta = context.previous?.codeDelta || null;
  const timeline = buildTimeline(history, {
    id: context.runId,
    iteration: context.iteration,
    createdAt: context.createdAt,
    verdict: review.verdict,
    headline: review.headline,
    findings: {
      open: review.findings.length,
      ...validation.stats.severityCounts,
      resolved: validation.stats.resolved.length,
      new: delta.counts.new,
      unverified: delta.counts.unverified,
    },
    coveragePct: validation.stats.coveragePct,
    stats: context.stats,
    artifact: currentEntry?.artifact || null,
  });

  const autoNote = !previousEntry
    ? "Baseline review. This iteration establishes the findings and coverage the next iteration will be compared against."
    : [
        `${delta.counts.new} new`,
        `${delta.counts.resolved} resolved`,
        `${delta.counts.carried} carried`,
        delta.counts.unverified ? `${delta.counts.unverified} unverified` : null,
      ].filter(Boolean).join(" · ");

  return {
    previous: previousEntry
      ? {
          id: previousEntry.id,
          iteration: previousEntry.iteration,
          verdict: previousReview?.verdict || previousEntry.review?.verdict || "unknown",
          headline: previousReview?.headline || "",
          scopeLabel: previousEntry.scope?.label || "",
          scopeChanged: Boolean(context.previous?.scopeChanged),
        }
      : null,
    delta: {
      statusById: delta.statusById,
      resolved: delta.resolved,
      counts: delta.counts,
      code: codeDelta,
      note: review.iterationNote || autoNote,
      verdictChange: previousReview
        ? { from: previousReview.verdict, to: review.verdict }
        : null,
    },
    timeline,
    sparkline: timeline.map((entry) => ({
      iteration: entry.iteration,
      open: entry.findings.open,
      resolved: entry.findings.resolved,
      new: entry.findings.new,
      verdict: entry.verdict,
    })),
    coverage: {
      totalBlocks: validation.stats.totalBlocks,
      reviewedBlocks: validation.stats.reviewedBlocks,
      pct: validation.stats.coveragePct,
    },
  };
}

