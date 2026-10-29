import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.mjs";
import { ensureDir, readText, removeRecursive, writeJson, writeText } from "../scripts/lib/util.mjs";
import { collectReview, runDir } from "../scripts/lib/context.mjs";
import { renderRun } from "../scripts/lib/render.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DIR = path.join(SKILL_ROOT, "examples", "demo");
const FIXTURE_DIR = path.join(process.env.TEMP || process.env.TMP || ".", "opencode", "code-review-demo-live");

function snapshotText(root, context, file, side = "new") {
  const relative = file.snapshot?.[side];
  if (!relative) return "";
  return readText(path.join(runDir(root, context.runId), relative));
}

function lineOf(text, snippet, label = snippet) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(snippet));
  if (index < 0) throw new Error(`Could not find anchor in fixture: ${label}`);
  return index + 1;
}

function blockForLine(file, line, side = "new") {
  const blocks = file.blocks || [];
  const ranges = blocks.map((block) => {
    if (side === "old" && block.side === "old") return { block, start: block.startLine, end: block.endLine };
    if (side === "old") return { block, start: block.oldStart, end: block.oldEnd };
    return { block, start: block.startLine, end: block.endLine };
  });
  return ranges.find((entry) => line >= entry.start && line <= entry.end)
    || ranges.filter((entry) => entry.start <= line).sort((a, b) => b.start - a.start)[0]
    || ranges[0];
}

