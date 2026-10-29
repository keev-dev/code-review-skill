# Agent setup

This repository is a local code-review skill. It is agent-agnostic. Any agent that can read files and run Node can use it.

## Requirements

- Node 20 or newer.
- Git.
- No external network access at runtime. The code renderer is vendored under `assets/vendor/`.

## Install into a repository

Run this from the repository you want to review:

```sh
node "/path/to/code-review/scripts/install.mjs"
```

The default target is `./.agents/skills/code-review`. Use `--global` only if the work machine allows a user-profile install.

## Use

1. Read `.agents/skills/code-review/SKILL.md`.
2. Read the method and lens files named by that document.
3. Run `collect`, fill `review.json`, run `render`, then `open`.
4. Keep `wait` in the foreground while the reviewer adds notes.

All review data stays in `.code-review/` inside the reviewed repository. Do not send the artifact or the source outside the machine.
