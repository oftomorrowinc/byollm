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


### The registry index

Every MUST this spec adjudicates, by id, with the section that decides it.
Added by cloud_008 Tier 4 §1.3b: byollm_009 was the only spec with a table,
so the registry was the sole enumerated home for 34 of 38 MUSTs and nothing
could compare the two. `musts-match-specs.test.ts` reads these tables.

**An index, not a restatement.** The statement lives in `MUSTS` and the
reasoning lives in the sections named below; a table that repeated either
would be a third copy to drift. What a reader gets here is the set, and what
the check gets is a list it can compare against the registry.

| MUST | Adjudicated in |
|---|---|
| `AUDIENCE_BOTH_SIDES` | §The audience model |
| `CANCEL_HONORED` | Rev 1 §C |
| `CLAIM_ATOMIC` | §Endpoints.2 |
| `CLAIM_REQUIRES_CAPABILITY` | §MUSTs |
| `DEPENDS_ON_GATING` | Rev 1 §E |
| `INGRESS_LOGGED_BEFORE_EXECUTION` | §MUSTs |
| `KIND_NO_CODE` | §Jobs are typed data, and byollm_004 §1 |
| `KIND_TYPED_ONLY` | §Jobs are typed data |
| `LEASE_HONORED` | §MUSTs |
| `LEASE_RECLAIMABLE` | §Endpoints.2 |
| `NAMED_LOCAL_ALLOWLIST` | Rev 1 §B |
| `NO_RUNNER_SIGNAL` | Rev 1 §D |
| `PAIR_CODE_EXPIRES` | §Endpoints.1 |
| `PAIR_INTERACTIVE` | §Endpoints.1 |
| `PAIR_ONE_USER` | §MUSTs |
| `REFUSAL_NOT_REOFFERED` | Rev 1 §B |
| `RESULT_IDEMPOTENT` | §Endpoints.4 |
| `REVOCATION_HONORED` | §MUSTs |
| `SUBSCRIPTION_SELF_LOCK` | §The audience model |
| `TTL_EXPIRY` | Rev 1 §D |

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

# Amendment G — roster-follow, and what it costs (RATIFIED 2026-08-25)

Ruled by Todd, on one confirm: that G.2 states the accepted trade in
plain words rather than leaving it to be inferred from the bounds.
That was the condition, and it is the right one — an amendment that
widens what a control plane can cause should be readable as such by
somebody who did not write it.

byollm_016's "private or team" ruling makes team membership central:
an owner manages one roster instead of enrolling each person on each
device. That is a change to `NAMED_LOCAL_ALLOWLIST`, whose Rev 1 §B
text says a named job is admitted "never on the server's assertion
alone" — and roster-follow is a daemon honouring exactly such an
assertion. Written here rather than implied by an implementation,
because a MUST the code contradicts is worse than either.

## G.1 The property, in four parts

1. **A list the daemon holds decides admission — never a per-job
   assertion.** Nothing in a claim, a stub or a heartbeat response
   admits a person for one job. The daemon consults its own held copy
   and reaches the same answer whether or not anybody asked.

2. **The list is authored and signed by the owner's control plane.
   The relay delivers it and can never author it.** This is the half
   an earlier draft of this amendment missed, and the miss mattered:
   forbidding *per-job* assertions from the routing party leaves a
   synced roster as a **bulk** assertion from that same party, so a
   compromised relay could edit membership in transit. That silently
   widens the accepted trade from "a compromised control plane can add
   a member" to "a compromised relay can", which is not what was
   ruled and is a materially larger surface — the relay is the one
   component the trust model has always assumed hostile.

   So the roster is signed where it is authored, verified against a
   control-plane key the daemon has pinned, and refused otherwise.

   **The key is pinned at pairing.** Pairing is already the ceremony
   where an owner proves on the device, out of band, that the device
   is theirs; a key learned there rides an act of trust that has
   already happened rather than inventing a second one. The rejected
   alternative is trust-on-first-roster, and it is rejected because it
   hands the decision back to the relay: a daemon that learns whose
   signature to trust from the first roster to arrive is a daemon
   whose membership authority is chosen by whoever controls delivery.
   That is property 2 defeated by its own implementation. A device
   that has never paired holds no roster and serves no `team` job,
   which is the correct amount of function for a device nobody has
   claimed.

   Amendment C's rotation machinery covers that key's succession; no
   second mechanism, and in particular no path where a roster teaches
   a daemon a new key. The relay keeps exactly the power it always
   had, which is denial: it can withhold a roster, as it can withhold
   a job, and it can forge neither.

