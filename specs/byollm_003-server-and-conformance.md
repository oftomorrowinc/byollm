# byollm_003 — Server adapters + the conformance kit

## `@byollm/server`

- **Core**: framework-agnostic protocol handlers (pair, claim,
  heartbeat, result, release) over a storage interface (`JobStore`,
  `RunnerStore`) — the adapter seam. Reference in-memory store for
  tests and demos.
- **Adapters v1**: a plain **Next.js route-handler mount** (one file
  a developer drops in) and the **Supabase adapter** (jobs +
  runners tables, RLS-scoped claim RPC with skip-locked semantics,
  migration files shipped) — the piece the of-tomorrow-framework's
  runner module consumes verbatim.
- Server-side MUSTs mirrored: audience matching enforced here too
  (defense in depth — the daemon refuses, and so does the server);
  named-audience allowlists resolved against the app's own user ids;
  `public` jobs never carry secrets in payloads (schema-checked:
  a denylist of obviously-secret key shapes with a documented
  escape hatch).

## The conformance kit (`@byollm/conformance`)

The compatibility contract: spins a real daemon against any server
implementation and asserts every protocol MUST by test id — pairing
scope, typed-kind refusal, lease expiry/reclaim, subscription
self-lock, audience matrix (all nine combinations), revocation
mid-queue, result idempotency. Runs in this repo's CI against the
reference server and the Supabase adapter (via `supabase start`);
published so third-party servers can certify themselves with one
command. **A server is "byollm-compatible" when the kit passes —
that sentence is the whole versioning story.**

## Done when

Kit green against in-memory and Supabase servers in CI; a demo app
(examples/) enqueues from a web page and renders the result;
docs show the three-file integration (mount handler, add store,
enqueue); framework's runner module can consume the Supabase adapter
without patching it.

---

## Rev 1 — CC review adjudication (2026-08-08)

**Return-trip results are untrusted input (review #2).** 004 models
payload-as-hostile-input in one direction; the mirror is unmodeled. A
`named`/`public` job's result is **attacker-controlled text** — the
volunteer's machine (or a compromised one) can return anything, and
the app will render it as its own AI's output. `@byollm/server` MUST
mark non-`self` results as untrusted at the delivery seam: a result's
provenance (`self` vs `named` vs `public`, which runner) travels with
it, and the enqueue/delivery API surfaces it so apps never silently
treat volunteer output as first-party. Docs state it at the enqueue
example, loudly. (This is abuse *by* the volunteer; 004 §4's rate
limits are abuse *of* the volunteer — both now covered.)

**No-runner delivery + TTL (review #4).** The server owns job
lifecycle: unclaimed jobs expire at a configurable TTL; the
server→app delivery is an explicit channel (webhook, Realtime
subscription, or poll — adapter's choice), never an implied
in-request promise. The Supabase adapter ships Realtime delivery +
a `noRunnerAvailable` query. The README's `await job.result()` is
sugar over that channel with a timeout and a `noRunnerAvailable`
rejection — not a bare promise.

**Dependency claim-gating (review #6).** The `JobStore` claim query
excludes jobs whose `dependsOn` set isn't all `ok`. One predicate;
tested in the conformance kit (a two-job chain with different
audiences completes in order across two daemons).

**Conformance additions.** The kit now also asserts: cancel via
heartbeat aborts a running job; a `named` job is refused by a daemon
whose *local* allowlist doesn't admit the owner (not merely
server-side); dependency ordering; TTL expiry surfaces
`noRunnerAvailable`; non-self result provenance is preserved to the
delivery seam.
