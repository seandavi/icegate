# AGENTS.md

Conventions for AI agents (and humans) working on icegate.

## What this project is

icegate is a stateless edge gateway for Apache Iceberg REST Catalogs.
**SPEC.md is the design source of truth** — read it before writing code.
Several SPEC sections encode hard-won research findings (client config-merge
behavior, R2 addressing, the `defaults.uri` bypass); treat MUSTs literally.
If your change contradicts the SPEC, update SPEC.md in the same commit and
say so in your report.

## Work tracking: the issues are the docs

Work is charted as a wayfinder map:
[issue #1](https://github.com/seandavi/icegate/issues/1), with tickets as
its sub-issues and blocking via GitHub's native issue dependencies.

- **Findings and rationale live on the issues.** A ticket resolves with a
  resolution comment carrying the full detail (research findings, decisions,
  verification results) — not a link to a chat log. Anything *normative*
  lands as a SPEC.md edit in the same session. No `docs/research/` or
  `docs/adr/` unless a document outgrows an issue comment.
- **Claiming**: assign yourself before any work. An open, unassigned,
  unblocked ticket is the frontier — takeable.
- **Resolving**: comment the resolution, close the issue, add a one-line
  gist + link to the map's "Decisions so far".

## Parallel work: use git worktrees

Agents working concurrently MUST NOT share a checkout — one agent's
uncommitted files pollute another's `git status` and commits.

```sh
git worktree add ../icegate-<ticket> main   # work here
git worktree remove ../icegate-<ticket>     # after your push lands
```

- Commit only files you created or changed; message ends with `(#<ticket>)`.
- `git pull --rebase` before pushing; on conflict, rebase and retry once.
- Everything merges to `main` — no long-lived branches.

## Stack (decided — don't relitigate)

TypeScript (strict) · Hono · Zod with `.strict()` everywhere · `yaml` ·
npm + Vitest (`@cloudflare/vitest-pool-workers`) · wrangler.
Decisions and their rationale: issues [#4](https://github.com/seandavi/icegate/issues/4)
and [#5](https://github.com/seandavi/icegate/issues/5).

- Workers is the primary target, Node.js secondary: core code is written
  against the standard fetch handler (`Request → Response`) — **no
  runtime-specific APIs in core** (no `process.env` outside `src/node.ts`,
  Web Crypto not `node:crypto`).
- The Prometheus `/metrics` endpoint is wired into the Node entry only
  (SPEC §14).
- Config: single YAML, bundled at build time, `${VAR}` resolved from a
  caller-supplied env map.

## Coding rules

- Lazy and minimal: smallest working diff, no speculative abstractions,
  no scaffolding "for later". Deletion beats addition.
- **No new dependencies** without a decision recorded on an issue.
- Non-trivial logic lands with a test. Before pushing, both must be green:
  `npx tsc --noEmit` and `npx vitest run` (the full suite, not just yours).
- Report honestly: if something wasn't verified, say so — never claim
  success you didn't observe.
