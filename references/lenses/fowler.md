# Fowler lens

This lens uses the vocabulary and refactorings from Martin Fowler's *Refactoring: Improving the Design of Existing Code* (2nd edition). A smell is a **hint that a refactoring may pay off**, not a rule. Always connect the smell to a concrete cost in this change: a bug that becomes likely, a behavior that is hard to test, or a change that would fan out across files.

## How to apply it

1. Read the changed code and the code immediately around it.
2. Name the smell precisely (for example, “Long Method” or “Shotgun Surgery”), not just “bad design”.
3. Show the evidence: the method length, the duplicated block, the callers that must change together.
4. Name the smallest useful refactoring. Do not propose a rewrite when an Extract Function or Move Function will do.
5. Decide whether the refactoring belongs **in this change** or in a follow-up. A review finding can recommend a follow-up without blocking the change.

## Smell catalog

### Bloaters

**Long Method** — A method has too many levels of abstraction or too many reasons to read it.
Ask: Can the steps be named? Are validation, calculation, persistence, and presentation in one body? Is there a natural “split phase”?
Usually: Extract Function, Extract Class, Split Phase, Replace Temp with Query, Decompose Conditional.

**Large Class** — A class accumulates unrelated state or behavior.
Ask: Which fields are used together? Which public methods form separate clusters? Is this class a boundary plus a policy?
Usually: Extract Class, Extract Subclass, Move Field/Function.

**Long Parameter List** — A call site needs a comment to explain its arguments, or booleans are passed positionally.
Ask: Do these values travel together? Is there a domain object or parameter object? Does the callee use every parameter?
Usually: Introduce Parameter Object, Preserve Whole Object, Replace Parameter with Query.

**Data Clumps** — The same three or four values appear together in many signatures.
Ask: Is this a missing value object (Money, DateRange, Address, CustomerId)?
Usually: Extract Class, Introduce Parameter Object.

**Primitive Obsession** — Strings/numbers carry domain meaning and validation is repeated.
Ask: Are currency, email, phone, status, or IDs represented as raw strings/numbers? Is rounding implicit?
Usually: Replace Primitive with Object, Replace Type Code with Class, Introduce Value Object.

### Object-orientation abusers

**Switch Statements** — The same conditional on a type repeats in several places, or a new case touches many files.
Ask: Is the set genuinely closed? Is this a protocol enum where a switch is the clearest form? If it is open, would polymorphism or a registry localize the change?
Usually: Replace Conditional with Polymorphism, Replace Type Code with Subclasses, Introduce Strategy/Registry.

**Temporary Field** — A field is meaningful only during one operation.
Ask: Can the value be a parameter or a local? Is the object in an invalid state between calls?
Usually: Extract Class, Introduce Null Object, Replace Method with Method Object.

**Refused Bequest** — A subclass ignores or throws on inherited behavior.
Ask: Is inheritance the right relationship, or is this composition? Does the base promise something the child cannot deliver?
Usually: Replace Inheritance with Delegation, Extract Superclass/Interface.

**Alternative Classes with Different Interfaces** — Two implementations of the same concept have incompatible shapes.
Ask: Are callers branching on the implementation? Could one adapter or interface unify them?
Usually: Rename/Adjust Interface, Extract Interface, Adapter.

### Change preventers

**Divergent Change** — One class changes for many unrelated reasons.
Ask: Which changes have landed here historically? Can you name the separate axes?
Usually: Extract Class, Split Phase, Move Function.

**Shotgun Surgery** — One logical change requires edits in many files.
Ask: Is a concept spread across layers with no single owner? Are there duplicated rules?
Usually: Move Function/Field, Inline Class, Extract Class, Consolidate Conditional.

**Parallel Inheritance Hierarchies** — Adding a subclass in one hierarchy forces a subclass in another.
Ask: Can one hierarchy own the variation, or can composition replace the second?
Usually: Move Function/Field, Collapse Hierarchy, Replace Inheritance with Delegation.

### Dispensables

**Comments as deodorant** — A comment explains code that could say it itself.
Ask: Is the comment explaining *why* (keep it) or *what* (rename/extract)? Is the comment stale relative to the code?
Usually: Extract Function, Rename, Introduce Assertion. Do not delete genuinely useful why-comments.

**Duplicate Code** — The same rule or shape appears in two places and can drift.
Ask: Is the duplication accidental or a deliberate boundary? Will the copies change together? Is one copy already divergent?
Usually: Extract Function/Class, Pull Up Method, Form Template Method, Move Function.

