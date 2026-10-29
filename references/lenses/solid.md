# SOLID lens

SOLID is a lens, not a scorecard. Use it to ask better questions about a change, not to demand a pattern in every file. A finding is only useful when you can point at the cost: a bug that becomes likely, a behavior that is hard to change, or a test that cannot be written without a real database.

## Before applying it

1. Read the whole changed file, not only the hunk.
2. Identify the unit of change: a function, class, module, service, or boundary.
3. Find its callers and its dependencies. A responsibility problem is invisible in isolation.
4. Decide whether the code is a **boundary** (transport, persistence, UI, orchestration) or a **policy** (business rule). Different rules apply.

## S — Single responsibility

**Question:** Does this unit have more than one reason to change?

Symptoms:

- A service validates input, calculates prices, writes the database, formats a receipt, and sends email.
- A class is named `Manager`, `Helper`, `Util`, or `Service` and its methods have no common subject.
- A method changes when transport, persistence, or presentation changes.
- A file imports both a database client and a template/HTML/email formatter.
- A private method exists only to support one public method, while another cluster of privates supports a different public method.

Useful finding: “OrderService owns the SMTP client and the receipt template; a change to the email provider or the template now touches the money path.”

Do not file a finding merely because a class has several methods. The test is **different reasons to change**, not method count.

## O — Open/closed

**Question:** When the next variant arrives, can we add it without editing this decision point?

Symptoms:

- A switch/if-chain on a type, provider, country, plan, or event kind that must be edited for every new case.
- A growing set of booleans (`isStripe`, `isPayPal`, `isRefund`, `isPartial`).
- A registry/factory that requires edits in several files for one new variant.
- A base class with hooks that every subclass must override, where the base knows all subclasses.

Useful finding: “Adding a third payment provider requires editing the checkout service, the webhook router, and the receipt formatter; a provider interface plus a registry would localize the change.”

Do not demand an abstraction for one stable case. Speculative generality is its own smell. A switch is acceptable when the set is closed by a protocol or a database constraint.

## L — Liskov substitution

**Question:** Can every implementation or subtype be used through the declared contract without surprises?

Symptoms:

- An override throws for methods the base allows, or silently does less.
- A subtype narrows accepted inputs or widens returned outputs.
- `instanceof` checks leak into callers because implementations behave differently.
- A fake in tests is more permissive than production, hiding contract violations.
- Optional methods are called unconditionally.

Useful finding: “The `RefundGateway` contract promises a refund id, but the legacy adapter returns `null` on success; callers dereference it and crash for that provider only.”

Check the call sites, not just the class. Liskov problems often surface as conditional handling in the consumer.

## I — Interface segregation

**Question:** Does a consumer depend on methods it never uses?

Symptoms:

- A broad interface/port with ten methods, where each consumer uses two.
- Test doubles must implement unrelated methods.
- A change to an unused method forces recompilation or edits in every consumer.
- A “god” repository interface mixing orders, customers, and refunds.

Useful finding: “The checkout policy only needs a price lookup, but it takes the full `OrderRepository`; every test now needs save, find, and delete stubs.”

Prefer narrow, role-named interfaces at the consumer boundary. Do not split interfaces solely for aesthetics if the cost is low and the boundary is internal.

## D — Dependency inversion

**Question:** Does high-level policy depend on a detail, and is that dependency controlled at the edge?

Symptoms:

- A service constructs `new SmtpEmailClient()`, `new StripeClient()`, or a concrete repository inside itself.
- A domain module imports a framework, ORM, HTTP client, or SDK.
- Configuration/secrets are read deep inside business logic.
- A class cannot be tested without a network or a database because its collaborators are hard-wired.

Useful finding: “`OrderService` constructs its SMTP transport and formats the message body in `checkout`. Inject a notifier port and keep transport construction in the composition root.”

Do not demand dependency injection in a small script, a migration, or a one-off job. The question is whether the dependency makes the policy hard to change or test. A function parameter is often enough; a framework container is not required.

## Cross-file checks

- Who calls the changed unit? Are they now forced to know a new detail?
- Does the interface belong to the consumer or the provider? (It usually belongs to the consumer.)
- Is there a second implementation of the same concept in the change? Two refund paths, two formatters, two notifiers.
- Do tests have to construct the world because the unit owns its collaborators?
- Does the change move policy into a controller, a job, or a migration?

## Severity guide

| Severity | When |
|---|---|
| High | The design defect is causing or likely to cause a correctness, security, or data-integrity failure; or it blocks testing the money path. |
| Medium | A real maintenance cost introduced by this change: duplicated policy, a hard-wired external dependency, a broad interface that every new consumer must fake. |
| Low | Local readability or a small boundary improvement that can wait. |
| Question | The design intent is unclear; ask before recommending a structural change. |

A SOLID finding without a concrete cost is usually a nit. Do not inflate it.

## Good and weak findings

Good:

> **OrderService owns its SMTP transport and formats the receipt** — The service constructs `SmtpEmailClient`, builds the email body, and sends it inside `checkout`. A provider change or template change now edits the money path, and the test needs a real transport. Inject a narrow `Notifier` and move formatting to a presenter. `orderService.ts:11–57`

Weak:

> **This class violates SRP** — no evidence, no cost, no smallest fix.

Also weak:

> **You should use a repository pattern** — the code already has one; the problem may be its interface or its use, not the pattern's absence.

## What not to flag

- A class with several cohesive methods.
- A small script that wires its own dependencies.
- A switch over a genuinely closed set.
- A missing interface around a stable standard-library call.
- Pattern names used as arguments. Name the behavior and the cost instead.
