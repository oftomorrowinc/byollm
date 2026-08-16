> [!WARNING]
> **Alpha (`0.1.0-alpha.6`) — under active development. Don't use this yet.**
>
> This is a walking skeleton. It routes real jobs between real daemons and real
> sites, and it is the fixture byollm_009 freezes against — but it keeps its
> state in memory, serves one site, and has never run anywhere but a test.

# `@byollm/relay`

The **reference relay**: it routes byollm jobs between a site and someone's
machine while holding no key that can open either end's traffic.

```
  site ──stub──▶  relay  ◀──claim── daemon
       ◀─who claimed?─┤
       ──sealed payload─▶ ──────────▶ (opened only on the device)
       ◀────────────── sealed result ◀──
```

## Why a relay can be blind

A payload is encrypted to the machine that runs it. Nobody knows which machine
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

## Running it

```ts
import { Relay } from "@byollm/relay";

const relay = new Relay({
  siteId: "site_demo",
  fixture: {
    consents: [{ owner: "alice", siteId: "site_demo", site: sitePublicKeys }],
  },
});

// One fetch handler: the daemon plane, the site plane, and /debug.
const response = await relay.handle(request);
```

`/debug` renders every routed job, its state, who claimed it, and how long an
`awaiting-payload` timer has left. It shows no prompt or result text — not
because it filters them out, but because the relay does not have them.

MIT
