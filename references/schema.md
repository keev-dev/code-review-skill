# `review.json` schema

`review.json` is the agent-authored review. The collector scaffolds it; `render` validates it before producing the HTML. The schema is intentionally small enough to fill by hand and strict enough to catch an incomplete review.

Write the prose in ASD-STE100 style. Use short sentences, active voice, simple words, and one idea per sentence. See `references/method.md`.

A complete example lives in `examples/demo/` after running `node tests/demo.mjs`. The generated `review.json` files are in the demo fixture's `.code-review/runs/*/`.

## Top level

```json
{
  "schemaVersion": 1,
  "verdict": "blocked",
  "headline": "Checkout can take money without leaving a consistent order.",
  "overview": "Two or three sentences for a stakeholder. What changed, what is risky, what is solid.",
  "iterationNote": "What moved since the previous review. Optional on the first iteration.",
  "risks": [],
  "nextActions": [],
  "flow": { "title": "", "subtitle": "", "nodes": [], "edges": [] },
  "findings": [],
  "resolutions": [],
  "fileReviews": []
}
```

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. |
| `verdict` | yes | `ship`, `ship-with-fixes`, `needs-work`, or `blocked`. A blocker cannot use `ship` or `ship-with-fixes`; a high finding cannot use `ship`. |
| `headline` | yes | One sentence, ≤ 180 chars. Lead with the decision or biggest risk. |
| `overview` | yes | 2–4 sentences, ≤ 900 chars. |
| `iterationNote` | no | ≤ 700 chars. What moved, what remains, what is new. The UI also computes deltas. |
| `risks` | no | Up to 6 cross-cutting risks. |
| `nextActions` | no | Up to 6 ordered actions. |
| `flow` | recommended | Omit or leave empty for the fallback pipeline. Author it for non-trivial changes. |
| `findings` | yes | Current open findings only. Use `[]` when clean. |
| `resolutions` | no | Required entries for previous findings that are no longer present. |
| `fileReviews` | yes | One entry per changed file. Every block must be assessed. |

## Finding