function concise(value, max = 280) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
  let out = "";
  for (const sentence of sentences) {
    const next = `${out} ${sentence}`.trim();
    if (out && next.length > max) break;
    out = next;
  }
  out = (out || text).replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1).trim()}?` : out;
}

function makeFinding(context, root, spec) {
  const file = context.files.find((entry) => entry.path === spec.file);
  if (!file) throw new Error(`Unknown fixture file: ${spec.file}`);
  const side = spec.side || (file.status === "deleted" ? "old" : "new");
  const text = snapshotText(root, context, file, side);
  const startLine = spec.startLine
    ? spec.startLine
    : lineOf(text, spec.start, `${spec.id} start`);
  const endLine = spec.endLine
    ? spec.endLine
    : spec.end
      ? Math.max(startLine, lineOf(text, spec.end, `${spec.id} end`))
      : startLine;
  const block = blockForLine(file, startLine, side);
  if (!block) throw new Error(`No review block for ${spec.id} at ${spec.file}:${startLine}`);
  return {
    id: spec.id,
    file: spec.file,
    blockId: block.block.id,
    side,
    startLine,
    endLine,
    severity: spec.severity,
    lens: spec.lens,
    tags: spec.tags || [],
    title: spec.title,
    detail: concise(spec.detail, 240),
    suggestion: concise(spec.suggestion, 180),
    suggestionCode: spec.suggestionCode || "",
    confidence: spec.confidence || "high",
    evidence: spec.evidence || [],
  };
}

const FILE_SUMMARIES_1 = {
  "src/orders/orderService.ts": "The checkout rewrite centralizes too much responsibility and loses the consistency guarantees the old cancel path had. The money path needs a transaction boundary before anything else ships.",
  "src/api/orders.ts": "Two new endpoints expose the service without authentication or request validation. customerId and amount are taken directly from the request body.",
  "db/migrations/004_add_order_status.sql": "The migration adds the new status column but also drops the customer index the new repository query depends on and rewrites orders in place.",
  "src/orders/orderRepository.ts": "The new customer query is a useful capability, but it uses SELECT * with no pagination and sorts on a column that has no supporting index.",
  "src/orders/refundService.ts": "The new refund helper duplicates the refund path and repeats the raw SQL interpolation pattern; it also reads then writes without a lock or transaction.",
  "src/orders/checkout.test.ts": "The new test exercises the real checkout without a database or collaborators and only asserts truthiness. It does not protect the behavior that changed.",
  "src/utils/formatMoney.ts": "The rename and Intl-based formatting are an improvement. The signature changed from one argument to two; confirm whether this helper is used outside the repository.",
  "src/legacy/legacyPricing.ts": "Removing the old pricing helper is a clean deletion; no remaining call sites were found.",
  "src/utils/money.ts": "The old money helper was replaced by the renamed formatter. The deletion itself is safe.",
  "assets/logo.png": "Binary asset. It has no line-level review; the file is listed so the change set remains complete.",
};

const BLOCK_NOTES_1 = {
  "src/orders/orderService.ts|B1": ["concern", "The transport is constructed inside the service and the notification body is formatted here. This is a testability and responsibility problem, not a runtime failure."],
  "src/orders/orderService.ts|B2": ["needs-work", "Checkout prices the cart with one query per item, mixes floating-point money with a hardcoded tax rate, and interpolates request data into SQL."],
  "src/orders/orderService.ts|B3": ["needs-work", "The order is saved before payment is attempted, and the catch block only logs. A failed payment still returns success to the caller."],
  "src/orders/orderService.ts|B4": ["needs-work", "Cancel now routes through a full refund and always throws. The refund implementation duplicates refundService and repeats raw SQL."],
  "src/api/orders.ts|B1": ["needs-work", "Both new routes trust the request body. There is no authentication, ownership check, or schema validation before money moves."],
  "db/migrations/004_add_order_status.sql|B1": ["needs-work", "The migration drops the customer index, performs an in-place type change and backfill, and creates the new index without CONCURRENTLY."],
  "src/orders/orderRepository.ts|B1": ["concern", "The query returns all columns and every row for a customer, orders only by created_at, and has no limit."],
  "src/orders/refundService.ts|B1": ["needs-work", "The helper repeats raw SQL interpolation and has no transaction or row lock. Two concurrent refunds can read the same total and both write."],
  "src/orders/checkout.test.ts|B1": ["concern", "The test cannot exercise checkout without a database, has no collaborators, and asserts only that the result is truthy."],
  "src/utils/formatMoney.ts|B1": ["question", "The Intl implementation is better. The only open question is whether the new locale parameter is part of a public contract."],
  "src/legacy/legacyPricing.ts|B1": ["sound", "The deleted helper has no remaining call sites and is replaced by the new formatter."],
  "src/utils/money.ts|B1": ["sound", "The old formatter is removed as part of the rename. No issue."],
};

const FILE_SUMMARIES_2 = {
  ...FILE_SUMMARIES_1,
  "src/orders/orderService.ts": "The cancel behavior and PII logging are fixed. Checkout still persists before payment and swallows the failure, so the money path remains blocked.",
  "src/orders/refundService.ts": "The refund helper now binds parameters and locks the order row. The transaction is still issued through pooled query calls, so BEGIN/COMMIT is not guaranteed to use one connection, and retries are not idempotent.",
  "db/migrations/004_add_order_status.sql": "The customer index is preserved and the status index is now concurrent. The in-place bigint type change and backfill still take a write lock and have no rollback plan.",
  "src/utils/formatMoney.ts": "The rename is internal and the formatter is an improvement. No open issue.",
};

const BLOCK_NOTES_2 = {
  ...BLOCK_NOTES_1,
  "src/orders/orderService.ts|B3": ["needs-work", "Checkout still saves the order before payment and swallows the failure. The PII log is gone, but the consistency bug remains."],
  "src/orders/orderService.ts|B4": ["concern", "Cancel is restored. The refund implementation still duplicates refundService and repeats the unparameterized SQL pattern."],
  "src/orders/refundService.ts|B1": ["needs-work", "Parameters and FOR UPDATE are improvements. BEGIN and COMMIT are issued through a pooled client, and the refund has no idempotency key."],
  "db/migrations/004_add_order_status.sql|B1": ["needs-work", "Dropping the customer index is fixed and the status index is concurrent. The type change and backfill still lock the table and cannot be rolled back."],
  "src/utils/formatMoney.ts|B1": ["sound", "No call sites outside the repository were found. The rename and formatting change are safe."],
};

const FINDINGS_1 = [
  {
    id: "F-001",
    file: "src/orders/orderService.ts",
    start: "await this.orders.save(order);",
    end: "console.log(\"checkout failed\", error);",
    severity: "blocker",
    lens: "database",
    title: "Checkout persists the order before payment and swallows payment failures",
    detail: "The order is saved before the payment insert, and the catch block only logs. If payment or email fails, the caller still receives a successful checkout response while the order is already persisted. This leaves the money path inconsistent and hides the failure from the caller.",
    suggestion: "Open one transaction, create the order and payment inside it, and commit only after both succeed. Move the email to an outbox or post-commit job. Rethrow so the route returns a failure response.",
    tags: ["transactions", "consistency", "swallowed-error"],
    evidence: [
      { path: "db/schema.sql", line: 11, note: "orders and payments are separate tables with no cross-write boundary" },
      { path: "src/orders/orderService.ts", line: 51, note: "catch block logs and continues" },
    ],
  },
  {
    id: "F-002",
    file: "src/orders/orderService.ts",
    start: "const product = await db.query(",
    end: "const product = await db.query(",
    severity: "high",
    lens: "security",
    title: "OrderService interpolates cart, customer, and refund values into SQL",
    detail: "The product, customer, payment, and refund statements are built with template strings. Values from the cart, customer id, and refund amount reach the database unparameterized. The refund method repeats the same pattern in a second place.",
    suggestion: "Use bound parameters for every value, as OrderRepository.findById already does. Keep SQL text static and pass values in the params array.",
    tags: ["sql-injection", "input-boundary"],
    evidence: [
      { path: "src/orders/orderRepository.ts", line: 11, note: "the existing repository shows the parameterized pattern" },
    ],
  },
  {
    id: "F-003",
    file: "src/orders/refundService.ts",
    start: "const [order] = await db.query(",
    end: "RETURNING *`,",
    severity: "high",
    lens: "security",
    title: "Refund helper repeats the SQL interpolation pattern",
    detail: "refundOrder builds the lookup, update, and insert from orderId and amount with template strings. It is a second injection surface in the same change and will drift from OrderService.refund.",
    suggestion: "Bind orderId and amount as parameters. Consider deleting this helper and keeping one refund implementation rather than maintaining two.",
    tags: ["sql-injection", "duplicate-logic"],
  },
  {
    id: "F-004",
    file: "src/api/orders.ts",
    start: "router.post(\"/checkout\"",
    end: "res.json(result);",
    severity: "high",
    lens: "security",
    title: "Checkout and refund routes trust unauthenticated request bodies",
    detail: "The routes pass customerId and amount straight from req.body into money-moving service calls. There is no authentication, authorization, ownership check, or schema validation, so a caller can act on another customer's order or request an arbitrary refund amount.",
    suggestion: "Authenticate the request, derive the customer from the session rather than the body, validate amounts with a schema, and check order ownership before calling the service.",
    tags: ["authorization", "idor", "validation"],
    evidence: [
      { path: "src/api/orders.ts", line: 7, note: "customerId comes from req.body" },
      { path: "src/orders/orderService.ts", line: 51, note: "refund accepts an unbounded amount" },
    ],
  },
  {
    id: "F-005",
    file: "db/migrations/004_add_order_status.sql",
    startLine: 1,
    endLine: 6,
    severity: "high",
    lens: "database",
    title: "Migration drops the customer index the new query depends on",
    detail: "The migration drops orders_customer_id_idx while the new findByCustomer query filters by customer_id and sorts by created_at. On a large table that turns a targeted lookup into a sequential scan. The same migration also rewrites orders for the bigint change and creates the status index without CONCURRENTLY.",
    suggestion: "Keep the customer index until a replacement composite index is live. Run the new index with CREATE INDEX CONCURRENTLY outside a transaction. Split the type change and backfill into a separately deployable migration with a rollback plan.",
    tags: ["index", "locking", "backfill", "rollback"],
    evidence: [
      { path: "src/orders/orderRepository.ts", line: 25, note: "findByCustomer filters on customer_id and sorts by created_at" },
    ],
  },
  {
    id: "F-006",
    file: "src/orders/orderService.ts",
    start: "async cancel(orderId: string): Promise<Order>",
    end: "return this.refund(orderId, Number.MAX_SAFE_INTEGER);",
    severity: "high",
    lens: "correctness",
    title: "cancel always throws and no longer cancels the order",
    detail: "The previous cancel path loaded the order, set its status to cancelled, saved it, and sent an email. The new path calls refund with Number.MAX_SAFE_INTEGER. refund rejects any amount above the order total, so cancel now always throws before changing state.",
    suggestion: "Restore the status transition: load the order, guard the current state, set status to cancelled, save, and enqueue the notification. Do not route cancellation through a refund.",
    tags: ["regression", "state-transition"],
  },
  {
    id: "F-007",
    file: "src/orders/orderService.ts",
    start: "for (const item of cart.items)",
    end: "lines.push({ name: product.name, total: product.price_cents * item.quantity });",
    severity: "medium",
    lens: "performance",
    title: "Checkout issues one product query per cart line",
    detail: "Each line item runs a separate SELECT inside the loop. A cart with twenty lines produces twenty round trips before the order is written. The product data is independent and can be fetched in one query.",
    suggestion: "Collect the product ids and fetch them with a single parameterized IN query. Map the rows back to the cart in memory.",
    tags: ["n+1", "round-trips"],
  },
  {
    id: "F-008",
    file: "src/orders/orderService.ts",
    start: "const tax = total * 0.2;",
    end: "total = total + tax;",
    severity: "medium",
    lens: "fowler",
    title: "Money is accumulated as floating-point cents with a magic tax rate",
    detail: "The total is a JavaScript number, tax is a hardcoded 20% multiplied into it, and individual line totals are stored as floating-point values. Rounding behavior is implicit. The tax rate cannot vary by jurisdiction or be tested.",
    suggestion: "Represent money as integer minor units, keep the tax rate in configuration, round once at the boundary, and cover the calculation with table-driven tests.",
    tags: ["primitive-obsession", "magic-number", "rounding"],
  },
  {
    id: "F-009",
    file: "src/orders/orderService.ts",
    start: "console.log(\"bad quantity\", cart, customerId);",
    end: "console.log(\"bad quantity\", cart, customerId);",
    severity: "medium",
    lens: "security",
    title: "Invalid quantities are logged with the full cart and customer id",
    detail: "The debug log prints the whole cart and customer identifier, and the code continues after detecting a non-positive quantity. This leaks customer data into logs and lets invalid input reach pricing.",
    suggestion: "Reject the request with a validation error and use a structured logger with redaction. Do not log payloads that can contain customer data.",
    tags: ["pii", "logging", "validation"],
  },
  {
    id: "F-010",
    file: "src/orders/orderService.ts",
    start: "export class SmtpEmailClient",
    end: "private readonly emailClient = new SmtpEmailClient();",
    severity: "medium",
    lens: "solid",
    title: "OrderService owns its SMTP transport and formats the receipt",
    detail: "The service constructs a concrete SmtpEmailClient, depends on it directly, and builds the email body inside checkout. That couples the money path to a transport and makes the service hard to test without sending mail. It also violates the dependency-inversion and single-responsibility principles.",
    suggestion: "Inject a narrow Notifier interface, keep transport construction at the composition edge, and move receipt formatting into a template or presenter.",
    tags: ["SRP", "DIP", "testability"],
    evidence: [
      { path: "src/notifications/email.ts", note: "the transport already exists as a small adapter" },
    ],
  },
  {
    id: "F-011",
    file: "src/orders/orderService.ts",
    start: "async refund(orderId: string, amount: number): Promise<any>",
    end: "return { order, amount };",
    severity: "medium",
    lens: "fowler",
    title: "Refund logic is duplicated in OrderService and refundService",
    detail: "Both refund implementations look up the order, compare the amount, update the total, and insert a refund. They use different signatures and one is already exposed through a second route. Future fixes will have to land in both places.",
    suggestion: "Keep one refund module with a clear contract, call it from both entry points, and delete the duplicate implementation.",
    tags: ["duplicate-code", "shotgun-surgery"],
    evidence: [
      { path: "src/orders/refundService.ts", note: "second implementation of the same four steps" },
    ],
  },
  {
    id: "F-012",
    file: "src/orders/checkout.test.ts",
    start: "test(\"checkout returns an order\"",
    end: "expect(result).toBeTruthy();",
    severity: "medium",
    lens: "testing",
    title: "The checkout test asserts truthiness and cannot catch the new failure modes",
    detail: "The test passes an empty repository and a cart with no items, then asserts that the result exists. It never verifies the order total, status, payment, or failure behavior, and it will not catch the transaction or validation regressions.",
    suggestion: "Use a fake database or repository to assert the total, status, and post-commit notification. Add a failing payment case and a duplicate-submit case.",
    tags: ["coverage", "fake-db", "failure-path"],
  },
  {
    id: "F-013",
    file: "src/orders/orderRepository.ts",
    start: "async findByCustomer",
    end: "return db.query(`SELECT * FROM orders WHERE customer_id = '${customerId}' ORDER BY created_at DESC`);",
    severity: "low",
    lens: "database",
    title: "Customer query returns every column and every row",
    detail: "The new query selects all columns and all orders for a customer, with no limit, and orders by created_at while the migration drops the only customer index. It will not scale with order history.",
    suggestion: "Select only the columns the caller needs, add pagination or a bounded limit, and add a composite index on (customer_id, created_at DESC).",
    tags: ["select-star", "pagination", "index"],
    evidence: [
      { path: "db/migrations/004_add_order_status.sql", line: 6, note: "the migration drops the customer index" },
    ],
  },
  {
    id: "F-014",
    file: "src/utils/formatMoney.ts",
    start: "export function formatMoney",
    end: "return new Intl.NumberFormat",
    severity: "question",
    lens: "api",
    title: "Is the new locale parameter part of an external contract?",
    detail: "The helper was renamed and its signature changed from one argument to two. The implementation is an improvement, but a caller that imports the old path or relies on a fixed default locale will break differently.",
    suggestion: "Check call sites and release notes. If the helper is internal, keep it simple; if it is public, add a compatibility path or document the signature change.",
    tags: ["signature-change", "locale"],
  },
  {
    id: "F-015",
    file: "src/orders/refundService.ts",
    start: "const [order] = await db.query(",
    end: "return refund;",
    severity: "medium",
    lens: "database",
    title: "Refund reads then writes without a lock or transaction",
    detail: "The helper reads the order total, decides the refund is valid, and then updates it. Two concurrent refund requests can both read the same total and both subtract, producing a double refund. The insert and update are not atomic.",
    suggestion: "Run the lookup with SELECT ... FOR UPDATE inside a transaction, then update and insert before committing. Add an idempotency key so a retry does not refund twice.",
    tags: ["race-condition", "transactions", "idempotency"],
  },
  {
    id: "F-016",
    file: "src/legacy/legacyPricing.ts",
    side: "old",
    start: "export function legacyTotal",
    end: "return items.reduce",
    severity: "praise",
    lens: "fowler",
    title: "Removing the legacy pricing helper is a clean win",
    detail: "The old helper duplicated tax logic with a magic multiplier and had no tests. Deleting it reduces the number of pricing paths and removes a source of drift.",
    suggestion: "No action needed; keep the new formatter as the single formatting path.",
    tags: ["deletion", "simplification"],
  },
];

