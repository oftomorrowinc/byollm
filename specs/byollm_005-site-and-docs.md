# byollm_005 — Landing site + docs

**Status: bones in `site/index.html`; this spec is the build-out.**
The landing page exists as a single self-contained HTML file (dark,
developer-focused, no dependencies). Two jobs: harden the landing
into a deployable site, and stand up real docs.

## 1. Landing (`site/`)

- The current `site/index.html` is the design + copy of record. Keep
  it **self-contained and dependency-free** (it must open from a file
  and deploy to any static host / GitHub Pages / Vercel with zero
  build).
- Add: an OG/Twitter card image + meta; a favicon (the green dot);
  a real "copy" affordance with copied-state feedback; prefers-
  reduced-motion honored; Lighthouse ≥95 all categories; the
  npm/GitHub links go live when the packages publish.
- Keep the honesty rules from the product itself: never claim a
  capability the code doesn't ship (the security section's
  breakout-vs-injection boundary is load-bearing marketing *and*
  true — do not soften it).
- Deploy target: `byo-llm.com` (static), on Vercel — **live 2026-08-12**
  from the `byo-llm-www` project, apex CNAME through Cloudflare
  (DNS-only; proxying Vercel redirect-loops). `getbyollm.com` was
  considered and dropped — one canonical name, no redirect to keep
  alive.

## 2. Docs

Docs are **generated, never hand-drifted** (the standards rule).
Structure:

- **Quickstart (devs)** — the three-file integration, runnable.
- **Quickstart (users)** — `npx byollm connect`, config, the trust
  commands.
- **Protocol reference** — rendered from `@byollm/protocol` (the
  normative `docs/protocol.md` + generated type docs).
- **Server adapters** — in-memory, Next mount, Supabase; how to
  write your own against `JobStore`/`RunnerStore`.
- **Backends** — Ollama, claude CLI, MLX; how to add one (and the
  requirement that a new backend ships adversarial-suite rows).
- **Security** — the full threat model from `byollm_004`, verbatim,
  with the breakout-vs-injection distinction front and center.
- **Audience & sharing** — the nine-way matrix, the subscription
  self-lock, how to enable community compute.
- **Conformance** — how to certify a server; the one command.

Tooling: a lightweight docs generator (e.g. a static-site tool that
consumes markdown + TSDoc); **every code sample executes in CI** so
docs can't rot. Docs and site share the landing's visual language
(same tokens) but docs are their own surface — do not cram reference
material onto the landing page.

## Out of scope

Blog/changelog site (later), i18n, interactive playground (a
"try it" sandbox is tempting but needs a hosted model — defer).

## Done when

`site/` deploys to `byo-llm.com` as static files; docs build from source with every example passing in CI;
protocol + type reference are generated, not hand-written; Lighthouse
≥95; nothing on either surface claims a capability the shipped code
lacks.
