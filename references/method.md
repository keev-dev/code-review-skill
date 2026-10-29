# Review method

The artifact is only as good as the review behind it. This document is the method every file goes through before `review.json` is written. Read it every time; the lenses add depth, not a replacement for this pass.

## The contract

1. **Review the snapshot, not an imagined diff.** The snapshots in the run directory are the source of truth. If the working tree changes mid-review, start a new iteration.
2. **Every block gets an assessment.** A block can be sound, a concern, needs work, a question, or not actionable. “Looks good” without reading the block is not review.
3. **Every finding has evidence.** Name the file and line, describe the behavior, and state the smallest fix. No invented APIs, no guesses presented as facts.
4. **Every file gets a summary.** Even a binary asset, a rename, or a pure deletion needs a one-sentence assessment.
5. **High and blocker findings need a suggestion.** A problem without a next move is not actionable.
6. **Reconcile previous findings.** Reuse the ID if the issue is still present. If it is fixed, add a resolution. Never silently drop a finding.
7. **Do not edit application code during the review** unless the user asked for fixes or the feedback loop requires it. This skill is a reviewer, not a drive-by refactorer.
8. **If the review is incomplete, do not present it as done.** Use `--draft` only for an intermediate look; the stakeholder view is the validated artifact.

## 1. Freeze the change

Run `collect`. It writes a run directory with:

- `context.json` — the changed files, hunks, blocks, routed lenses, and previous iteration summary.
- `snapshot/<file>.old` and `.new` — the exact text the review must use.
- `review.json` — a scaffold you fill in.

Read the scope label first. It tells you what the diff is against. If the user asked to review a staged change, a branch, or a commit, confirm the scope matches their request before reviewing.

## 2. Understand the change before judging it

For each changed file:

1. Read the full new file, not only the hunk.
2. Read the old version around the same region so you can see what behavior changed.
3. Read the file-level hunks and blocks. The blocks are your review units.
4. Find the callers and callees. A method can look fine in isolation and break a contract at its boundary.
5. Find the tests. Do they exercise the changed behavior, the failure paths, and the data shape?
6. If the file touches a database, read the schema/migration/model and the query that sits behind it. The database lens is mandatory.
7. If the file changes a public interface, look for consumers outside the repository's changed set. The flow graph is a place to make that visible.

Do not write findings during this pass. Build a mental model first; otherwise you will report symptoms as causes.

## 3. Review each block

The collector groups nearby hunks into blocks and splits large changed regions at blank lines, so a block is a reviewable slice, not necessarily a function. For every block, ask:

### Correctness

- What does this block claim to do? Does it do that for all inputs?
- What happens on empty, null, zero, negative, duplicate, missing, or very large input?
- Are all return paths correct? Is there an accidental `undefined`, an empty array treated as success, or a caught error that returns success?
- Does the state transition match the domain? Can the operation be repeated? What happens on a retry?
- Are units, currencies, time zones, and rounding consistent?
- Does the code use an API, field, or type that does not exist in this version?
- Is a comparison (`==`, `includes`, precedence, `Number.MAX_SAFE_INTEGER`) doing what it looks like?

### State and data

- What is the unit of work, and is it atomic?
- Is the order of writes correct? What is persisted if a later step fails?
- Is there a read-modify-write race? Is the read locked or the write conditional?
- Are external side effects (email, payment, queue) inside or outside the transaction? What happens if they succeed and the transaction fails, or vice versa?
- Is the operation idempotent? Is there a durable dedupe key?
- Can a partial failure leave an object in a state no code can repair?

### Error handling

- Are errors swallowed, logged, translated, or propagated deliberately?
- Does the caller receive a failure it can act on?
- Are retryable and non-retryable errors distinguished?
- Are resources released on every path?
- Does a fallback hide the failure instead of degrading explicitly?

### Security and trust boundaries

- Where does untrusted input enter? Is it validated and encoded for its destination?
- Are authorization and ownership checked at the operation, not only at the route?
- Are secrets, tokens, passwords, PII, or full request bodies logged or returned?
- Is a file path, URL, redirect, shell command, template, or deserializer controlled by a user?
- Is tenant isolation enforced in the query or by a policy that is actually enabled?

