# BYOLLM Protocol v0 — normative specification

**Status:** v0, pre-release. **Source of truth for types:** `@byollm/protocol`.
**Compatibility contract:** `@byollm/conformance` — a server is
byollm-compatible when the kit passes against it.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be
interpreted as described in RFC 2119.

Every MUST in this document carries a **conformance id** in `[BRACKETS]`.
Those ids are exported as data from `@byollm/protocol` (`MUSTS`), and the
conformance kit fails if any id has no test asserting it. A requirement
without a test cannot exist in this protocol.

---

## 1. Model

A **daemon** runs on an end user's computer. A **server** is an app's backend.
A **job** is typed data describing one model call.

All communication is **outbound from the daemon**. The server never connects
to the daemon, never learns a routable address for it, and has no mechanism to
push. There is nothing to open on the user's network.

A daemon is paired to **exactly one user** in exactly one server's namespace
`[PAIR_ONE_USER]`. A daemon MAY be paired to several servers; each pairing is
a separate identity with its own owner and its own pinned control-plane key.
Nothing is pooled across pairings — a grant signed by one relay's control
plane is not a document another pairing can even read — and there is no
daemon-to-daemon channel.

### 1.1 Owner ids are server-namespace-local

`owner` is the app's own id for a user. It has no meaning outside the server
that issued it. A daemon MUST NOT treat an owner id from one server as the
same principal as an identical string from another `[NAMED_LOCAL_ALLOWLIST]`.
This is why the daemon's admission is keyed by **(server origin, user
id)** and not by user id alone.

---

## 2. Transport

All endpoints are `POST`, JSON request and response, mounted under
`/byollm`. Requests carry `protocolVersion: "0"`. A server that cannot speak a
requested version MUST respond `400` with `error: "unsupported-protocol-version"`
rather than guessing.

Every endpoint except `pair` is **signed**, not bearer-authenticated. A
request carries `x-byollm-runner`, `x-byollm-issued-at` and
`x-byollm-signature`, the last being the device's Ed25519 signature over the
endpoint, the runner id, the timestamp and the body
(`REQUESTS_SIGNED_NOT_BEARER`).

There is no bearer token. One was minted at pairing until `alpha.18` and was
never sent, looked up or compared — a credential at rest with no consumer —
and it is gone from the wire, both stores and the adapter's schema. A server
that accepts one is not implementing this protocol.

### 2.1 Errors

| code | HTTP | meaning |
|---|---|---|
| `bad-request` | 400 | malformed or schema-invalid |
| `unsupported-protocol-version` | 400 | version not spoken here |
| `unauthorized` | 401 | missing/invalid runner token |
| `forbidden` | 403 | we know who you are, and the answer is no |
| `revoked` | 403 | this runner has been revoked |
| `not-found` | 404 | unknown job or runner |
| `too-late` | 409 | the job is over; stop rather than retry |
| `rate-limited` | 429 | back off; honour `Retry-After` |
| `server-error` | 500 | transient; back off |

**Every protocol request declares its version**, and a mismatch is refused by
name before anything else is checked — including before the signature, because
a caller that does not speak this version cannot be expected to sign the way
this version signs. A POST declares it in the body; a GET declares it in the
query string, because it has no body. The refusal carries `supported` and
`minimum` so a client can say something its owner can act on.

A path that is not a protocol endpoint is **not** subject to the handshake: an
unknown path answers 404 rather than describing what this server speaks to
whoever was knocking.

A daemon MUST NOT retry 400- or 404-class responses. It MUST honour
`Retry-After` on 429 and 500.

These codes exist so a daemon can tell apart four different truths that MUST
NOT share a message: **server unreachable** (no response at all), **revoked**
(`403` with code `revoked`, on **every** endpoint including heartbeat), **no
matching work** (a `200` with an empty job list), and **backend down** (a
local condition, never a wire event).

