# byollm_001 — Protocol v0

**The wire contract between a daemon (user's machine) and a server
(an app's backend).** Normative doc lands at `docs/protocol.md`;
types in `packages/protocol`. Five endpoints, lease semantics, typed
job kinds, and the audience model. Invariants are MUSTs the daemon
enforces — a server that misbehaves gets refused, not obeyed.

## Endpoints (server implements; daemon calls; all outbound from daemon)

1. `POST /byollm/pair` — begin/complete pairing. Returns a scoped,
   revocable runner token bound to **exactly one user**. Pairing is
   interactive (browser step) — never a pasted long-lived secret.
2. `POST /byollm/claim` — atomic claim of ≤N jobs matching the
   daemon's advertised capability matrix; returns jobs + lease
   expiry. Skip-locked semantics server-side; a lease that expires
   un-renewed makes the job reclaimable.
3. `POST /byollm/heartbeat` — renews leases; carries capability
   matrix (kind → backend+model) and daemon version; server returns
   revocation status (a revoked daemon stops mid-queue).
4. `POST /byollm/result` — job outcome: ok/error + payload or
   artifact reference. Idempotent by job id.
5. `POST /byollm/release` — voluntary un-claim (shutdown, pause).

## Jobs are typed data, never code

A job = `{ id, kind, payload, audience, owner, lease }`. **Kinds are
strings resolved against handlers baked into the daemon** (v1:
`llm.generate`, `llm.chat`). A server can never ship code, a shell
string, or a file path to execute. Unknown kind → refused.

## The audience model (in v0 on purpose — fields are cheap before v1)

Every job carries `audience: "self" | "named" | "public"` — who may
run it. Every daemon backend carries an **offer scope**:

- **Subscription-class backends (claude CLI, any vendor-account
  CLI): offer scope is `self`, hard-locked — a protocol MUST, not a
  setting.** One user's account executes only that user's work.
- **Open local backends (Ollama, MLX, llama.cpp): owner may widen to
  `named` (an allowlist of user ids the server verifies) or
  `public`.** Donated compute for open models — the folding@home
  posture; no provider terms in play.

Matching MUST satisfy both sides: a job runs on a daemon only if the
daemon's offer scope admits the job's owner AND the job's audience
admits the daemon's owner. Apps opt jobs into `named`/`public`
explicitly and disclose it wherever the prompt originates; community
results are best-effort by contract (no redundancy/verification in
v1 — documented, not implied away).

## MUSTs (daemon-enforced, tested by the conformance kit)

One pairing, one user. Typed kinds only. Subscription backends
self-only. No claim without capability. Leases honored; expiry means
stop. Every executed prompt appended to the local ingress log before
execution. Revocation honored at next heartbeat at the latest.

## Out of scope (reserved, not designed)

Token streaming (a `stream` lane is reserved in the shape of
`result`), artifact upload negotiation beyond a URL reference,
daemon-to-daemon anything.

## Done when

`docs/protocol.md` is normative and complete; `@byollm/protocol`
exports the types + zod schemas both other packages consume; every
MUST above has a conformance test id referenced inline.

---

## Rev 1 — CC review adjudication (2026-08-08)

Seven-point external review; all accepted. Protocol-level deltas:

**A. Backend classes are now first-class (from review #5).** Two
classes, because their threat surface differs:
- **HTTP-class** — anything exposing OpenAI-compatible
  `/v1/chat/completions`: Ollama, `mlx_lm.server`, llama.cpp server,
  vLLM. **One backend, N base URLs in config.** No process spawn, so
  it sidesteps most of 004 §2 by construction. This collapses four
  planned backends into one and means **MLX *inference* ships in v1**
  — which is what lets the first production suite be the proving
  ground.
- **process-class** — spawns a binary: `claude` CLI, and later
  `mlx_lm.lora` for `train.*` kinds. 004 §2's spawn hardening applies
  here.
The capability matrix a daemon advertises now carries the backend
class per kind, so a server/app knows whether a result came from a
sandboxed spawn or an HTTP call.

**B. `named` is honestly re-categorized (from review #1).** User ids
are server-namespace-local; a daemon cannot verify another server's
allowlist without trusting the server's assertion — which fails the
"daemon enforces, doesn't obey" test. Fix: **the daemon holds its own
local allowlist** of `(server origin, user-id)` pairs it will run
`named` work for, checked by the daemon itself, editable in one place
(`byollm allow <server> <user>`). A job's `named` audience is
satisfied only when the daemon's *local* list admits the job owner —
never on the server's say-so. This restores `named` to a
daemon-enforced MUST. (If a future design can't hold this, `named`
gets demoted to a documented server-side convenience — but v1 holds
the line.)

**C. Job-level cancel (from review #3).** Revocation was daemon-level
only; the first consumer already has per-job cancel + AbortSignal
and must not
regress. The heartbeat response — which already carries revocation —
now also carries `cancel: [jobId]`. The daemon aborts those jobs'
in-flight backend calls at the next heartbeat. Cheap field, added in
v0 before it's expensive.

**D. Job lifecycle + no-runner state (from review #4).** The most
user-visible failure mode was unspecified. Jobs now have explicit
states: `queued → claimed → running → (ok|error|canceled|expired)`.
Unclaimed jobs carry a **TTL**; on expiry they become `expired` and
the app is notified. A new derived signal, **`noRunnerAvailable`**
(no daemon has heartbeated matching capability within a window), is
surfaced at enqueue so apps can fall back (hosted model, "start your
runner" prompt) instead of awaiting a promise that never resolves.
The server→app delivery path is explicit (webhook/subscription/poll),
not an implied in-request `await` — see 003.

**E. Job dependencies (from review #6).** Real integrations are
multi-job: one publishing beat = an MLX-inference job (`named`, your
box) + a Claude review job (`self`, a colleague's box, because the
subscription self-lock correctly forbids their work on your account). Add an
optional `dependsOn: [jobId]` to a job; the **server keeps a job
un-claimable until its dependencies are `ok`**. This is one field and
one claim-gating rule — not a DAG engine. Per-job audience routing is
unchanged, so the two halves correctly land on different machines in
order. The app still creates the jobs; it no longer orchestrates the
wait.

**F. Protocol coverage gate (from review #7).** A ≥90% line gate on a
types-and-schemas package is trivially met or gamed. The **conformance
kit is the real gate** for `@byollm/protocol`; keep schema-validation
unit tests but let conformance carry the guarantee (standards.md
amended).
