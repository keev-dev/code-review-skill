# Security

The skill is designed for local use on a developer machine.

## Data handling

- Review data stays in `.code-review/` inside the repository under review.
- The artifact contains old and new file contents for changed files. Treat it as source code.
- The skill sends no telemetry and makes no external network requests.
- The code renderer is vendored under `assets/vendor/`.

## Local review server

- Binds to `127.0.0.1`.
- Requires a random token for the review page and API calls.
- Rejects requests whose `Host` header is not `127.0.0.1`, `localhost`, or `::1`.
- Does not set a cross-origin response header.
- Limits request bodies.
- Adds a content security policy, referrer policy, and frame denial headers.

The review page includes source code. Do not expose the server through a proxy, tunnel, or container port. Stop it with `review.mjs stop` when the review is done.

## Reporting

Report a problem through the internal channel for the repository owner. Do not include source code or review artifacts in a public issue.