const FINDINGS_2 = FINDINGS_1
  .filter((spec) => !["F-003", "F-005", "F-006", "F-009", "F-014", "F-015"].includes(spec.id))
  .map((spec) => {
    if (spec.id === "F-002") {
      return {
        ...spec,
        title: "OrderService still interpolates cart, customer, and refund values into SQL",
        detail: "The checkout product and customer lookups still use template strings, and OrderService.refund still builds its statements the same way. The refundService helper was fixed, but the duplicate path in this service was not.",
      };
    }
    return spec;
  });

FINDINGS_2.push(
  {
    id: "F-017",
    file: "src/orders/refundService.ts",
    start: "await db.query(\"BEGIN\");",
    end: "await db.query(\"COMMIT\");",
    severity: "high",
    lens: "database",
    title: "BEGIN and COMMIT go through a pooled client and may use different connections",
    detail: "The manual transaction issues BEGIN, the locked SELECT, the UPDATE, and COMMIT as separate calls on the pool. A pool can hand each call a different connection, so the transaction boundaries are not guaranteed. The lock only protects the connection that runs the SELECT.",
    suggestion: "Expose a transaction callback on the database client that pins one connection, or use the pool's dedicated checkout API. Do not send BEGIN/COMMIT through generic query calls.",
    tags: ["connection-pool", "transactions", "locking"],
  },
  {
    id: "F-018",
    file: "src/orders/refundService.ts",
    start: "export async function refundOrder",
    end: "return refund;",
    severity: "medium",
    lens: "database",
    title: "Refund is still not idempotent",
    detail: "The row lock prevents a concurrent double-spend, but a retry after a committed refund will subtract the amount again because there is no idempotency key or unique refund record keyed by request id.",
    suggestion: "Add a unique idempotency key to refunds, check it inside the same transaction, and return the existing refund for a retry.",
    tags: ["idempotency", "retries"],
  },
  {
    id: "F-019",
    file: "db/migrations/004_add_order_status.sql",
    start: "ALTER TABLE orders ALTER COLUMN total_cents TYPE bigint;",
    end: "CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);",
    severity: "medium",
    lens: "database",
    title: "The bigint type change and backfill still take a write lock",
    detail: "Preserving the customer index and making the status index concurrent are improvements. The in-place total_cents type change still rewrites the table, and the status backfill runs as one unbounded UPDATE with no rollback or batched plan.",
    suggestion: "Add the new column or type in an expand step, backfill in bounded batches with progress tracking, switch reads, then contract. Keep a reversible step for each deploy.",
    tags: ["locking", "backfill", "rollback", "expand-contract"],
  },
);