### Performance and scale

- Is there a loop around a network/database call? An N+1?
- Is work repeated that could be batched, cached, or moved off the hot path?
- Is a list/query unbounded? Is pagination stable?
- Does the change add a blocking call inside a request path?
- Is the new cost proportional to the change, or to the size of the table/payload?

### Contracts and compatibility

- Does the public shape change (request/response, event, CSV, database type, function signature)?
- Can old and new producers/consumers coexist during deploy?
- Is a default or optional field changing meaning?
- Are errors and status codes still part of the contract?
- Are migrations compatible with the previous and next application version?

### Tests and observability

- Is the changed behavior covered by a meaningful assertion, not merely “truthy”?
- Are failure and boundary cases covered?
- Would the test catch a regression in the specific bug this change could introduce?
- Is there a log, metric, or trace for the new failure path without leaking PII?
- Can an operator tell whether the new operation succeeded?

### Readability and local design

- Is the block doing several things that a name cannot capture?
- Is the mapping between domain terms and code names obvious?
- Is a comment explaining *why*, or compensating for unclear code?
- Is the design consistent with the surrounding code, not just with a pattern you like?

Use the SOLID and Fowler lenses for this last group, and the database lens for anything that touches stored data.

## 4. Review across files

A block can be locally correct and still break a caller, a schema, or a contract. Check:

- **Callers**: who uses the changed function/endpoint/field? Does the change break them?
- **Callees**: does the code assume behavior the dependency does not provide?
- **Schema**: do migrations, models, and queries agree on types, nullability, indexes, and status values?
- **Tests/fixtures**: do they encode the old contract or exercise the new one?
- **Jobs/events**: does a new write trigger a consumer that now sees an unexpected shape?
- **Errors**: does a new exception escape a boundary that has no handler?
- **Observability**: if this fails in production, what will the operator see?

When a finding depends on another file, add an `evidence` entry with that path and line. The UI will show the connection, and the next reviewer can verify it.

## 5. Decide severity and confidence

Severity is about **impact and likelihood**, not about how strongly you feel.

| Severity | Meaning | Merge effect |
|---|---|---|
| Blocker | Data loss/corruption, double-spend, an unrecoverable state, a production outage, or a security hole with direct impact. | Must fix before merge. |
| High | A serious correctness, security, data-integrity, or scale problem in a real path. | Fix before shipping. |
| Medium | A real weakness with a bounded blast radius, or a design cost that will make the next change risky. | Usually fix in this change or the immediate follow-up. |
| Low | A local improvement, a small robustness gap, or a missing nicety. | Safe to defer. |
| Nit | Style/readability; a formatter or linter should own most of it. | Never a merge gate. |
| Question | You need intent, context, or a product decision before judging. | No verdict by itself. |
| Praise | A good decision worth keeping. | No action. |

Confidence:

- **high** — you traced the code and the evidence is direct.
- **medium** — the behavior is likely but depends on a runtime/config/data assumption you could not verify.
- **low** — a question or a risk worth surfacing; do not present it as a fact.

If a finding depends on an assumption, state the assumption in the detail. If you cannot verify it, make it a question with low/medium confidence.

## 5a. Write in ASD-STE100 style

Write the review text for a busy reader.

- Use short sentences. Use one idea in each sentence.
- Use active voice. Say who does what.
- Use simple, common words.
- Use the same term for the same thing.
- Put the condition before the action.
- Keep the subject close to the verb.
- Do not use idioms, slogans, or marketing words.
- Do not use a long noun phrase when a verb is clearer.

Use this style in the headline, overview, file summaries, block summaries, findings, risks, and next steps. The UI shows this text directly.

Examples:

Good: "The order is saved before the payment. A failed payment still returns success. Use one transaction for both writes."

Weak: "There is a pervasive architectural concern regarding the transactional boundary that could potentially manifest in inconsistent state."

## 6. Evidence standard

A good finding includes:

1. **Where** — file and line range, and the block ID.
2. **What happens** — the behavior, not the code restated.
3. **Why it matters** — the user/system impact.
4. **The smallest move** — a concrete fix, not a rewrite.
5. **Cross-file proof** — an evidence path/line when the claim depends on another part of the system.

Examples:

Good:

> **Checkout persists the order before payment** — `orders.save` runs before the payment insert, and the catch block only logs. If payment fails, the route returns success with a persisted order. Wrap both writes in one transaction and move the email to an outbox; rethrow the failure. `orderService.ts:41–57`

Weak:

> **This is not transactional** — no unit of work, no failure path, no impact.

Good:

> **Refund rows are not idempotent** — the row lock prevents a concurrent double-spend, but a retry after commit subtracts again. Add a unique idempotency key and return the existing row. `refundService.ts:5–16`

Weak:

> **Use idempotency** — no retry scenario, no storage key.

## 7. Author the flow graph

The overview's change flow is not the whole architecture. It is the slice this change touches:

- Start from the entry points (route, CLI, job, event consumer, UI action).
- Follow the changed path through transformations.
- Show stores and external systems where the path writes/reads.
- End at the observable outcome (response, event, UI state, stored row).
- Use short labels; put details in `detail` and file references.
- 4–10 nodes is usually enough. More than 18 is rejected; 8 is often ideal.
- Edges are data, control, event, or dependency. Use dependency for “this migration/index constrains that query”.
- Attach `files` and `findingIds` so the graph connects to the review.
- If the change is trivial, omit `flow` and let the fallback review pipeline render. For a non-trivial change, author it.

## 8. Write the summary

- `headline`: one sentence a stakeholder can repeat. Lead with the decision or the biggest risk, not a file name.
- `overview`: 2–4 sentences: what changed, what is risky, what is solid. No restatement of the diff.
- `risks`: cross-cutting risks that travel with the change. Link files.
- `nextActions`: ordered, concrete, and small enough to act on. Link a file or finding.
- `iterationNote`: one or two sentences about what moved since the previous review. The UI also computes deltas; this is for nuance.

Do not use the summary to repeat every finding. The ledger is for detail; the summary is for orientation.

## 9. Reconcile with the previous iteration

If `context.previous` exists:

1. Read the previous findings from `context.previous.findings`.
2. For each one, decide: still present, fixed, dismissed, invalid, or duplicate.
3. Reuse the exact ID for still-present findings; update the line range/block if needed.
4. Add a `resolution` for everything that is no longer present. The note must say what changed.
5. If the finding is still present but the title or severity changed, reuse the ID and update the text; the UI marks it as changed.
6. Do not renumber findings. IDs are the audit trail.

The validator will fail a review that silently drops a previous finding. That is intentional.

## 10. Validate and present

Run `render`. It validates structure, coverage, line ranges, verdict consistency, flow references, and previous-finding reconciliation. Fix all errors. Read the warnings. Then run `open` and `wait` to start the local review loop.

Check the artifact yourself before sending it to a stakeholder:

- Overview reads as a decision, not a data dump.
- Flow graph matches the actual change path.
- Every file's ledger has an assessment for every block.
- Findings are anchored to the right lines; hover highlights the right code.
- New/changed badges and the iteration delta are accurate.
- Links and archived iterations work.

## Independent review mode

The same agent that wrote the code has a bias toward its own design. For a high-stakes change, run a second pass:

- Spawn a fresh reviewer/subagent with the run directory, `references/method.md`, and the routed lens docs.
- Ask it to review every block independently and write a separate review draft.
- Compare: missing evidence, different severity, contradictions, and “looks fine” blocks.
- Merge the stronger evidence into the final `review.json`. Do not average severities.

The skill itself is used by the current agent; independent review is a recommended pattern, not a separate binary.

## When to stop

A review is done when:

- Every block has an assessment.
- Every file has a summary.
- Every finding has evidence and (for high/blocker) a suggestion.
- Previous findings are carried or resolved.
- The flow and summary match the findings.
- The artifact validates and opens.

“I read the diff” is not a stopping condition.
