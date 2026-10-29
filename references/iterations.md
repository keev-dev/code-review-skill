# Iterations

Each `collect` creates a run. A run is one **iteration** of the review. The first run is the baseline; every later run is compared with the latest rendered run before it. The artifact keeps the history so a stakeholder can see movement, not just a snapshot.

## The lifecycle

```
collect ──► run N (context + snapshots + scaffold)
            │
            ├─ agent authors review.json
            │
            └─ render ──► .code-review/review.html
                         .code-review/runs/<id>/review.html (archive)
                         history.json updated
```

The live artifact path is stable:

```
.code-review/review.html
```

The local review server serves that path. Re-rendering writes the new page. The browser reloads when you refresh the tab.

## What collect computes

- **Iteration number** — the highest recorded iteration + 1, or `1` with `--fresh`.
- **Previous run** — the latest rendered run with a lower iteration.
- **Previous findings** — IDs, files, severities, titles, blocks, and line anchors. They are in `context.previous.findings`.
- **Code delta** — a line diff between the previous run's `.new` snapshots and the current run's `.new` snapshots. It reports changed files, additions, deletions, and files that left the change set.
- **Scope change** — whether the old/new refs or scope kind changed between iterations.

The code delta is *since the previous review*, not since the base commit. It answers “what changed after the last review?”.

## What render computes

- **Finding delta** — current findings matched to previous findings by ID:
  - `new` — a current ID that was not in the previous review.
  - `carried` — the same ID is still present.
  - `changed` — the same ID is present but the title or severity changed.
  - `resolved` — the previous ID is gone and has a resolution entry.
  - `unverified` — the previous ID is gone without a resolution. This is an error outside `--draft`.
- **Timeline** — rendered iterations up to the current one, with verdict, open/resolved counts, and archived links.
- **New/changed badges** — findings from this round are marked in the page. The iteration card shows the code and finding movement.
- **Archive** — a copy of the artifact under `runs/<id>/review.html`. Timeline links open the archived page in a new tab.

## Writing the next iteration

1. Apply the feedback or code fixes.
2. Run `collect` again. It creates a new run and increments the iteration. Do not reuse the old run directory.
3. Read `context.previous.findings` and the previous review.
4. Review every block in the new context. Code may have moved; update line ranges and block IDs.
5. Reuse the exact finding ID for anything still present.
6. For anything no longer present, add a `resolutions` entry:
   ```json
   { "findingId": "F-003", "status": "fixed", "note": "The refund helper now binds orderId and amount as parameters." }
   ```
   Statuses: `fixed`, `dismissed`, `invalid`, `duplicate`.
7. Update the file summaries and block assessments for the new blocks.
8. Write an `iterationNote` that explains what moved. The UI computes counts, but it cannot explain intent.
9. `render`, `open`, and `wait`. Then reply.

The validator fails a review that drops a previous finding without a resolution. This is the audit trail; do not renumber IDs to avoid it.

## The visual iteration

The overview's **Iteration movement** card shows:

- Previous iteration and scope.
- New / resolved / carried / unverified counts.
- A one-sentence note.
- Code delta: files changed, additions/deletions, and a compact list of changed files.
- A sparkline of open findings across iterations.
- The timeline; archived iterations are clickable when present.

The page marks the movement:

- `new` — a finding first seen in this iteration.
- `changed` — a carried finding whose title or severity changed.
- Resolved findings appear in the iteration card's movement section and the notes history.

The baseline iteration has no “previous”, so it shows a baseline state instead of a delta. That is expected.

## Scope changes

If the user asks to review a different scope (staged vs worktree, a commit, a branch), the next iteration may not be directly comparable. The UI shows a “scope changed” hint when the old/new refs or scope kind differ. In that case:

- Prefer `--fresh` if the previous review is about unrelated code.
- If you keep the timeline, say in `iterationNote` that the scope changed; do not pretend the code delta is a pure progression.

## Archived artifacts

Every rendered run gets:

```
.code-review/runs/<id>/review.html
```

The archive has a relative `artifactBase` so its timeline can link to sibling runs. The live artifact links into `runs/`; the archive links to `../<id>/review.html`.

Archives are self-contained (all data and CSS/JS inline). Opening one shows the review. It is read-only. The review server serves the live page for notes.

## Fresh starts

Use `collect --fresh` to start at iteration 1 and ignore the previous timeline. The old runs remain on disk and in `history.json`, but the new review is not compared with them. This is appropriate when the user starts a new, unrelated review in the same repository.

## Checklist for a clean iteration

- [ ] `collect` created a new run and the iteration number is expected.
- [ ] `context.previous.findings` was read.
- [ ] Every previous finding is carried with its ID or has a resolution.
- [ ] Every current block has an assessment.
- [ ] Line ranges match the current snapshot.
- [ ] The flow was updated if the path changed.
- [ ] `iterationNote` explains the movement.
- [ ] `render` is green (no errors).
- [ ] The artifact was opened and checked before sending it to the user.