const RESOLUTIONS_2 = [
  { findingId: "F-003", status: "fixed", note: "The refund helper now binds orderId and amount as parameters." },
  { findingId: "F-005", status: "fixed", note: "The customer index is preserved and the status index uses CONCURRENTLY; the remaining lock risk is tracked separately." },
  { findingId: "F-006", status: "fixed", note: "Cancel restores the status transition and no longer routes through refund." },
  { findingId: "F-009", status: "fixed", note: "The PII log was removed; invalid quantities now fail validation." },
  { findingId: "F-014", status: "fixed", note: "No external call sites were found; the renamed helper is internal." },
  { findingId: "F-015", status: "fixed", note: "The refund path now locks the order row inside a transaction; idempotency remains a separate finding." },
];

function makeFlow(iteration = 1) {
  const nodes = [
    { id: "checkout-api", label: "POST /checkout", kind: "input", layer: 0, detail: "Public route; body-driven customer and cart.", files: ["src/api/orders.ts"], findingIds: ["F-004"] },
    { id: "refund-api", label: "POST /:id/refund", kind: "input", layer: 0, detail: "Public route; body-driven amount.", files: ["src/api/orders.ts"], findingIds: ["F-004"] },
    { id: "migration", label: "Migration 004", kind: "store", layer: 0, detail: "Adds status, changes total_cents to bigint, changes indexes.", files: ["db/migrations/004_add_order_status.sql"], findingIds: [iteration === 2 ? "F-019" : "F-005"] },
    { id: "checkout-service", label: "OrderService.checkout", kind: "transform", layer: 1, detail: "Prices the cart, saves the order, charges, and emails.", files: ["src/orders/orderService.ts"], findingIds: iteration === 2 ? ["F-001", "F-002", "F-007", "F-008", "F-010"] : ["F-001", "F-002", "F-007", "F-008", "F-009", "F-010"] },
    { id: "refund-service", label: "Refund path", kind: "transform", layer: 1, detail: "Two implementations: OrderService.refund and refundOrder.", files: ["src/orders/orderService.ts", "src/orders/refundService.ts"], findingIds: iteration === 2 ? ["F-011", "F-017", "F-018"] : ["F-003", "F-011", "F-015"] },
    { id: "repo-query", label: "findByCustomer", kind: "transform", layer: 1, detail: "New customer order lookup.", files: ["src/orders/orderRepository.ts"], findingIds: ["F-013"] },
    { id: "orders-store", label: "orders", kind: "store", layer: 2, detail: "Total, status, and customer index live here.", files: ["db/schema.sql"], findingIds: iteration === 2 ? ["F-001", "F-019"] : ["F-001", "F-005"] },
    { id: "payments-store", label: "payments", kind: "store", layer: 2, detail: "Payment is inserted after the order save.", files: ["db/schema.sql"], findingIds: ["F-001"] },
    { id: "refunds-store", label: "refunds", kind: "store", layer: 2, detail: "Refund records are inserted without an idempotency key.", files: ["db/schema.sql"], findingIds: iteration === 2 ? ["F-017", "F-018"] : ["F-003", "F-015"] },
    { id: "email", label: "SMTP receipt", kind: "external", layer: 2, detail: "Receipt formatting and transport inside the service.", files: ["src/notifications/email.ts"], findingIds: ["F-010"] },
    { id: "response", label: "HTTP response", kind: "output", layer: 3, detail: "Success is returned even when payment fails.", files: ["src/api/orders.ts"], findingIds: ["F-001"] },
  ];
  const edges = [
    { from: "checkout-api", to: "checkout-service", label: "customer + cart", kind: "data" },
    { from: "checkout-service", to: "orders-store", label: "save order", kind: "data" },
    { from: "checkout-service", to: "payments-store", label: "charge", kind: "data" },
    { from: "checkout-service", to: "email", label: "receipt", kind: "event" },
    { from: "checkout-service", to: "response", label: "returns even on failure", kind: "control" },
    { from: "refund-api", to: "refund-service", label: "amount", kind: "data" },
    { from: "refund-service", to: "orders-store", label: "debit total", kind: "data" },
    { from: "refund-service", to: "refunds-store", label: "record", kind: "data" },
    { from: "refund-service", to: "response", label: "refund result", kind: "data" },
    { from: "migration", to: "orders-store", label: "status + type", kind: "dependency" },
    { from: "migration", to: "repo-query", label: iteration === 2 ? "customer index kept" : "drops customer index", kind: "dependency" },
    { from: "repo-query", to: "orders-store", label: iteration === 2 ? "customer index" : "missing index", kind: "dependency" },
  ];
  return {
    title: "Checkout and refund flow",
    subtitle: "Two entry points, two refund paths, four tables, and one email.",
    nodes,
    edges,
  };
}