A fifth was folded into one of those and had to be pulled back out: **nothing
consented right now** is a `200` with an empty `sites` map, and it is *not*
revocation. A daemon's response to revocation is to drop its pairing and the
keys it pinned, so that response must never rest on an absence — a projection
can arrive empty because a control plane pushed it half-written. Revocation is
a decision somebody made, and it says so with a code.

---

## 3. Jobs are typed data, never code

A job is:

```ts
{ id, kind, payload, audience, owner, site, lease }
```

`kind` is a string resolved against handlers **baked into the daemon**. v0
defines `llm.generate` and `llm.chat`. A daemon MUST refuse an unknown kind
rather than guess `[KIND_TYPED_ONLY]`.

A server MUST NOT be able to convey code, a shell string, a file path, an
argument, a model name, a base URL, or an environment variable
`[KIND_NO_CODE]` `[NO_PAYLOAD_ROUTING]`. The wire schema is the first line of
that guarantee: there is no field to carry them, and payload objects are
`strict()` so an unknown key is a parse failure rather than something ignored
deeper in.

### 3.1 Payloads (v0)

```ts
llm.generate → { prompt: string, system?: string }
llm.chat     → { messages: { role: "system"|"user"|"assistant", content: string }[],
                 system?: string }
```

Text only, deliberately. Sampling parameters, model selection and backend
selection are **owner-side route configuration**, not payload. A future
`params` field with a closed allowlist and owner-set clamps is reserved;
adding a field later is non-breaking, removing one is not.

Hard ceilings: 1,000,000 characters per text field, 256 messages, 4,000,000
characters per payload. Community jobs are subject to stricter limits (§7).

---

## 4. The audience model

Every job carries an `audience`; every daemon backend carries an
**offer scope**. A job runs on a daemon only if **both** admit the other
`[AUDIENCE_BOTH_SIDES]`:

1. the job's audience admits the daemon's owner, **and**
2. the backend's offer scope admits the job's owner.

| | `offer: private` | `offer: team` |
|---|---|---|
| **`audience: private`** | owner's own work only | owner's own work only |
| **`audience: team`** | refused | runs if this device admits the owner |

A daemon always runs its own owner's work, at any scope. All four cells are
asserted by the conformance kit.

**There is no cell that runs a stranger's work unconditionally.** `public` was
a third value on both axes until 2026-08-26, and its two `runs` cells were
reached without the device being consulted at all — an off switch for
admission wearing the costume of a wider setting. It was removed rather than
deprecated, in direct mode as well as cloud. Every scope that remains asks the
device a question.

### 4.1 The subscription private lock

A backend whose account class is `subscription` (the `claude` CLI, and any
future vendor-account CLI) has an effective offer scope of `private`, always. It
MUST NOT be widened by configuration `[SUBSCRIPTION_SELF_LOCK]`. One account
executes one person's work. This is a protocol rule, not a setting, and it is
applied at the single function both the config loader and the matcher call —
there is no code path that observes a widened subscription scope.

Note that account class is independent of backend class (§6): `claude-cli` is
both process-class and subscription-class; a future local `mlx_lm.lora`
backend would be process-class and open.

### 4.2 `team` is enforced at the device

A `team` job is admitted only when the job carries a grant the **daemon
itself verified** against the control-plane key it pinned at pairing
`[NAMED_LOCAL_ALLOWLIST]`. A routing party's assertion that a runner is
allowed is never sufficient — user ids are server-namespace-local, so
honouring such a claim would mean obeying the server rather than enforcing
against it.

The grant is authored at **claim**, not at enqueue, which is what makes
membership changes take effect immediately in both directions: a person added
runs on their next job, and a person removed fails at their next claim even
for work already queued. It is single-use and short-lived, so it cannot be
replayed after either.

A server MUST NOT put the list on the wire. It may hold one and filter its
own candidates with it — the party holding the list authored it — but a stub
carries no membership at any point. `audienceAllow` was a stub field until
`alpha.14`, and it was a second answer to a question the daemon already owned:
able only to agree, in which case it was redundant, or to disagree, with
nothing written down about which wins.

