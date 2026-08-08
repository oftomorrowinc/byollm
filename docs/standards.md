# Engineering standards (open-source bar)

This repo ships publicly under the Of Tomorrow name. The bar matches
our published-library discipline, enforced by CI rather than review
vigilance:

- **TypeScript strict** everywhere; no `any` without a commented
  reason. Public API surfaces carry TSDoc; docs are generated, not
  hand-drifted.
- **Tests first-class**: vitest; coverage gate ≥90% lines/branches on
  `protocol` and `server`, ≥85% on `daemon` (process-spawning code
  earns a small allowance); the **conformance kit runs in CI** with a
  real daemon against the reference server on every PR.
- **Lint/format**: eslint (typescript-eslint strict) + prettier,
  zero-warning CI. `knip` for dead code and unused deps; duplication
  checked (jscpd) — extraction beats repetition, but only into the
  package where the meaning lives.
- **Dependency minimalism**: every runtime dep justified in
  `docs/deps.md`. The daemon must install fast on a stranger's
  laptop; prefer zero-dep where the platform provides.
- **Docs are part of done**: each package has a README that a
  stranger can act on in five minutes; `docs/protocol.md` is
  normative (MUST/SHOULD language); every example in docs is
  executed in CI (doctest-style) so docs cannot rot.
- **Versioning**: changesets; packages version together (lockstep) —
  the conformance kit is the compatibility contract, semver
  communicates intent.
- **License**: MIT (Todd to confirm before first publish).
- House rules apply: specs `byollm_NNN` committed immediately; one
  door per state write; zero and unknown never look alike in any UI
  or log.