function fileRisk(findings) {
  if (findings.some((finding) => finding.severity === "blocker" || finding.severity === "high")) return "high";
  if (findings.some((finding) => finding.severity === "medium")) return "medium";
  return "low";
}

function assessmentFor(blockFindings) {
  if (blockFindings.some((finding) => ["blocker", "high"].includes(finding.severity))) return "needs-work";
  if (blockFindings.some((finding) => finding.severity === "question")) return "question";
  if (blockFindings.some((finding) => ["medium", "low", "nit"].includes(finding.severity))) return "concern";
  return "sound";
}

const RISKS_1 = [
  { title: "Money can be taken without a committed order", detail: "Checkout saves the order before payment and continues after a caught payment failure.", severity: "blocker", files: ["src/orders/orderService.ts"] },
  { title: "Public routes accept money instructions from the request body", detail: "No authentication or ownership check protects checkout and refund.", severity: "high", files: ["src/api/orders.ts"] },
  { title: "The migration and new query disagree about indexes", detail: "The migration drops the customer index while the repository adds a customer order query.", severity: "high", files: ["db/migrations/004_add_order_status.sql", "src/orders/orderRepository.ts"] },
];

const ACTIONS_1 = [
  { priority: 1, action: "Put the order and payment writes inside one transaction, move email to an outbox, and rethrow failures.", file: "src/orders/orderService.ts", findingId: "F-001" },
  { priority: 2, action: "Authenticate both routes, derive the customer from the session, and validate the refund amount.", file: "src/api/orders.ts", findingId: "F-004" },
  { priority: 3, action: "Parameterize every query and delete one of the two refund implementations.", file: "src/orders/refundService.ts", findingId: "F-003" },
  { priority: 4, action: "Preserve the customer index and split the migration into expand, backfill, and contract steps.", file: "db/migrations/004_add_order_status.sql", findingId: "F-005" },
  { priority: 5, action: "Restore cancel as a status transition and add a real checkout test.", file: "src/orders/orderService.ts", findingId: "F-006" },
];

