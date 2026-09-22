<!-- release-note 0.1.1 -->
> **`0.1.1` is documentation only — nothing to upgrade.** `PROTOCOL_VERSION`
> is still `2`, so a 0.1.0 party and a 0.1.1 party talk to each other in both
> directions. No dependency, schema, wire field or on-disk shape moved.
>
> This README used to open with a stack of release notes instead of with the
> package. The history moved to `docs/release-notes/` and `CHANGELOG.md`,
> where none of it was lost. Full note: `docs/release-notes/0.1.1.md`.

# `@byollm/conformance`

The compatibility contract. **A server is byollm-compatible when this kit
passes against it** — that sentence is the whole versioning story. There is no
framework version to chase; the tests are what compatibility means.

```bash
npm install --save-dev @byollm/conformance
npx byollm-certify ./my-target.js
```

**The install line is not optional, and the reason is worth a sentence.**
`byollm-certify` is a bin inside this package, and there is no package of that
name — so invoking the bin through `npx` without installing first asks npm for
a package called after the bin, and gets a 404. Installing it first is what
makes the second line work, and it is where you want the kit anyway: in
`devDependencies`, running in CI.

*(The broken form is described rather than printed. A README that shows a
command which does not work is a README somebody copies from.)*

For a one-off without installing, name the package explicitly:

```bash
npx --package @byollm/conformance byollm-certify ./my-target.js
```

```
byollm conformance — my server

  ✓ C001_PAIRING_BINDS_ONE_USER  a runner token is bound to exactly the approving user  (279ms)
  ✓ C002_JOB_ROUND_TRIP  an enqueued job runs on the owner's daemon and the result comes back  (83ms)
  …
  32 checks passed — my server is byollm-compatible.
```

## What it actually does

Each check drives a **real daemon** — the shipped runner, the shipped
device-code pairing, the shipped local allowlist, the shipped budget checks —
against your server. What gets certified is the behaviour of the pair, not
either side's opinion of the other.

Only the model at the very end is substituted, because the kit certifies the
protocol and not anyone's choice of model.

## Writing a target

Implement `ConformanceTarget`: a `fetch` for the protocol surface, plus the
app-side control the kit needs to set up scenarios.

```ts
import type { ConformanceTarget } from "@byollm/conformance";

export default function target(): ConformanceTarget {
  return {
    name: "my server",
    origin: "https://my-app.test",
    leaseMs: 2_000,
    ttlMs: 1_500,

    fetch: (request) => myHandler(request),
    enqueue: (input) => myApp.enqueue(input),
    approvePairing: (userCode, owner) => myApp.approve(userCode, owner),
    revokeRunner: (id) => myApp.revoke(id),
    cancelJob: (id) => myApp.cancel(id),
    job: (id) => myApp.job(id),
    runnerAvailability: (q) => myApp.availability(q),
    sweep: () => myApp.sweep(),
    reset: () => myApp.truncate(),

    // Optional: if your owner ids are not the names the checks use.
    ownerId: (name) => myApp.userIdFor(name),
    // Optional: if you can fake time, the lease and TTL checks run instantly.
    advanceTime: (ms) => myClock.advance(ms),
  };
}
```

Two optional hooks worth knowing about:

- **`ownerId`** exists because owner ids are server-namespace-local. A target
  backed by real auth uses uuids, not names, and a kit that assumed names
  round-tripped would be assuming away the very thing the `team` allowlist is
  about.
- **`advanceTime`** lets an in-memory server run the lease and TTL checks in
  milliseconds. A real Postgres cannot fake its clock, so the kit waits for
  real instead — which is why such a target should declare a short `leaseMs`
  and `ttlMs`.

## The checks