The rule it left behind, which decides any field proposed after it: **a class
the router acts on may travel; membership never does.** `audience` travels
because a relay narrows on it. A roster does not travel at all, which is how
`ROSTER_NOT_DISCLOSED` holds — by absence.

### 4.3 Community results are best-effort

There is no redundancy, voting, or verification of `team` results in v0. An
app that opts jobs into a wider audience is choosing that trade
explicitly, and MUST disclose it wherever the prompt originates. See §8 for
what the app is obliged to do with the result.

---

## 5. Endpoints

### 5.1 `POST /byollm/pair`

Pairing is a **device-code exchange** `[PAIR_INTERACTIVE]`. A long-lived
pasted secret MUST NOT be accepted as a pairing mechanism.

**start** →

```jsonc
{ "protocolVersion": "0", "action": "start",
  "daemon": { "version": "0.1.0", "label": "todd-mbp", "platform": "darwin" },
  "capabilities": [ /* §6 */ ] }
```

```jsonc
{ "deviceCode": "<secret, 20+ chars>", "userCode": "KRTZ-9F2Q",
  "verificationUrl": "https://app.example.com/byollm/pair",
  "expiresAt": 1765200000000, "pollIntervalMs": 2000 }
```

The daemon prints the user code and URL and opens a browser. The user
approves **inside the app's own authenticated session** — the server learns
which user is pairing from that session, never from the daemon.

**poll** → `{ "status": "pending" | "denied" | "expired" | "approved", … }`.
On `approved` the response carries `runnerToken`, `runnerId` and `owner`.

The `verificationUrl` MUST be on the server's own origin. An unapproved device
code MUST expire and MUST NOT be redeemable afterwards `[PAIR_CODE_EXPIRES]`.
The issued token is scoped to exactly one user `[PAIR_ONE_USER]`.

### 5.2 `POST /byollm/claim`

```jsonc
{ "protocolVersion": "0", "runnerId": "…", "capabilities": [ … ], "max": 4 }
```

Claiming MUST be atomic — a job MUST NOT be handed to two runners
concurrently `[CLAIM_ATOMIC]`. Implementations backed by SQL SHOULD use
`FOR UPDATE SKIP LOCKED`.

A server MUST NOT return a job whose kind is absent from the capability matrix
in **this request** `[CLAIM_REQUIRES_CAPABILITY]`, and MUST apply the §4
matching rules itself as defence in depth. A server MUST NOT return a job
whose `dependsOn` set is not fully `ok` `[DEPENDS_ON_GATING]`.

Response carries the jobs and `leaseMs`. An empty list means **no matching
work** — a distinct, unremarkable truth, not an error.

### 5.3 `POST /byollm/heartbeat`

Sent about every 10 seconds with jitter. Carries the capability matrix, the
daemon version, the jobs the daemon believes it holds, and whether the owner
has it paused.

The response carries:

- `sites` — the sites this pairing covers, keyed by each site's identity key
  id. The set follows consent: a site that leaves it is revoked *for that
  site*, and the daemon drops that pin and keeps the rest. An **empty** map
  means nothing is consented right now — the pairing stands and the daemon
  keeps beating. A revoked runner is refused outright instead
  (`403 revoked`, here as on every other endpoint), which is how it learns to
  stop claiming and abandon in-flight work by the next heartbeat at the latest
  `[REVOCATION_HONORED]`. Heartbeat carries the refusal rather than being
  exempt from it because it is the one call every daemon makes: one whose own
  backend is down never claims, and would otherwise never find out.
- `awaitingConsent: [siteId]` — sites whose consent exists but is **paused**:
  they keep their pin, route nothing, and name what the owner has to go and
  read. A subset of `sites`.
- `cancel: [jobId]` — per-job cancellation. The daemon aborts those jobs'
  in-flight backend calls (HTTP abort, process kill) and reports them
  `canceled` `[CANCEL_HONORED]`.
- `lost` — jobs the daemon thinks it holds but the server has reassigned or
  expired. The daemon MUST stop work on these and MUST NOT report results for
  them.
- `serverTime` — so a daemon with a skewed clock still honours leases.

