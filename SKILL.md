---
name: code-review
description: Review local code changes with a visual, line-by-line HTML review surface. Use after implementing a feature or fix, before committing or opening a PR, or when asked to review the working tree, staged changes, a commit, or a branch. Routes database work through a database lens and source code through SOLID and Martin Fowler lenses, then renders an IDE-style changed-file list, a full-context code pane, an agent review pane, a change-flow graph, per-file findings, and an iteration timeline. A local review server returns reviewer notes to the agent.
---

# Code review

This skill turns a local git change into a **review surface**. The surface has a changed-file list, a code pane, an agent review pane, a change-flow graph, and an iteration timeline. A local review server sends reviewer notes back to you.

It is not a static analyzer. **You do the review.** The scripts collect the diff, route the lenses, validate your evidence, and render the page. The value is in your analysis.

## Setup

This skill is agent-agnostic. Install it into the repository under review, then point your agent at this file.

```sh
# from the repository under review
node "/path/to/code-review/scripts/install.mjs"

# install under the user profile instead
node "/path/to/code-review/scripts/install.mjs" --global
```

The default target is `./.agents/skills/code-review`. Runtime makes no external network requests. The code renderer is vendored in `assets/vendor/`.

## What you produce

```
.code-review/review.html                  review artifact
.code-review/runs/<run>/context.json      diff, snapshots, blocks, lens routing
.code-review/runs/<run>/review.json       your review (scaffolded, then filled)
.code-review/runs/<run>/review.html       archived iteration
.code-review/history.json                 iteration history
.code-review/current.json                 current run pointer
.code-review/session.json                 reviewer notes, agent replies, server
.code-review/vendor/pierre-diffs.js       local code renderer
```

The review server is local. It binds to `127.0.0.1` and uses a random token. No hosted service is required.

## Hard rules

1. **Read `references/method.md` before reviewing.** It is the contract for coverage, evidence, severity, flow, and summaries.
2. **Read every routed lens doc.** Files routed to `database` require `references/lenses/database.md`. Source files require `solid.md` and `fowler.md` unless already loaded.
3. **Review every block.** Every changed file gets a `fileReviews` entry. Every block gets an assessment. The renderer refuses an incomplete review unless you pass `--draft`.
4. **Anchor every finding.** Use a real file, block, side, and line range. Add an `evidence` path/line for cross-file claims.
5. **Reconcile the previous iteration.** Reuse finding IDs for issues that remain. Add a `resolution` for issues that are gone. Do not drop a finding silently.
6. **Do not change application code while reviewing.** Change it only when the user asks for fixes or sends feedback that requires a change.
7. **Do not present a draft as done.** Run `render` and fix every error.
8. **Keep `wait` in the foreground.** Do not detach it. If it stops, run it again. Notes stay queued on the server.
9. **Keep the review server local.** Do not proxy or tunnel it. The page contains source code. Use `stop` when the review ends.

## Workflow

Set `SKILL_DIR` to the folder that contains this `SKILL.md`. Run commands from the repository under review, or pass `--root <repo>`.

### 1. Collect

```sh
node "<SKILL_DIR>/scripts/review.mjs" collect
```

Default scope: working tree vs `HEAD`. It includes staged, unstaged, and untracked files.

| User asks | Flag |
|---|---|
| “Review my changes.” | default |
| “Review what I staged.” | `--staged` |
| “Review this branch against main.” | `--base main` |
| “Review these commits.” | `--range main..HEAD` |
| “Review this commit.” | `--commit <sha>` |
| “Only these files.” | `--path <spec>` (repeatable) |
| New, unrelated review | `--fresh` |

The command prints the run ID, iteration, files, block counts, routed lenses, and guide paths. It writes a scaffolded `review.json`.

### 2. Read the context

Read these files:

- `references/method.md`.
- `references/schema.md`.
- Each routed lens doc.
- The run's `context.json`.
- The snapshot files:
  - `context.files[i].snapshot.new`
  - `context.files[i].snapshot.old`

Read real callers, schema, tests, and interfaces from the repository. Use grep and read. Do not guess.

### 3. Review

Walk every changed file and every block. The full checklist is in `references/method.md`. The short version:

- Reconstruct the old and new behavior.
- Check correctness, state, failure paths, security, concurrency, performance, contracts, tests, and observability.
- Apply the routed lenses.
- Name the smallest useful fix.
- Assign severity and confidence.
- Write the file summary and risk.
- Author the change-flow graph for a non-trivial change. Use 4–10 nodes.
- Write a short headline and a 2–4 sentence overview.

Fill `review.json` in the run directory. Do not leave `not-reviewed` entries.

Write like ASD-STE100:
- Use short sentences. Use one idea per sentence.
- Use active voice.
- Use simple, common words.
- Use the same term for the same thing.
- Put the condition before the action.
- Do not use idioms, slogans, or marketing words.

### 4. Validate and render

```sh
node "<SKILL_DIR>/scripts/review.mjs" render
```

This checks structure, block coverage, line ranges, lenses, verdict consistency, flow references, and previous-finding reconciliation. Fix every error. Read the warnings. The command prints the artifact path and the movement since the previous iteration.

`lint` runs the same checks without rendering:

```sh
node "<SKILL_DIR>/scripts/review.mjs" lint
```

### 5. Open the review server

```sh
node "<SKILL_DIR>/scripts/review.mjs" open
```

