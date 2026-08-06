# Contributing to icegate

Thanks for considering it. The short version:

- **SPEC.md is the design source of truth.** Read it before writing code. If
  your change contradicts it, update SPEC.md in the same PR and say so.
- **Working conventions** (worktrees, ticket claiming, commit style, coding
  rules) live in [AGENTS.md](AGENTS.md) — they apply to humans too.
- **Dev setup, architecture, and how to run the tests** are in the
  [developer guide](docs/developers.md).
- Before pushing, both must be green: `npx tsc --noEmit` and
  `npx vitest run`. Non-trivial logic lands with a test.
- **No new dependencies** without an issue recording the decision.
- Open an issue before large changes; small fixes can go straight to a PR.

By contributing you agree your contributions are licensed under the
[Apache License 2.0](LICENSE).
