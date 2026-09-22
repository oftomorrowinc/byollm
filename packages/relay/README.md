<!-- release-note 0.1.1 -->
> **`0.1.1` is documentation only — nothing to upgrade.** `PROTOCOL_VERSION`
> is still `2`, so a 0.1.0 party and a 0.1.1 party talk to each other in both
> directions. No dependency, schema, wire field or on-disk shape moved.
>
> This README used to open with a stack of release notes instead of with the
> package. The history moved to `docs/release-notes/` and `CHANGELOG.md`,
> where none of it was lost. Full note: `docs/release-notes/0.1.1.md`.

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
word for who it was until shortly before `0.1.0`, which on a relay reachable from the
internet is an open enqueue endpoint into consenting users' devices and an
open read of who is online. It was blind the whole time — nothing could open a
payload — and blind is not the same as safe.

If you are running this: the site plane is authenticated. The package ships an
in-memory store, and that is what holds it to one replica — give it a shared
`RoutingStore` and the limit goes with it.

It is **not** single-tenant. `RelayOptions` has no site field; the relay routes
for every site its projection holds, and refuses a caller that names a site the
projection does not (cloud_009 §3). Job state is keyed by the pair, so two sites
may use the same job id without either seeing the other.

## Breaking before `0.1.0`: `RelayState` is async

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
npx --package @byollm/conformance byollm-audit-deployment https://your-relay.example
```

It exists because eight of byollm_009's findings came from a suite in which
nothing was ever a stranger — the site had a reference to the relay object and
called it. A harness that invokes the system under test directly cannot see
anything about how the system is *reached*, and the ninth finding was in that
gap. Safe to run against production: nothing writes, nothing floods.

MIT

<!-- family:start -->

## The rest of byollm

Six packages, and they are only interesting together:

- [`byollm`](https://www.npmjs.com/package/byollm) — the daemon — runs models on your own machine and answers for it
- [`@byollm/protocol`](https://www.npmjs.com/package/@byollm/protocol) — the wire: envelopes, signatures and the closed vocabularies both ends validate against
- [`@byollm/server`](https://www.npmjs.com/package/@byollm/server) — the SDK a site uses to ask a device for work
- [`@byollm/control-plane`](https://www.npmjs.com/package/@byollm/control-plane) — who may ask whom, and the policy store behind it
- [`@byollm/conformance`](https://www.npmjs.com/package/@byollm/conformance) — the kit that proves an implementation is one — including a posture audit that holds nothing but a URL

### Where the rest lives

- [GitHub](https://github.com/oftomorrowinc/byollm) — the source, and where issues go
- [byo-llm.com](https://byo-llm.com) — what this is, and why
- [byollm.cloud](https://byollm.cloud) — the hosted relay — devices, consent and billing
- [docs.byollm.cloud](https://docs.byollm.cloud) — integrating a site, end to end

<!-- family:end -->
