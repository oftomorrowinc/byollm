# BYOLLM — Plan

**What this is.** Bring Your Own LLM: a small protocol plus two npm
packages that let any web app's users execute that app's LLM jobs on
their *own* models and subscriptions — their Ollama box, their MLX
machine, their claude CLI — via an outbound daemon they run and
control. Extracted from the of-tomorrow-framework runner design
(its spec 032); built here as a standalone product so every suite
(press, customer discovery, others, and third-party developers) can
adopt it instead of building bespoke.

## Shape: one monorepo, three packages, one protocol

- `packages/protocol` — the wire contract (five endpoints: pair,
  claim, heartbeat, result, revoke; lease semantics; typed job
  kinds) as TypeScript types + `docs/protocol.md`. The invariants
  are **protocol MUSTs the daemon enforces**, not documentation:
  typed job kinds only (a server can never ship code to a user's
  machine); one daemon pairs to one user; the daemon refuses work
  not attributable to its paired user; no pooling.
- `packages/daemon` — what end-users run: `npx byollm connect
  https://app.example.com`. Pluggable backends (v1: **Ollama first**
  — the zero-ToS wedge every AI app gets asked for — then claude
  CLI as the user's-own-work subscription tier; MLX later).
  Capability detection, atomic claim honoring leases, resumable,
  **ingress log + pause switch + per-app visibility** — the daemon
  is the user's trust anchor and the meter UI is the product's soul.
- `packages/server` — what developers drop into their backend:
  framework-agnostic handlers implementing the protocol over their
  queue/auth, plus a first-party **Supabase adapter** (jobs tables,
  RLS claim RPC, runners registry) that the of-tomorrow-framework's
  runner module will consume.
- **Conformance kit** — daemon and server tested against each other;
  a third-party server is "compatible" when the kit passes against
  it. Same versioning philosophy as the framework: the tests are the
  contract.

## Deliberately absent from v1

Streaming (batch jobs first; the protocol reserves room for a
token-stream lane in v2 — interactive apps will want it). Any
marketplace/pooling of compute (never — it breaks the trust model
and the provider-terms posture). Windows daemon polish (macOS/Linux
first).

## Identity

**npm org `byollm`: secured (2026-08-08).** Naming resolved at first
publish (2026-08-10): the daemon **is** the bare package `byollm`,
rather than `@byollm/daemon` plus a placeholder — a placeholder has no
bin, so it could never have made `npx byollm connect …` work.
Libraries stay scoped: `@byollm/protocol`, `@byollm/server`,
`@byollm/conformance`.

**Published 2026-08-10 under the `alpha` tag only**, with `latest`
left empty on purpose: `byollm` and `@byollm/protocol` at
0.1.0-alpha.0. `@byollm/server` and `@byollm/conformance` are marked
`private` until they have miles — delete that line to ship them.

Still to claim: `byo-llm.com` (available — buy as insurance) and a
check on `byollm.dev`. Still to do: **make the repo public** — it is
private today, so both packages ship with no `repository` field rather
than advertising a link that 404s. Repo home:
**`oftomorrowinc/byollm`** (decided 2026-08-08) — the npm scope is the
dev-facing identity; no separate GitHub org needed. Parked
`byollm.com` acquirable later if warranted.

## Relationship to the other repos

- of-tomorrow-framework: gains a thin **runner module** = daemon docs
  + the Supabase server adapter. Press never builds its 032 bespoke.
- Customer Discovery: not in v1 (hosted API); future option for
  trainee-side local models.
- Specs here: `byollm_NNN`, committed immediately, app folder is the
  portable unit — house rules apply.

## Sequencing

1. `byollm_001` — protocol v0 + daemon MVP (Ollama backend) +
   generic server handler + conformance kit.
2. First integration: a framework test suite talks to a real daemon.
3. claude-CLI backend + the trust UI polish.
4. Production miles under press before any public announcement.