const RISKS_2 = [
  { title: "Checkout still returns success after a failed payment", detail: "The order is saved before payment and the catch block still only logs.", severity: "blocker", files: ["src/orders/orderService.ts"] },
  { title: "Public routes still accept money instructions from the request body", detail: "Authentication and ownership checks are unchanged.", severity: "high", files: ["src/api/orders.ts"] },
  { title: "The new refund transaction is not connection-pinned", detail: "BEGIN and COMMIT go through a pooled query API; retries are not idempotent.", severity: "high", files: ["src/orders/refundService.ts"] },
  { title: "The migration still rewrites orders under a lock", detail: "The bigint change and backfill remain an unbounded in-place migration.", severity: "medium", files: ["db/migrations/004_add_order_status.sql"] },
];

const ACTIONS_2 = [
  { priority: 1, action: "Put the order and payment writes inside one transaction, move email to an outbox, and rethrow failures.", file: "src/orders/orderService.ts", findingId: "F-001" },
  { priority: 2, action: "Authenticate both routes, derive the customer from the session, and validate the refund amount.", file: "src/api/orders.ts", findingId: "F-004" },
  { priority: 3, action: "Use a transaction callback or a pinned connection for refunds.", file: "src/orders/refundService.ts", findingId: "F-017" },
  { priority: 4, action: "Add a unique idempotency key to refunds and return the existing record on retry.", file: "src/orders/refundService.ts", findingId: "F-018" },
  { priority: 5, action: "Split the bigint change and backfill into expand, backfill, and contract steps.", file: "db/migrations/004_add_order_status.sql", findingId: "F-019" },
];

