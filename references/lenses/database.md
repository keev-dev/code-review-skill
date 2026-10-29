# Database lens

Database changes fail in ways application code does not: they can lock a production table, lose data on rollback, silently change an index plan, or let two requests spend the same money. Treat this lens as safety-first. If a file is routed to this lens, read the whole file and the surrounding schema, migrations, queries, and callers before judging a line.

## First classify the change

- **Schema** — a table, column, type, constraint, index, enum, or relationship.
- **Migration** — an ordered operation against existing production data.
- **Query** — read/write shape, filters, joins, sorting, pagination, plan.
- **Transaction/concurrency** — boundaries, isolation, locks, retries, idempotency.
- **Data access layer** — repository/DAO/ORM mapping, connection pool, tenancy.
- **Data contract** — what the API/queue/report expects from the stored shape.

A single file can be several of these. Say which one you are judging.

## Migration safety checklist

### Compatibility and deploy order

- Can the previous application version run against the new schema? Can the new version run against the old schema during a rolling deploy?
- Is this an **expand / backfill / contract** change or a single destructive step?
- Does it rename, drop, or change the type of something still used by old code?
- Are old and new code paths both able to read and write during the transition?
- Is the migration idempotent if the deploy retries?
- Is there a rollback/down migration, and does it preserve data?

### Locks and availability

- `ALTER TABLE ... ALTER COLUMN ... TYPE` often rewrites the table and holds a strong lock. Is the table large? Can the change use a new column + backfill + switch instead?
- `SET NOT NULL` scans the table unless a validated check constraint or a safe pattern is used.
- `ADD COLUMN ... DEFAULT` can rewrite older PostgreSQL versions; volatile defaults and large tables need scrutiny.
- `CREATE INDEX` without `CONCURRENTLY` blocks writes for the build. `CONCURRENTLY` cannot run inside a transaction; confirm the migration runner's behavior.
- `DROP INDEX` removes a plan that a live query may depend on. Is there a replacement index, and is it live before the drop?
- `LOCK TABLE`, long transactions, and foreign-key validation can queue behind one another.
- Are lock timeouts and statement timeouts set for the migration session?
- Does the migration run in one transaction, and does that make a concurrent index or batched backfill impossible?

### Backfills

- Is the `UPDATE` bounded? An unbounded update on a large table holds locks and bloats WAL.
- Is it batched in primary-key order, resumable, and safe to run more than once?
- Is the application still writing rows during the backfill? How are new rows handled?
- Is progress observable? Can the migration pause and resume?
- Is the backfill rate limited to protect replicas and latency?

### Constraints and data integrity

- Are `NOT NULL`, `CHECK`, `UNIQUE`, and foreign keys present where the domain requires them?
- Is a new constraint validated against existing dirty data without a long exclusive lock? (`ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT`.)
- Are status transitions and allowed values constrained, or only documented?
- Are uniqueness rules race-safe, or only checked in application code?
- Does a column have a misleading default that hides missing data?
- Are cascading deletes/updates intentional and bounded?

### Types and serialization

- Money: integer minor units vs float; currency; rounding; unit changes (cents → dollars, integer → bigint).
- Time: `timestamptz` vs `timestamp`; UTC; time zone at the boundary; clock skew.
- IDs: text/uuid/bigint; generation location; sortability; exposure.
- JSON: schema versioning, validation, indexing, queryability.
- `bigint` can exceed JavaScript's safe integer; JSON serialization can silently lose precision.
- Enum changes: adding values, removing values, ordering, and application compatibility.

### Destructive changes

- `DROP COLUMN`, `DROP TABLE`, truncation, and type narrowing require a restore plan.
- Is the data still needed for audit, legal, or a downstream system?
- Is a backup or table copy verified, not just assumed?
- Does the application stop writing before the drop?
- Is the rollback possible after the deploy window?

## Query checklist

### Correctness and safety

- Are all values parameterized? Are dynamic identifiers chosen from an allowlist, not concatenated?
- Are `NULL` semantics correct (especially `NOT IN`, outer joins, unique indexes, and partial indexes)?
- Does the query return the rows/columns the caller expects, with stable ordering?
- Are pagination and limits stable under inserts/updates? (Offset pagination drifts; keyset pagination is often better.)
- Are permissions/tenant filters enforced in the query or by row-level security? Is that boundary proven?
- Does a write check authorization and ownership, or only the caller's claim?