`open` renders, starts a local server, opens the browser, and prints the URL. The URL has a random token. Use `open --no-browser` when the agent cannot launch a browser.

Then wait for notes:

```sh
node "<SKILL_DIR>/scripts/review.mjs" wait
```

`wait` long-polls the server. Keep it in the foreground. It returns when the reviewer sends notes or closes the session. Read the full payload.

The reviewer uses the page:
1. Select a file in the left list.
2. Read the code and the agent note.
3. Click **Annotate**.
4. Click code or a finding. Write a note. Click **Queue note**.
5. Open **Notes**. Click **Send to agent**.

### 6. Handle feedback

- **Code fix requested:** apply the fix. Run `collect` again. Re-review the affected files and blocks. Update `review.json`. Run `render`. Then reply and wait again.
- **Review correction:** update `review.json` and run `render` on the same run. Add a `resolution` if you remove a previous finding. Then reply and wait.
- **Question:** answer with `reply`.
- **Reviewer closes the session:** stop. Do not reopen it unless the reviewer asks.

Post a short reply and mark seen notes done:

```sh
node "<SKILL_DIR>/scripts/review.mjs" reply --message "Checkout now uses one transaction. The failure is rethrown."
```

Then wait for more notes:

```sh
node "<SKILL_DIR>/scripts/review.mjs" wait
```

Stop the server when the review is complete:

```sh
node "<SKILL_DIR>/scripts/review.mjs" stop
```

## Scope notes

- `--base <ref>` reviews from the merge base of `<ref>` and `HEAD` through the working tree. This matches a PR review and includes uncommitted work.
- `--range <a..b>` is an exact two-ref diff. `a...b` uses the merge base.
- `--commit <sha>` supports root commits.
- Untracked files are included by default in worktree and base scopes. Use `--no-untracked` to exclude them.
- `.code-review/` is added to `.git/info/exclude`.

## Lens routing

`lenses.json` is the routing table.

- `solid` and `fowler` apply to source files.
- `database` applies to migrations, SQL, Prisma/ORM models, repositories/DAOs, query code, and transactions.
- Built-in lenses: `correctness`, `security`, `performance`, `testing`, `api`, `docs`, `style`.

When a file is routed to a lens, read the lens doc before you judge it. The lens docs are questions, not checklists. Do not force a finding.

To add a lens:
1. Add `references/lenses/<id>.md`.
2. Add an entry to `lenses.json` with a label, color, kind `skill`, doc path, and optional `appliesTo`.
3. Use the new ID in findings.

No renderer change is needed.

## The review page

- **Left list:** every changed file. Select one. The status dot, line delta, and finding count show the risk.
- **Overview:** verdict, headline, metrics, change-flow graph, iteration movement, top findings, next steps, and risks.
- **Code pane:** full-context unified diff. Use **Diff / File** to switch.
- **Review pane:** the agent note, findings that need attention, blocks that look okay, and coverage for every reviewed block.
- **Notes:** the local review loop. The reviewer queues notes and sends them to the agent. Agent replies appear in the same panel.

The page uses `@pierre/diffs` for code. The rest is self-contained HTML, CSS, and JavaScript.

## Quality bar

| Severity | Meaning |
|---|---|
| Blocker | Data loss, double-spend, unrecoverable state, outage, or direct-impact security. |
| High | Serious correctness, security, data, or scale problem in a real path. |
| Medium | Real weakness with a bounded blast radius, or a design cost that makes the next change risky. |
| Low / nit | Local improvement. Formatters own most style. |
| Question | Intent is not clear. Ask before you assert. |
| Praise | A good decision. No action. |

Do not invent findings. A clean block is a valid result. Do not raise a design preference to a blocker. Do not claim a runtime behavior that you did not verify.

The validator checks structure. It does not check truth.

## Setup

Requirements: Node 20+ and git. Runtime makes no external network requests. The local code renderer is vendored under `assets/vendor/`.

Install into the repository under review:

```sh
node "<repo>/scripts/install.mjs"            # copy to ./.agents/skills/code-review
node "<repo>/scripts/install.mjs" --global   # copy to ~/.agents/skills/code-review
node "<repo>/scripts/install.mjs" --link     # link for local development
```

Restart the agent session after you install.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Not a git repository` | Run in the repo or pass `--root`. |
| `No changes to review` | Check the scope or ask the user. |
| `No review.json` | Fill the scaffold. |
| Missing block assessment | Review the block. Do not use `--draft` for the reviewer. |
| Previous finding missing | Reuse its ID or add a `resolution`. |
| Code pane is empty | Check that `assets/vendor/pierre-diffs.js` exists in the installed skill. |
| Server is not running | Run `open`, then `wait`. |
| Wait does not return | Keep it running. The server queues notes. |
| Browser is closed | The server still runs. Reopen the URL from `open`, or run `stop`. |
| Token error | Open the URL that `open` printed. It contains the token. |

## References

- `references/method.md` — review contract, checklist, evidence, STE style.
- `references/schema.md` — `review.json` fields, anchors, flow, resolutions.
- `references/iterations.md` — run lifecycle, deltas, archives.
- `references/lenses/solid.md` — SOLID questions.
- `references/lenses/fowler.md` — code smells and refactorings.
- `references/lenses/database.md` — migrations, queries, transactions, indexes, data safety.

The source checkout also has `examples/` and `tests/`. They are development aids.