3. **The local veto subtracts; nothing local adds.** `byollm disallow`
   removes a person from what this device will serve, and no local
   command puts one back in. An owner who wants somebody served edits
   the roster, which is the single place membership lives. This keeps
   one direction of the old per-person allowlist — the direction that
   was ever used in an emergency — and drops the enrollment ceremony
   that made the same fact live in N places.

4. **A held roster has a maximum age, and stale fails narrow.** Past
   it, the daemon admits its owner and nobody else. Staleness is
   revocation latency: the case that decides the direction is a
   teammate who was removed, and that removal cannot wait on a sync
   that may never arrive. Failing wide would make a partitioned device
   the most permissive one on the network, which is the opposite of
   what a partition should mean. The bound is a protocol constant so
   every implementation ages a roster the same way rather than each
   choosing a comfortable number.

   **`ROSTER_MAX_AGE_MS` is one hour.** It is the shortest constant in
   the protocol, deliberately: every other one bounds how long a
   *thing* stays valid, and this one alone bounds how long a *person*
   keeps access after the owner has said no. An hour is the honest
   answer to "I removed them — when are they gone?", and the answer
   does not depend on whether their device is reachable.

   The number is a failure bound, not a sync interval, and the two
   must not be read as one. A daemon refreshes its roster far more
   often than hourly — it is already talking to the control plane on
   every heartbeat, and a removal propagates in seconds on a healthy
   device. An hour is what a device gets when that conversation stops
   working: enough that a laptop closed through a meeting, a flaky
   café network, or a control plane briefly down does not narrow a
   working device, and not so much that a removed teammate's access
   outlives the owner's patience.

   The failure it produces is legible, which is why it can be short. A
   device past the bound refuses `team` jobs and says why — it does not
   silently serve nobody, and it does not silently serve everybody. An
   owner who sees it is looking at a device that cannot reach its
   control plane, which is a thing they wanted to know anyway.

## G.2 What this costs, in plain words

Before this, a person could be added to a device's served set only by
somebody typing a command on that device. After it, an owner adding a
member to their team in the control plane causes their devices to
start serving that member's jobs — and **a compromised control-plane
account can do the same thing.** That is a real reduction and it is
accepted deliberately, not overlooked.

What bounds it is not this MUST and never was:

- `SUBSCRIPTION_SELF_LOCK` is structural. A subscription-backed
  service consults no list, so no roster change reaches it — somebody
  else's terms stay unlendable however the roster moves.
- `COMMUNITY_BUDGETS` bounds a teammate's jobs per hour and per day,
  their wall-clock, and their payload size, whatever the roster says.
- Jobs are sealed and inert. A job that runs reads nothing and writes
  nothing; `byollm_004 §2` and `OUTPUT_INERT` do not consult
  membership.

So the worst case of a forged roster is bounded compute on free-class
services belonging to somebody whose control-plane account was already
taken. The ceremony being removed did not defend against that; it
defended against it *twice*, in a second place, at the cost of every
owner re-enrolling every teammate on every device forever.

## G.3 The amended MUST

> A `team` job MUST be admitted only by a roster the daemon holds,
> signed by its owner's control plane and verified against a key the
> daemon pinned at pairing, minus any local veto — never by an
> assertion from the party routing the job, per-job or in bulk, and
> never by a roster older than `ROSTER_MAX_AGE_MS`, past which only
> the owner is admitted.

`ROSTER_MAX_AGE_MS = 60 * 60_000`.

`NAMED_LOCAL_ALLOWLIST` keeps its id, per the id-stability law. The
check that verifies it is renamed from
"a named job runs only once the daemon's own allowlist admits it" —
true only under a generous reading of "own" — to:

> a team job runs only once a roster this daemon holds, signed by a
> key it pinned at pairing, admits the asker

which is what is now checked, and names all three of the things a
reader would otherwise have to take on faith: that the list is local,
that its authority was established out of band, and that admission is
a property of the asker rather than of the request.

## G.4 Sequencing note

byollm_016 says Phase A ships `private | team` "with roster-follow".
It did not: Phase A and Phase B both shipped with `team` enforced by
the per-person local allowlist, and the daemon says so at load. That
notice retires with this amendment, and not before — a build whose
`team` is still local must keep saying so.

## G.5 Build phasing (CCC, 2026-08-25) — proposed, one decision to rule

Written before code, as ruled. Sequenced protocol → daemon → control
plane + hub, which is the order dependencies actually run in: the
daemon cannot hold what the wire cannot carry, and the control plane
cannot sign into a shape nobody has agreed.

### What exists today

Rosters already flow. `dashboard_team_roster_members` is read by the
hub's projection (`ROSTERS`, every two seconds), lands in the relay
fixture, and filters what a device may claim. Three of the four
properties are therefore *partly* met by accident of the current
design, and the fourth is met nowhere.

**The gap, property by property:**

1. *A list the daemon holds decides admission.* **Not met.** The
   daemon holds no roster at all. `team` is enforced by the
   per-person local allowlist, and the roster decides routing at the
   relay instead — which is a filter, not an admission.
2. *Authored and signed by the control plane; the relay may deliver
   and never author.* **Not met.** The hub reads rows and assembles
   the roster itself, which is the routing party authoring in bulk —
   G.1.2's forbidden shape, arrived at honestly.
3. *The local veto subtracts; nothing local adds.* **Partly met.**
   `byollm disallow` exists and subtracts. `byollm allow` also adds,
   which this amendment removes for `team`.
4. *Maximum age, stale fails narrow.* **Not met.** Nothing ages.

**The steer, kept:** the property is **non-authorship, not opacity.**
The hub may go on reading rosters — it holds the rows, and its filter
was always advisory under both-sides. What must change is that the
daemon's admission list arrives *signed where it was authored*, so a
tampering hub is caught at the device. No blindness is built that the
signature already makes unnecessary; the hub keeps its filter, and
the filter stops being the thing anybody trusts.

### The one decision to rule: where freshness comes from

`ROSTER_MAX_AGE_MS` is one hour, measured from the `issuedAt` **inside
the signed document** — it cannot be measured from receipt, because a
relay that withholds updates would then keep a removed member served
forever, which is precisely what property 4 exists to prevent.

That has a consequence worth ruling on rather than discovering: a
signed roster must be re-issued far more often than hourly, or every
device narrows to owner-only once an hour. Two shapes:

**(a) Sign on read — RULED 2026-08-25.** The dashboard exposes a
hub-only endpoint returning freshly-signed roster documents; the hub
polls it the way it already polls the database, and relays what it
gets. The signature is minted on demand, so freshness is automatic and
no schedule can fall behind.

**The fence blesses this endpoint.** cloud_001 forbids the cluster a
control-plane *writing* credential; hub-reads-control-plane is the
sanctioned direction and always was. This is the same reader with a
new transport — read-only, hub-authenticated, and carrying a document
the hub could already assemble from rows it is granted. Nothing about
the fence moves.

**The bad hour is a stated hour.** The dependency is real and it is
bounded on both sides. The hub keeps delivering the last valid
document through a sub-hour dashboard outage — a roster that is still
inside its age is still true, and withholding it would invent an
outage the control plane did not have. And a device that does narrow
says so: *"roster stale — serving owner only until refreshed."* A
silent shrink is the failure this whole amendment exists to stop
having, and it would be perverse to introduce one at the end of it.

**(b) Re-sign on a schedule.** A cron re-signs every few minutes into
a table the hub already reads. No new dependency, no new endpoint —
but the margin between the re-sign interval and the max age is a
number somebody must keep true, and Vercel's cron floor may be an
hour, which would leave no margin at all.

(a) is recommended because the failure mode of (b) is silent and
periodic: a cron that slips produces devices that narrow, recover,
and narrow again, and nothing in the product would name the cron.

