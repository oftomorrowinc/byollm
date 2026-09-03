> [!WARNING]
> **Alpha (`0.1.0-alpha.72`) — under active development. Don't use this yet.**
>
> This is a walking skeleton. It routes real jobs between real daemons and real
> sites, and it is the fixture byollm_009 freezes against — but it keeps its
> state in memory, serves one site, and has never run anywhere but a test.
>
> **`alpha.15` is a breaking wire change, and it breaks daemons and relays —
> not app authors.** If you call `app.enqueue(...)` and read results, nothing
> in your code changes. If you run a daemon or an upstream, every package must
> move together: a mixed pair refuses on both sides, because both ends parse
> `.strict()`.
>
> What moved, all of it reconciling the frozen `byollm_009` with its code:
> `JobStub` gains `site` (the site's identity key id) and loses
> `audienceAllow`; `ResultRequest` gains `leaseId`; `HeartbeatResponse` loses
> `leases`, which nothing read; `WireErrorCode` gains `not-ready`,
> `clock-skew` and `forbidden`, and `403` is `forbidden` rather than
> `unauthorized`. `RESULT_PROVENANCE` is superseded by
> `PROVENANCE_NAMES_DEVICE`. See `byollm_009` Amendment A.>
> **`alpha.16` is a breaking wire change — daemons and relays again, not app
> authors.** `app.enqueue(...)` and reading results are unchanged. All five
> packages move together: both ends parse `.strict()`, so a mixed pair
> refuses.
>
> What moved, all of it Tier 2 of `cloud_008`: `model`, `backendClass` and
> `durationMs` come off `ResultRequest` and are sealed **inside** the result
> envelope as `SealedOutcome = { outcome, ran }` — so a daemon can no longer
> declare a model it did not sign, and a relay carries neither.
> `HeartbeatResponse` loses `leases` (nothing read it) and now reports real
> cancellations instead of an empty list. `WireErrorCode` gains `forbidden`
> for 403, leaving `unauthorized` at exactly 401. The relay gained a
> site-plane `cancel` endpoint, honours `stub.deadlineAt`, honours
> `stub.audience`, and remembers a refusal.>
> **`alpha.17` is additive** — no wire change. It exports `ReleaseReason`,
> which `RoutingStore.releaseLeases` names and the package did not export, so
> the interface was unimplementable outside this repo.>
> **`alpha.18` is a breaking wire change — daemons and relays, not app
> authors.** `app.enqueue(...)` and reading results are unchanged. All five
> packages move together.
>
> The **bearer token is gone**: off `PairPollResponse`, off the runner row,
> off the daemon's pairings file, out of the adapter's schema. It was minted,
> hashed and stored on two disks and never sent, looked up or compared —
> `REQUESTS_SIGNED_NOT_BEARER` was enforced by signatures the whole time. If
> you run the Supabase adapter, apply
> `20260819000000_drop_runner_token.sql`; `byollm_approve_pairing` now takes
> one argument. A pairings file written by an older daemon still loads.
>
> `model`, `backendClass` and `durationMs` moved **inside** the sealed result
> (`SealedOutcome = { outcome, ran }`), so a daemon cannot declare a model it
> did not sign and a relay carries none of them. Writing a `RoutingStore`?
> `releaseLeases` takes an optional `reason` and `complete` requires
> `leaseId`, and **an implementation that ignores either still typechecks** —
> run the store contract tests.>
> **`alpha.19` is additive on the wire and a behaviour change in every
> store.** `ResultResponse` gains an optional `duplicate`. Nothing is removed,
> so an older daemon keeps working — but the *order* two rules are checked in
> has changed, and a `RoutingStore` implementation must change with it.
>
> `complete` now checks **terminal state before holder**, scoped to the device
> that finished the job: a replay from that device is answered `duplicate:
> true` with a 2xx, and anyone else gets exactly the refusal they would get
> for a job that is not terminal. Previously `RESULT_IDEMPOTENT` held only
> because the lease is nulled on success, so the holder check tripped first —
> deleting the idempotency branch failed no test. Run the store contract
> tests; the compiler cannot see this.

<!-- release-note 0.1.0-alpha.21 -->
> [!NOTE]
> **`0.1.0-alpha.20` is not a complete release — do not pin it.** Four
> packages published and `@byollm/server` did not: a Sigstore
> transparency-log 409 on its provenance attestation. The workflow's
> "already published" guard correctly refuses to resume a partial publish,
> so `0.1.0-alpha.21` is that release, whole.
>
> If you run the Supabase adapter, `alpha.21` needs
> `20260819010000_completed_by_lease_id.sql`: alpha.19 shipped §3.6's
> ordering without the column it stores the grant in.

<!-- release-note 0.1.0-alpha.40 -->
**`byollm install` — stop keeping a terminal open.** The daemon can now run
under your computer's own supervisor and restart itself if it stops: a launchd
agent on macOS, a `systemd --user` unit on Linux, a logon task on Windows. All
user-level — no root, no system directories, and `byollm uninstall` takes it
away. `byollm status` gained a line saying whether it is actually supervised
right now, including the state that matters most: installed but not running,
which looks fine from an app's dashboard and serves nothing.

If you are running via `npx`, install properly first (`npm install -g
byollm@alpha`) — `install` refuses to supervise a copy in npx's cache, because
npm deletes that directory and the service would fail at some later boot.

<!-- release-note 0.1.0-alpha.41 -->
**`onNoRunner` takes a string.** Your fallback answer is your own value, not
wire data, and handing back a whole result record for it was ceremony — the
README's own example got the shape wrong, which is how this was found.

```ts
const { outcome, fallback } = await job.result({
  onNoRunner: () => runOnHostedModel(transcript),
});
```

Whatever you return, `result()` labels it `fallback: true` — the stamp is
applied by the wait, not taken from you, so an answer that did not run on
somebody's device cannot be reported as though it did (`FALLBACK_LABELED`).
Both delivery channels do it, polling and Supabase Realtime. Records still
work; they just get labelled too.

# `@byollm/relay`

The **reference relay**: it routes byollm jobs between a site and someone's
device while holding no key that can open either end's traffic.

```
  site ──stub──▶  relay  ◀──claim── daemon
       ◀─who claimed?─┤
       ──sealed payload─▶ ──────────▶ (opened only on the device)
       ◀────────────── sealed result ◀──
```

## Why a relay can be blind

A payload is encrypted to the device that runs it. Nobody knows which device
that is until one claims the job — so the site publishes a **stub** first
(byollm_009 §6: user, kind, size class, audience, deadline, streaming flag, and
nothing else), a daemon claims it, and only then does the site seal the work to
that specific device.

The relay is a directory in that exchange, not a participant. It says "this
device claimed your job, here is its public key" and carries what comes back.
It cannot read a payload because it was never a recipient, and it cannot
substitute one because the daemon verifies every envelope against the site
identity it pinned at consent.

That is not a policy this code follows. It is a shape it has: no type in this
package has a field that could hold a private key, so making this relay able to
read a payload means changing its types — a review someone has to justify
rather than a line someone can slip in.

## Why it ships open

It is the conformance kit's reference relay, and the kit is public — so it
starts where it ends rather than being written closed and ported. A relay that
claims to be blind should be readable by the people trusting it, and a
third-party daemon testing hub mode should test against real code rather than a
mock of it.

The production hub — multi-tenant routing, presence at scale, billing, ops — is
built on these same interfaces and is not this.

## `awaiting-payload`

byollm_009 §7 described a state the direct plane cannot produce. There the site
*is* the upstream: it seals when asked, so a job is never claimed-but-unsealed.
Here they are different parties, and the gap between them is a state with its
own clock — separate from the lease and from the job's TTL, because they answer
different questions:

| clock              | question                                       |
| ------------------ | ---------------------------------------------- |
| TTL                | is this work still worth doing?                |
| lease              | how long does this device get to run it?       |
| `awaiting-payload` | how long do we wait for a site that went away? |

When it fires, the stub returns to the queue and nothing is lost.

## Consent

The relay routes nothing without a consent record, and it cannot create one —
consent is a decision made elsewhere and projected in. In the skeleton that
projection is a fixture file; later it is whatever the control plane serves.
The shape is deliberately small, because it is a contract: anything added to it
has to be something a control plane can actually know, and a decision rather
than something the relay could observe for itself.

## Both callers sign

A daemon signs every request with its device key. **A site signs every request
with its site key** — the same key the control plane registered, the same key
daemons pin at pairing, verified against the `sites` half of the projection.
Nothing here trusts a `siteId` in a body or a query string.

That is newer than the rest of this package. The site plane took the caller's
word for who it was until `0.1.0-alpha.8`, which on a relay reachable from the
internet is an open enqueue endpoint into consenting users' devices and an
open read of who is online. It was blind the whole time — nothing could open a
payload — and blind is not the same as safe.

If you are running this: the site plane is authenticated but this is still a
single-tenant relay with in-memory state. One site, one replica.

## Breaking in `0.1.0-alpha.12`: `RelayState` is async

Every method on `RelayState` now returns a `Promise`, and `Relay.sweep()` and
`debugPage()` with it. `RelayState.requeue` is private — it was only ever a
step inside another operation.

Nothing about the behaviour changed. The shape did, and it had to before
routing state can live anywhere but this process: a store on a network cannot
offer a synchronous read, and — more importantly — cannot offer a *read the
caller follows with a write*. So the operations are now decisions plus their
writes (`claim`, `takePayload`, `complete`, `releaseLeases`, `seal`) rather
than scans the caller mutates.

`claim` is the one that matters. It was atomic for exactly one reason — Node
is single-threaded and the Maps are local — and `CLAIM_ATOMIC` is a MUST. See
`packages/relay/test/two-replicas.test.ts`, where the resulting race is a
failing assertion waiting for the fix.

## Running it

```ts
import { Relay } from "@byollm/relay";

const relay = new Relay({
  siteId: "site_demo",
  fixture: {
    // The site registry: one home for a site's public identity, used both to
    // tell daemons who to pin and to check the site's own signatures.
    sites: [{ siteId: "site_demo", site: sitePublicKeys }],
    consents: [{ owner: "alice", siteId: "site_demo" }],
  },
});

// One fetch handler: the daemon plane, the site plane, and /debug.
const response = await relay.handle(request);
```

`/debug` renders every routed job, its state, who claimed it, and how long an
`awaiting-payload` timer has left. It shows no prompt or result text — not
because it filters them out, but because the relay does not have them.

**Do not serve `/debug` on the internet.** It shows no payloads and it does
show who is online, which device holds what, and every lease in flight — the
same metadata the site plane's signatures exist to protect, through a
different door. Whoever serves this package decides that, which is why the
route is still here: refuse it at your gateway and reach it through an
authenticated channel instead.

## Auditing a deployment

`@byollm/conformance` ships a posture audit that holds nothing but a URL,
which is what an attacker has:

```bash
npx byollm-audit-deployment https://your-relay.example
```

It exists because eight of byollm_009's findings came from a suite in which
nothing was ever a stranger — the site had a reference to the relay object and
called it. A harness that invokes the system under test directly cannot see
anything about how the system is *reached*, and the ninth finding was in that
gap. Safe to run against production: nothing writes, nothing floods.

MIT
