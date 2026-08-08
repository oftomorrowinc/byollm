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