```json
{
  "id": "F-001",
  "file": "src/orders/orderService.ts",
  "blockId": "B3",
  "side": "new",
  "startLine": 41,
  "endLine": 57,
  "severity": "blocker",
  "lens": "database",
  "tags": ["transactions", "consistency", "swallowed-error"],
  "title": "Checkout persists the order before payment and swallows payment failures",
  "detail": "The order is saved before the payment insert, and the catch block only logs. If payment or email fails, the caller still receives a successful checkout response while the order is already persisted.",
  "suggestion": "Open one transaction, create the order and payment inside it, and commit only after both succeed. Move the email to an outbox or post-commit job and rethrow the failure.",
  "suggestionCode": "",
  "confidence": "high",
  "evidence": [
    { "path": "src/orders/orderService.ts", "line": 51, "note": "the catch block logs and continues" }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable across iterations. `F-001` style is recommended. Letters, numbers, `.`, `_`, `-`; max 64 chars. |
| `file` | yes | A changed file path from `context.files[].path`. For a deleted file, use its path. |
| `blockId` | for line findings | Must exist in that file's `blocks`. Omit only for a file-level finding. |
| `side` | no | `new` (default) or `old`. Use `old` for deleted code or a finding about removed lines. |
| `startLine` / `endLine` | for line findings | 1-based, inclusive. Must be within the file and intersect the block. For a file-level finding, omit both. |
| `severity` | yes | `blocker`, `high`, `medium`, `low`, `nit`, `question`, `praise`. |
| `lens` | yes | A lens ID from `lenses.json` (for example `solid`, `fowler`, `database`, `correctness`, `security`, `performance`, `testing`, `api`, `docs`, `style`). |
| `tags` | no | Short technical tags. They render as chips. |
| `title` | yes | ≤ 140 chars. State the behavior. |
| `detail` | yes | ≤ 1400 chars. What happens and why it matters. |
| `suggestion` | yes for blocker/high | ≤ 1400 chars. The smallest useful fix. |
| `suggestionCode` | no | ≤ 5000 chars. A small code sketch; use sparingly. |
| `confidence` | yes | `high`, `medium`, or `low`. |
| `evidence` | no | Cross-file proof: `{ path, line?, note? }`. Paths are relative to the repo. |

### Anchoring rules

- A finding must attach to the block that contains its start line. The validator checks that the range intersects the block.
- For a modified file, `side: "old"` uses the block's old range. For a deleted file, `side` defaults to `old` and the block range is the old file.
- A finding can talk about a whole file (missing tests, API contract, docs) with no `blockId` and no line numbers. It appears in the file-level section.
- Do not create one finding per changed line. Group a single issue into one finding with a range.
- If a finding spans multiple blocks, anchor it to the block where the problem is most visible and mention the other scope in `detail`/`evidence`.

## File review

```json
{
  "file": "src/orders/orderService.ts",
  "risk": "high",
  "summary": "The checkout rewrite centralizes too much responsibility and loses the consistency guarantee of the old cancel path.",
  "blocks": [
    {
      "id": "B1",
      "assessment": "concern",
      "summary": "The transport is constructed inside the service and the receipt is formatted here."
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `file` | yes | Must match a changed file. |
| `risk` | yes | `low`, `medium`, `high`. Use the highest risk carried by the file, not a feeling. |
| `summary` | yes | ≤ 600 chars. What this file does in the change and whether it is safe. |
| `blocks` | required when the file has blocks | One entry per context block, in any order. |
| `blocks[].id` | yes | A context block ID. |
| `blocks[].assessment` | yes | `sound`, `concern`, `needs-work`, `question`, `not-reviewed`. |
| `blocks[].summary` | yes unless not-reviewed | ≤ 500 chars. What you checked and what you found. |

Rules:

- Every context block must be assessed. `not-reviewed` is a validation error outside `--draft`.
- Every file, including a binary asset or a metadata-only rename, needs a `fileReviews` entry and a `summary`.
- A block with a blocker/high finding should be `needs-work` or `concern`; a `sound` block with a high finding produces a warning.
- A file with no blocks gets `"blocks": []`.
- Risk is not a second verdict. A `low` file can still contain a `question`; a `high` file can have one serious finding and several clean blocks.

## Flow

```json
{
  "title": "Checkout and refund flow",
  "subtitle": "Two money-moving entry points, two refund implementations, and four tables.",
  "nodes": [
    {
      "id": "checkout-api",
      "label": "POST /checkout",
      "kind": "input",
      "layer": 0,
      "detail": "Public route; body-driven customer and cart.",
      "files": ["src/api/orders.ts"],
      "findingIds": ["F-004"]
    },
    {
      "id": "checkout-service",
      "label": "OrderService.checkout",
      "kind": "transform",
      "layer": 1,
      "detail": "Prices, saves, charges, and emails.",
      "files": ["src/orders/orderService.ts"],
      "findingIds": ["F-001", "F-002"]
    }
  ],
  "edges": [
    { "from": "checkout-api", "to": "checkout-service", "label": "customer + cart", "kind": "data" }
  ]
}
```

Node fields:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique; letters/numbers/`.`/`_`/`-`. |
| `label` | yes | ≤ 60 chars. Keep it short; details go in `detail`. |
| `kind` | yes | `input`, `transform`, `output`, `store`, `external`, `decision`, `event`, `ui`. |
| `layer` | no | 0–12. If omitted, the renderer computes a layered layout. Use explicit layers when you want a specific left-to-right story. |
| `detail` | no | ≤ 400 chars. Shown in the SVG title. |
| `files` | no | Changed file paths or existing repo paths. |
| `findingIds` | no | Current finding IDs. Unknown IDs are warnings. |

Edge fields:

| Field | Required | Notes |
|---|---|---|
| `from` / `to` | yes | Node IDs. Self-loops are rejected. |
| `label` | no | ≤ 50 chars. |
| `kind` | no | `data` (default), `control`, `event`, `dependency`. |

Limits: 18 nodes, 40 edges. If the graph is too big, group files or steps. A graph is a narrative, not an inventory.

If `flow` is omitted or empty, the overview shows a fallback review pipeline: changed files → lenses → findings → verdict. That is honest but less useful. Author a real flow for a change with more than one file or any real control/data path.

## Risks

```json
{ "title": "Checkout can commit an order without payment", "detail": "A caught payment failure still returns success.", "severity": "blocker", "files": ["src/orders/orderService.ts"] }
```

Up to 6. `files` can reference changed files or existing repo paths. Severity uses the same enum as findings. Risks are for cross-cutting concerns; do not duplicate every finding.

## Next actions

```json
{ "priority": 1, "action": "Wrap the order and payment writes in one transaction.", "file": "src/orders/orderService.ts", "findingId": "F-001" }
```

Up to 6. Priority 1–9. Actions should be concrete and ordered. Link a file or a finding when possible.

## Resolutions

```json
{ "findingId": "F-003", "status": "fixed", "note": "The refund helper now binds orderId and amount as parameters." }
```

Only valid when a previous iteration exists. Statuses: `fixed`, `dismissed`, `invalid`, `duplicate`.

Rules:

- Every previous finding must either appear in the current `findings` with the same ID or have a resolution. Missing both is an error.
- A resolution cannot reference a finding that is still present in the current review.
- The note must explain what changed or why the finding was dismissed.
- Use `dismissed` for an accepted risk; say who accepted it and why in the note.
- Do not renumber findings to avoid reconciliation.

## Enums

**Verdicts:** `ship`, `ship-with-fixes`, `needs-work`, `blocked`.

**Severities:** `blocker`, `high`, `medium`, `low`, `nit`, `question`, `praise`.

**Assessments:** `sound`, `concern`, `needs-work`, `question`, `not-reviewed`.

**Risks:** `low`, `medium`, `high`.

**Confidence:** `high`, `medium`, `low`.

**Resolution statuses:** `fixed`, `dismissed`, `invalid`, `duplicate`.

**Flow node kinds:** `input`, `transform`, `output`, `store`, `external`, `decision`, `event`, `ui`.

**Flow edge kinds:** `data`, `control`, `event`, `dependency`.

## Validation and draft mode

`render` validates against the run's `context.json`:

- All changed files have reviews.
- All context blocks are assessed.
- Every finding anchors to a valid file/block/line and uses a known lens.
- The verdict is consistent with the highest severity.
- Flow references resolve.
- Previous findings are carried or resolved.

`--draft` downgrades coverage and reconciliation errors so you can look at an intermediate artifact. It does not make the review shippable. The page shows a DRAFT banner.

`lint` runs the same validation without rendering. It exits 2 when a non-draft review has errors.

## Scaffold

`collect` writes a scaffold with:

- `verdict: "ship"`.
- A placeholder headline/overview.
- Empty risks/actions/flow/findings/resolutions.
- One file review per changed file.
- One `not-reviewed` block per context block.
- Empty file summaries.

It will fail validation until you fill it. That is intentional: it is a checklist, not a review.