**Lazy Class** — A class does too little to justify its existence.
Ask: Does it own a boundary, a policy, or a lifecycle? Would a function or a field be clearer?
Usually: Inline Class, Collapse Hierarchy.

**Data Class** — A class only holds fields and getters while behavior lives elsewhere.
Ask: Is this a DTO at a boundary (fine) or a domain object whose rules are scattered (not fine)?
Usually: Move Function, Encapsulate Field/Collection, Remove Setting Method.

**Dead Code** — Unreachable, unused, or permanently disabled code.
Ask: Is it referenced, feature-flagged, or kept for a migration window? Is the flag still live?
Usually: Remove Dead Code. Do not remove code that is part of an in-progress compatibility window without confirming.

**Speculative Generality** — Hooks, parameters, or abstractions for a future that has not arrived.
Ask: Is there a current caller? Is the variation real or imagined? Would deleting it make the change smaller?
Usually: Collapse Hierarchy, Inline Class/Function, Remove Parameter.

### Couplers

**Feature Envy** — A method is more interested in another object's data than its own.
Ask: Which object owns the rule? Is the method reaching through several getters?
Usually: Move Function, Extract Function, Move Field.

**Inappropriate Intimacy** — Two classes know each other's internals.
Ask: Is there a missing boundary? Are private details leaking through public fields or bidirectional references?
Usually: Move Function/Field, Extract Class, Change Bidirectional Association to Unidirectional.

**Message Chains** — `a.getB().getC().getD()` makes the caller depend on the whole path.
Ask: Is this a stable data structure or a navigation through policy? Would a method on the owner hide the path?
Usually: Hide Delegate, Extract Function, Move Function.

**Middle Man** — A class mostly forwards calls.
Ask: Does it add a boundary, policy, or lifecycle? If not, can callers use the target directly?
Usually: Remove Middle Man, Inline Class.

## Refactorings worth naming in findings

- **Extract Function** — name a block; reduces Long Method and comments-as-deodorant.
- **Inline Function/Class** — remove indirection that no longer earns its keep.
- **Move Function/Field** — put behavior with the data it uses.
- **Extract Class** — split a class by reason to change.
- **Introduce Parameter Object / Preserve Whole Object** — tame data clumps and long parameter lists.
- **Replace Conditional with Polymorphism** — localize an open variant set.
- **Replace Magic Literal with Symbolic Constant** — only when the literal carries domain meaning.
- **Separate Query from Modifier** — a function should either return a value or change state, not surprise the caller with both.
- **Split Phase** — separate parsing/validation/calculation from side effects.
- **Strangler Fig / Branch by Abstraction** — migrate a legacy path in small, reversible steps.
- **Remove Dead Code** — smaller is usually better when the code is genuinely unused.

## Cross-file smells

- **Shotgun Surgery** is proven by a list of files that must change together. Include them.
- **Divergent Change** is proven by a class that has changed for unrelated reasons; use history or the current change as evidence.
- **Duplicate Code** is proven by showing both copies and the rule they share. Do not call two similar-looking blocks duplication if their reasons to change differ.
- **Parallel Inheritance** is proven by a new subclass forcing another subclass; show both.

## Severity guide

| Severity | When |
|---|---|
| High | The smell is already causing a correctness/security/data bug, or a small change now requires edits in several risky places. |
| Medium | The smell adds real change cost or duplication risk in this change; a focused refactoring is practical now. |
| Low | A local readability improvement with little behavioral risk; okay to defer. |
| Question | The intent or future direction is unclear; ask before recommending a refactor. |

A refactoring that is larger than the change itself should usually be a follow-up, not a merge blocker.

## Good and weak findings

Good:

> **Refund logic is duplicated in OrderService and refundService** — Both paths look up the order, compare the amount, debit the total, and insert a refund. The copies already differ in their locking behavior. Keep one module and call it from both routes. `orderService.ts:56–70`, `refundService.ts:3–16`

Weak:

> **This method is too long; refactor it** — no named smell, no cost, no smallest move.

Weak:

> **Use the Strategy pattern** — names a pattern without showing the variant set or the change it would localize.

## What not to flag

- Formatting, naming taste, or import order that a formatter/linter owns.
- A long method that is a flat, readable sequence with one reason to change.
- Duplication that is a deliberate boundary between two deployables with independent lifecycles.
- A switch over a closed protocol enum.
- A refactor that would touch more code than the change itself unless there is a concrete risk.