| Check                                  | Asserts                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| `C001_PAIRING_BINDS_ONE_USER`          | a token is bound to exactly the approving user               |
| `C002_JOB_ROUND_TRIP`                  | a job runs on its owner's daemon and the result returns      |
| `C003_UNKNOWN_KIND_REFUSED`            | a daemon is never handed a kind it did not advertise         |
| `C004_LEASE_RECLAIM`                   | a job whose runner vanished is offered again, losing nothing |
| `C005_AUDIENCE_MATRIX`                 | all nine audience × offer-scope combinations                 |
| `C006_NAMED_LOCAL_ALLOWLIST`           | `team` runs only once the daemon's own list admits it        |
| `C007_SUBSCRIPTION_SELF_LOCK`          | a subscription backend refuses others' work at any scope     |
| `C008_REVOCATION`                      | a revoked daemon stops mid-queue                             |
| `C009_CANCEL_MID_FLIGHT`               | cancel aborts a running job's backend call                   |
| `C010_RESULT_IDEMPOTENT`               | the first terminal outcome wins                              |
| `C011_DEPENDENCY_ORDER`                | a dependent job waits, across two daemons                    |
| `C012_TTL_AND_NO_RUNNER`               | unclaimed jobs expire; no-runner is surfaced                 |
| `C013_TTL_CLOCK_STARTS_WHEN_CLAIMABLE` | a blocked job does not expire while waiting                  |
| `C014_RESULT_PROVENANCE`               | community results arrive marked untrusted                    |
| `C015_INGRESS_BEFORE_EXECUTION`        | every executed prompt is logged                              |
| `C016_UNAUTHENTICATED_REFUSED`         | endpoints refuse an unknown token                            |

## It reports its own gaps

`formatReport` lists every protocol MUST that no check asserts. Some are
daemon-internal and proven by the adversarial suite instead; the point is that
the gap is **visible in the output** rather than implied away, and a newly
added MUST shows up there until someone writes its check.

## What a red means, and what it does not

A verdict that can be wrong has to say so, and this one is published as the
thing that tells you whether you speak the protocol — so the asymmetry is
worth stating plainly.

**A red says: this target did not satisfy that check, on this run.** It names
the check, and the check names the MUST. That is the whole of the claim.

**A red does not say your implementation is wrong in general**, and it does not
say the fault is yours. A check can go red because the kit itself is flaky —
and if it ever does, **you have no way to tell our defect from yours**, which
is the asymmetry that matters. You would reasonably assume it is your code. It
might be ours.

We treat that as our problem rather than yours:

- **The kit's own flake rate is measured, not assumed.** As of 2026-09-18:
  30 consecutive parallel runs of this package's suite, zero failures; and
  across 28 instrumented runs of the whole repository's suite, no check in
  this package failed once.
- **If a check here is ever found to be unreliable, it moves out of the
  verdict** — it keeps running and stays visible, and it is named here with
  its exact symptom, so a stranger who hits it knows immediately that it is
  ours. **It does not get its assertion loosened**, because a check quietly
  weakened until it stops failing is worse than one that admits it is
  advisory.
- **Nothing is in that state today.** If this list is empty, that is the claim.

This is not a new principle here. `vitest.config.ts` in this repository reached
it first, arguing about a slow Windows runner:

> A red build nobody can reproduce teaches people to hit rerun, and a suite
> whose failures are sometimes meaningless stops being read. That cost lands
> hardest on the first outside contributor, who cannot tell our flake from
> their mistake.

MIT

<!-- family:start -->

## The rest of byollm

Six packages, and they are only interesting together:

- [`byollm`](https://www.npmjs.com/package/byollm) — the daemon — runs models on your own machine and answers for it
- [`@byollm/protocol`](https://www.npmjs.com/package/@byollm/protocol) — the wire: envelopes, signatures and the closed vocabularies both ends validate against
- [`@byollm/server`](https://www.npmjs.com/package/@byollm/server) — the SDK a site uses to ask a device for work
- [`@byollm/relay`](https://www.npmjs.com/package/@byollm/relay) — the broker that holds jobs between a site and a device, and can read neither
- [`@byollm/control-plane`](https://www.npmjs.com/package/@byollm/control-plane) — who may ask whom, and the policy store behind it

### Where the rest lives

- [GitHub](https://github.com/oftomorrowinc/byollm) — the source, and where issues go
- [byo-llm.com](https://byo-llm.com) — what this is, and why
- [byollm.cloud](https://byollm.cloud) — the hosted relay — devices, consent and billing
- [docs.byollm.cloud](https://docs.byollm.cloud) — integrating a site, end to end

<!-- family:end -->
