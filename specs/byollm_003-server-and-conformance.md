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