### Shape and plan

- `SELECT *` pulls columns the caller does not need and makes schema changes wider.
- What index supports the filter and sort? Is the composite column order correct? Is a partial index possible?
- Is there an N+1 query behind a loop, serializer, or lazy ORM relation?
- Are there redundant queries or a missing join? Is a count query avoided when a page query can tell enough?
- Is the query bounded? An unbounded list can become a latency and memory incident.
- Does an `ORDER BY` have a matching index, or does it sort the whole result?
- Is a write path doing read-modify-write without a lock or atomic condition?

### Transactions and concurrency

- Is the unit of work explicitly transactional? Do all writes share one connection?
- Does the code issue `BEGIN`/`COMMIT` through a pool or generic query call? A pool may switch connections between statements.
- Is the isolation level appropriate? Does read-then-write need `SELECT ... FOR UPDATE`, an atomic `UPDATE ... WHERE`, or a serializable retry?
- Are locks acquired in a consistent order to avoid deadlocks?
- Is the operation idempotent under retries? Is there an idempotency key with a unique constraint?
- Are retryable errors (deadlock, serialization failure, unique violation) mapped deliberately?
- Can a retry double-charge, double-refund, double-send, or double-create? What is the durable dedupe key?
- Are webhooks/queues at-least-once? Does the consumer dedupe?
- Is an outbox/event written in the same transaction as the state change, or can the event be lost?
- Does a long transaction hold locks while calling a remote service or sending email?

### Scale and operations

- Does the query scan a growing table without a limit or partition?
- Is the connection pool sized for the workload and the database's limit? Are connections released on every path?
- Is a hot row or sequence a contention point?
- Are expensive reports run on a replica or with a timeout?
- Is the new query observable (latency, rows, errors) without logging PII?
- Is a migration's index build tracked and throttled?

## Data modeling

- Is the table's key stable and unique? Is a natural key being used where it can change?
- Are relationships enforced by foreign keys, or only in application code? If only in code, why?
- Is denormalized data derived and repaired, or can it drift?
- Are soft deletes used? Do queries and unique constraints account for them?
- Is audit/history required? Is it append-only and immutable?
- Are multi-tenant rows scoped by a tenant id in every unique index and query?
- Are PII and secrets classified, minimized, encrypted, and excluded from logs?

## Cross-file checks (required)

For a database finding, inspect at least:

1. The schema or model that defines the shape.
2. The migration that changes it.
3. The query/repository that reads or writes it.
4. The caller that decides the values (controller, job, event consumer).
5. The tests or fixtures that claim to cover it.
6. Any index, constraint, or deployment note that makes the change safe or unsafe.

Evidence should name the files and line references that prove the relationship. “This query will be slow” is not enough; name the filter/sort, the index being dropped or missing, and the caller that makes it hot.

## Severity guide

| Severity | When |
|---|---|
| Blocker | The change can lose/corrupt data, double-spend money, take a critical table offline, or leave production in an unrecoverable state. |
| High | A migration is unsafe at current scale; a query is injectable/unauthorized; a transaction boundary is missing on a money path; an index drop breaks a production query; a refund/charge is not idempotent. |
| Medium | A real performance or correctness risk with a bounded blast radius; a missing constraint/index that will degrade; an unbounded backfill with a mitigation. |
| Low | A local query/type improvement, an index that is nice to have, or observability. |
| Question | The data volume, deploy constraints, or ownership is unknown; ask before asserting. |

## Good and weak findings

Good:

> **The migration drops the customer index the new query depends on** — `findByCustomer` filters by `customer_id` and sorts by `created_at`; this migration drops `orders_customer_id_idx` and creates no replacement. On a large table the new route becomes a sequential scan. Keep the index until a composite `(customer_id, created_at DESC)` index is live. `004_add_order_status.sql:6`, `orderRepository.ts:25`

Weak:

> **This SQL could be faster** — no query shape, no plan, no index, no caller.

Weak:

> **Use a transaction** — no unit of work, no failure path, no consistency claim. Show what is written outside the boundary and what a caller sees when it fails.

## What not to flag

- A small lookup on a small table that is obviously bounded.
- A deliberate denormalization with a repair path and a stated reason.
- A single-statement atomic update that is already safe without an explicit transaction.
- A missing index when the access pattern is not in the change and there is no evidence it is hot.
- Application-level business rules that do not affect data integrity.