The upstream still renews the leases a heartbeat names; it simply does not
report them back. A `leases` field carried that list until `alpha.16` and no
daemon ever read it — `lost` is the signal a daemon acts on, and two answers
to one question is one too many.

### 5.4 `POST /byollm/result`

The request names the **grant** the work was done under, not only the job:
`{ jobId, leaseId, envelope, disposition }`. A runner id survives a
claim-release-reclaim cycle and a lease id does not, which is the difference
`[LEASE_HONORED]` is about.

How the job ran travels **inside** the sealed envelope, not beside it. The
plaintext is `{ outcome, ran: { model, backendClass, durationMs } }`, so a
daemon cannot seal one answer and declare it came from another model, and a
relay carries none of it. Those three were request fields until `alpha.18`.

Checks happen in this order: signature, then terminal state, then holder
`[RESULT_IDEMPOTENT, LEASE_HONORED]`.

- A replay from **the device that finished the job**, under the same grant,
  answers `202`-style `{ accepted: false, duplicate: true }`. Its answer is
  already stored; telling it the lease is stale would invent a worry.
- Any other submission for a terminal job gets exactly the refusal it would
  get for a job that is not terminal, so a job id cannot be used to probe
  whether work has finished.
- A daemon MUST NOT report a result for a job whose lease it no longer holds,
  and a losing submission MUST be discarded rather than retried.

The order is load bearing rather than stylistic. Checking the holder first
made `RESULT_IDEMPOTENT` hold as a side effect of the lease being cleared on
success — and byollm_009 §4's case for signing requests rather than issuing
nonces *cites* that MUST.

### 5.5 `POST /byollm/release`

Voluntary un-claim on shutdown, pause, revocation, or backend failure. Best
effort: a daemon that dies without releasing loses nothing, because the lease
expires (§7.1).

---

## 6. Capabilities and backend classes

```ts
{ kind, backendId, backendClass, model, offerScope }
```

The matrix MUST be the intersection of owner configuration and **detected,
healthy reality** `[CAPABILITY_IS_DETECTED]`. A configured but unreachable
backend MUST NOT appear.

Two backend classes, because their threat surfaces differ:

- **`http`** — an OpenAI-compatible server (Ollama, `mlx_lm.server`,
  llama.cpp server, vLLM). One backend, N owner-configured base URLs. Spawns
  nothing, so §9's argv/stdin/env requirements do not apply by construction.
  Requests go only to the owner-configured base URL, which MUST NOT resolve to
  cloud-metadata or link-local addresses `[HTTP_BASE_URL_SAFE]`.
- **`process`** — spawns a binary (`claude` CLI). All of §9 is mandatory.

`backendClass` travels to the app on the result's provenance, so an app can
tell whether an answer came from a sandboxed spawn or an HTTP call.

---

## 7. Lifecycle, leases, dependencies

```text
queued ──claim──▶ claimed ──start──▶ running ──▶ ok | error | canceled
  │                  │                   │
  │                  └──lease expiry─────┴──▶ queued  (reclaimable, no loss)
  └──ttl elapsed──▶ expired
```

### 7.1 Leases

A claim grants a lease with an expiry. A daemon MUST stop work on a job whose
lease it failed to renew `[LEASE_HONORED]`. A lease that expires un-renewed
MUST make its job claimable again with no loss `[LEASE_RECLAIMABLE]` — this is
what makes `kill -9` mid-job safe.

### 7.2 Dependencies

A job MAY carry `dependsOn: [jobId]`. The server MUST keep it unclaimable
until every dependency is `ok` `[DEPENDS_ON_GATING]`. This is one field and
one claim predicate, not a DAG engine: the app still creates the jobs, it just
no longer orchestrates the wait. Per-job audience routing is unchanged, so the
halves of a multi-job flow correctly land on different devices in order.

### 7.3 TTL and the no-runner signal

An unclaimed job expires at a configurable TTL and becomes `expired`
`[TTL_EXPIRY]`.

**The TTL measures time a job has spent waiting *unclaimed*.** Two
consequences, both load-bearing:

1. The clock starts when the job becomes claimable — when its `dependsOn` set
   is fully `ok` — not at enqueue. Starting it at enqueue would expire a
   dependent job for the crime of waiting on a slow dependency.
2. The clock **restarts** when a job returns to `queued` after a lease lapse
   or a release. A job whose runner was killed mid-work has not been waiting;
   expiring it for time spent being actively worked on would throw away
   exactly the work §7.1's reclaim exists to save.

Total lifetime is bounded instead by an optional absolute `deadlineAt`, which
is unaffected by reclaim. An app that needs "this must be done by 09:00" sets
that; an app that needs "don't let this rot in the queue" sets the TTL.

`noRunnerAvailable` is a derived signal: no runner with matching capability
has heartbeated within the liveness window. A server MUST surface it so apps
can fall back to a hosted model or prompt the user to start their runner
rather than awaiting something that will never resolve, and MUST NOT raise it
for a job still blocked on dependencies `[NO_RUNNER_SIGNAL]`.

Delivery to the app is an **explicit channel** — webhook, subscription, or
poll, the adapter's choice — never an implied in-request `await`.

---

## 8. The return trip is untrusted too

A `team` result is **attacker-controlled text**. The volunteer's
device, or a compromised one, can return anything, and the app would
otherwise render it as its own AI's output.

Every result carries provenance to the delivery seam
`[RESULT_PROVENANCE]`:

```ts
{ audience, runnerId, runnerOwner, backendClass, model, untrusted }
```

`untrusted` is **derived** from the audience (`audience !== "private"`), never
supplied, so no caller can mark volunteer output as first-party. An app MUST
NOT treat a result with `untrusted: true` as its own AI's answer: do not
render it as trusted HTML, do not feed it to a privileged downstream step, and
disclose its origin to the reader.

This is the mirror of §9. §9 protects the volunteer's computer from the app's
payload; this section protects the app from the volunteer's result.

---

## 9. Execution isolation (daemon-enforced)

The full threat model is `docs/security.md`. The protocol-level MUSTs:

- Process-class backends MUST be invoked with a **fixed argv array** and the
  payload delivered on **stdin**. No code path may place payload text on a
  command line, and no shell-invoking API may be used
  `[NO_SHELL_INTERPOLATION]`.
- Model, backend, base URL and flags come from **owner config only**
  `[NO_PAYLOAD_ROUTING]`.
- Process-class children MUST spawn with an allowlisted environment, a scratch
  `cwd`, no inherited descriptors beyond the three std streams, and hard
  timeout and output-size caps `[STRIPPED_CHILD_ENV]`.
- HTTP-class backends MUST reach only the owner-configured base URL, which
  MUST NOT resolve to cloud-metadata or link-local addresses
  `[HTTP_BASE_URL_SAFE]`.
- Returned text is **inert**: never evaluated, never written to a
  payload-named path, never interpolated into a shell or into terminal control
  sequences when logged `[OUTPUT_INERT]`.
- The daemon exposes no tools, functions, retrieval, or MCP to the model. A
  kind that needs tools is a new kind with its own spec and threat review, not
  a payload flag.
- Every executed prompt MUST be appended to the local ingress log **before**
  execution begins `[INGRESS_LOGGED_BEFORE_EXECUTION]`.
- Jobs whose owner is not the daemon's owner MUST be subject to the owner's
  rate limits, daily cap, and resource budget `[COMMUNITY_BUDGETS]`.

**Breakout is structurally impossible; prompt injection is not prevented.**
Payload text cannot escape into the computer. Payload text absolutely can steer
what the model *says* — no daemon can prevent that, and the guarantee here is
bounded precisely because the model has no tools and the output is inert. We
state the boundary rather than blurring it.

---

## 10. Reserved, not designed

Token streaming (a `stream` lane is reserved in the shape of `result`).
Artifact upload negotiation beyond a URL reference. Daemon-to-daemon anything.
Pooling or marketing of compute — excluded permanently, not deferred: it
breaks the trust model and the provider-terms posture.