function buildReview({ context, findings, fileSummaries, blockNotes, verdict, headline, overview, iterationNote, resolutions = [], flow, risks, nextActions }) {
  const byFile = new Map();
  for (const finding of findings) {
    if (!byFile.has(finding.file)) byFile.set(finding.file, []);
    byFile.get(finding.file).push(finding);
  }
  const fileReviews = context.files.map((file) => {
    const fileFindings = byFile.get(file.path) || [];
    return {
      file: file.path,
      risk: fileRisk(fileFindings),
      summary: concise(fileSummaries[file.path] || "Reviewed the changed file and its blocks.", 230),
      blocks: (file.blocks || []).map((block) => {
        const blockFindings = fileFindings.filter((finding) => finding.blockId === block.id);
        const note = blockNotes[`${file.path}|${block.id}`];
        return {
          id: block.id,
          assessment: note ? note[0] : assessmentFor(blockFindings),
          summary: concise(note ? note[1] : blockFindings.length
            ? `Reviewed this block. The main issue is “${blockFindings[0].title}”.`
            : "Reviewed this block. No additional issue was found.", 150),
        };
      }),
    };
  });
  return {
    schemaVersion: 1,
    verdict,
    headline: concise(headline, 180),
    overview: concise(overview, 700),
    iterationNote: concise(iterationNote, 500),
    risks: (risks || []).map((risk) => ({ ...risk, detail: concise(risk.detail, 180) })),
    nextActions: (nextActions || []).map((action) => ({ ...action, action: concise(action.action, 180) })),
    flow,
    findings,
    resolutions,
    fileReviews,
  };
}

function buildIteration1(root, context) {
  const findings = FINDINGS_1.map((spec) => makeFinding(context, root, spec));
  return buildReview({
    context,
    findings,
    fileSummaries: FILE_SUMMARIES_1,
    blockNotes: BLOCK_NOTES_1,
    verdict: "blocked",
    headline: "Checkout can take money without leaving a consistent order.",
    overview: "This change adds checkout, a second refund path, and a migration. The order is saved before payment. A failed payment still returns success. The SQL is interpolated and the routes have no authentication. The migration drops a supporting index. Do not ship this money path yet.",
    iterationNote: "First review. Checkout, refunds, and the migration are new or rewritten.",
    flow: makeFlow(1),
    risks: RISKS_1,
    nextActions: ACTIONS_1,
  });
}

function buildIteration2(root, context) {
  const findings = FINDINGS_2.map((spec) => makeFinding(context, root, spec));
  return buildReview({
    context,
    findings,
    fileSummaries: FILE_SUMMARIES_2,
    blockNotes: BLOCK_NOTES_2,
    verdict: "blocked",
    headline: "Refunds are safer, but checkout still commits before payment.",
    overview: "This iteration fixes cancel and the PII log. It parameterizes refunds and makes the migration safer. Checkout still saves before payment and swallows the error. Refunds still lack a pinned connection and an idempotency key.",
    iterationNote: "Fixed cancel, the PII log, refund SQL injection, the dropped customer index, and the refund race. Checkout still needs a transaction. Refunds still need a pinned connection and an idempotency key.",
    resolutions: RESOLUTIONS_2,
    flow: makeFlow(2),
    risks: RISKS_2,
    nextActions: ACTIONS_2,
  });
}

function applyIteration2Changes(root) {
  writeText(path.join(root, "src/orders/orderService.ts"), `import { db } from "../db/client";
import { Order, OrderRepository } from "./orderRepository";
import { sendEmail } from "../notifications/email";

export class SmtpEmailClient {
  async send(to: string, subject: string, body: string) {
    return sendEmail({ to, subject, body });
  }
}

export class OrderService {
  private readonly emailClient = new SmtpEmailClient();

  constructor(private readonly orders: OrderRepository) {}

  async checkout(customerId: string, cart: any): Promise<any> {
    let total = 0;
    const lines = [];

    for (const item of cart.items) {
      const product = await db.query(\`SELECT * FROM products WHERE id = '\${item.productId}'\`);
      if (!product) {
        throw new Error("Missing product");
      }
      if (item.quantity <= 0) {
        throw new Error("Quantity must be positive");
      }
      total += product.price_cents * item.quantity;
      lines.push({ name: product.name, total: product.price_cents * item.quantity });
    }

    const tax = total * 0.2;
    total = total + tax;

    const order: Order = {
      id: crypto.randomUUID(),
      customerId,
      totalCents: total,
      status: "pending",
    };

    await this.orders.save(order);

    try {
      const payment = await db.query(\`INSERT INTO payments (order_id, amount) VALUES ('\${order.id}', \${total})\`);
      if (!payment) {
        throw new Error("Payment failed");
      }
      const customer = await db.query(\`SELECT email FROM customers WHERE id = '\${customerId}'\`);
      const body = "Thanks for your order!\\n" + lines.map((line) => \`\${line.name}: \${line.total / 100}\`).join("\\n") + \`\\nTax: \${tax / 100}\`;
      await this.emailClient.send(customer.email, "Your order", body);
    } catch (error) {
      console.log("checkout failed", error);
    }

    return { order, lines };
  }

  async cancel(orderId: string): Promise<Order> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new Error("Order not found");
    if (order.status === "cancelled") return order;
    order.status = "cancelled";
    await this.orders.save(order);
    return order;
  }

  async refund(orderId: string, amount: number): Promise<any> {
    const order = await db.query(\`SELECT * FROM orders WHERE id = '\${orderId}'\`);
    if (!order) throw new Error("Order not found");
    if (order.total_cents < amount) throw new Error("Refund exceeds total");
    await db.query(\`UPDATE orders SET total_cents = total_cents - \${amount} WHERE id = '\${orderId}'\`);
    await db.query(\`INSERT INTO refunds (order_id, amount) VALUES ('\${orderId}', \${amount})\`);
    return { order, amount };
  }
}
`);

  writeText(path.join(root, "src/orders/refundService.ts"), `import { db } from "../db/client";

export async function refundOrder(orderId: string, amount: number) {
  await db.query("BEGIN");
  try {
    const [order] = await db.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (!order) throw new Error("not found");
    if (order.total_cents < amount) throw new Error("too much");
    await db.query("UPDATE orders SET total_cents = total_cents - $1 WHERE id = $2", [amount, orderId]);
    const [refund] = await db.query(
      "INSERT INTO refunds (order_id, amount) VALUES ($1, $2) RETURNING *",
      [orderId, amount],
    );
    await db.query("COMMIT");
    return refund;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
`);

  writeText(path.join(root, "db/migrations/004_add_order_status.sql"), `ALTER TABLE orders ADD COLUMN status text;
UPDATE orders SET status = 'pending' WHERE status IS NULL;
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded'));
ALTER TABLE orders ALTER COLUMN total_cents TYPE bigint;
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
`);
}