**Where the key lives is already settled by precedent.** The suite
mints hub tokens with an Ed25519 keypair whose private half is a
Vercel environment variable and whose public half the hub holds
(`USAGE_TOKEN_*`, `scripts/mint-hub-keypair.mjs`). Roster signing is
the same shape with a different audience: the daemon holds the public
half, pinned at pairing.

**And it rotates under Amendment C, not a scheme of its own.** Pinned
at pairing, superseded by the existing succession ceremony, with the
same retirement window during which both keys verify. A second
rotation mechanism would be a second answer to "which key is live",
which is this project's most repeated bug.

### Phase A — protocol

- `ROSTER_MAX_AGE_MS = 60 * 60_000`, exported and used by both sides.
- `SignedRoster`: `{ owner, members[], issuedAt, signature }`, with
  `signRoster` / `verifyRoster` beside the existing request signing,
  under their own domain separator so a roster signature can never be
  replayed as a request signature.
- Wire: the pair response gains the control-plane public key to pin;
  the heartbeat response gains the signed roster.
- The MUST text is already ratified; this is the shape it needs.

**This is a wire change**, so protocol lockstep applies: publish,
bump, deploy, and the gate before promotion.

**And the order is not interchangeable.** These response schemas are
`.strict()` — a relay's answer is checked before it is believed —
which makes a new field safe to *add* and unsafe to *send early*. A
daemon on the previous release that receives a response carrying
`roster` fails the whole parse, not the field: its heartbeat stops,
for reasons that have nothing to do with rosters and name nothing
that would lead anybody to this change.

So Phase C deploys in exactly one order: publish the protocol, let
daemons update, *then* let the hub begin sending. `roster.test.ts`
pins both directions so the constraint is something a reader trips
over rather than rediscovers in production.

### Phase B — daemon, and why it is two halves

Written as one phase, and it cannot be. Building it exposed a
regression the plan did not see, so the split is recorded here rather
than discovered by whoever ships it.

**B1 — hold and verify (built 2026-08-25).** Pin the control-plane
key at pairing, beside the site pins. Hold the roster, verified
against that key; refuse a forged one, an older one than the one held,
and one that arrives with no key pinned. Stop counting a held roster
once it ages out. Surface all of it, because a device that has
narrowed must be able to say why.

Two refusals here are not in the amendment and are needed to honour
it. **A refused roster does not replace the one already held** — a
relay that could swap a good roster for a broken one would narrow this
device on demand, turning the denial the design accepts into something
sharper. And **an older document is not an update**: without that, a
relay replays yesterday's membership over today's, inside the age
window, with a signature that verifies perfectly.

**B2 — flip admission (blocked, and deliberately).** `team` admission
becomes the held roster minus local veto. Not shipped with B1, for
two reasons that are both about not breaking something:

1. **No roster exists until Phase C.** A daemon that admitted only
   from a roster, before any hub sends one, would stop serving every
   `team` job on every device — the correct behaviour under property
   4, arriving a release early and looking exactly like an outage.
   Daemon and hub deploy independently, so this is not a matter of
   ordering one release.
2. **The local veto does not exist yet.** Today's allowlist is purely
   additive and `byollm disallow` removes an `allow` entry. "The veto
   subtracts; nothing local adds" needs a deny list that is not the
   same list, and that is a config-shape change with its own
   migration.

Until B2, a device with a roster and a device without are both served
by the local allowlist, and the in-product notice keeps saying so —
which is the honest description of the transitional state rather than
a second authority. **The C006 rename and the notice retirement move
to B2**, where the sentence they make becomes true.

### Phase C — control plane + hub

- Roster signing key, minted the way the hub token key was.
- The dashboard signs; the hub reads and relays; neither the hub nor
  the relay can mint one.
- The hub's existing roster filter stays, now advisory by admission
  rather than by hope.

### What rides with the build, and not before

`C006_NAMED_LOCAL_ALLOWLIST`'s check title, and the in-product notice
saying `team` is enforced locally. Both describe roster-follow as the
enforcement, and until Phase B ships it is not. A check whose title
claims a property nothing enforces is the defect this project spent
the week deleting.