function copyDemoArtifacts(root) {
  ensureDir(DEMO_DIR);
  const runsDir = path.join(root, ".code-review", "runs");
  const current = path.join(root, ".code-review", "review.html");
  const vendorSource = path.join(SKILL_ROOT, "assets", "vendor", "pierre-diffs.js");
  const vendorTarget = path.join(DEMO_DIR, "vendor", "pierre-diffs.js");
  ensureDir(path.dirname(vendorTarget));
  fs.copyFileSync(vendorSource, vendorTarget);
  fs.copyFileSync(
    path.join(SKILL_ROOT, "assets", "vendor", "pierre-diffs.LICENSE.md"),
    path.join(DEMO_DIR, "vendor", "pierre-diffs.LICENSE.md"),
  );
  writeText(path.join(DEMO_DIR, "review.html"), readText(current));
  const demoRuns = path.join(DEMO_DIR, "runs");
  removeRecursive(demoRuns);
  ensureDir(demoRuns);
  for (const entry of fs.readdirSync(runsDir)) {
    const source = path.join(runsDir, entry, "review.html");
    if (!fs.existsSync(source)) continue;
    ensureDir(path.join(demoRuns, entry));
    writeText(path.join(demoRuns, entry, "review.html"), readText(source));
  }
  writeText(path.join(DEMO_DIR, "README.md"), `# Review console demo

This is a static, self-contained demo generated from a throwaway git repository.

- Open \`review.html\` directly. It is a read-only preview.
- To send notes, run the skill in a real repository. Use \`open\` and \`wait\`.
- The overview shows iteration 2 of 2, including the delta from iteration 1.
- The archived iteration 1 is linked from the timeline and lives in \`runs/\`.
- Keep \`vendor/\` with \`review.html\`. It contains the local code renderer.
- The files, findings, and flow are embedded in the artifact.
- Screenshots: \`overview.png\`, \`file.png\`, \`notes.png\`, \`light.png\`.
`);
}

function main() {
  const root = createFixture({ dir: FIXTURE_DIR });
  console.log(`fixture: ${root}`);

  const first = collectReview({ root, skillRoot: SKILL_ROOT, options: { untracked: true, fresh: true } });
  if (first.empty) throw new Error("Fixture produced no changes.");
  const review1 = buildIteration1(root, first.context);
  writeJson(path.join(first.dir, "review.json"), review1);
  const rendered1 = renderRun({ root, runId: first.runId });
  console.log(`iteration 1: ${rendered1.artifactPath} (${rendered1.data.findings.open} findings, ${rendered1.data.coveragePct}% coverage)`);

  applyIteration2Changes(root);
  const second = collectReview({ root, skillRoot: SKILL_ROOT, options: { untracked: true } });
  if (second.empty) throw new Error("Iteration 2 produced no changes.");
  const review2 = buildIteration2(root, second.context);
  writeJson(path.join(second.dir, "review.json"), review2);
  const rendered2 = renderRun({ root, runId: second.runId });
  console.log(`iteration 2: ${rendered2.artifactPath} (${rendered2.data.findings.open} findings, +${rendered2.data.findings.new} new, −${rendered2.data.findings.resolved} resolved, ${rendered2.data.coveragePct}% coverage)`);

  copyDemoArtifacts(root);
  console.log(`demo copied to: ${DEMO_DIR}`);
  console.log(`open: ${path.join(DEMO_DIR, "review.html")}`);
}

main();
