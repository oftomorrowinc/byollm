# `@byollm/conformance`

The compatibility contract. **A server is byollm-compatible when this kit
passes against it** — that sentence is the whole versioning story. There is no
framework version to chase; the tests are what compatibility means.

```bash
npx byollm-certify ./my-target.js
```

```
byollm conformance — my server

  ✓ C001_PAIRING_BINDS_ONE_USER  a runner token is bound to exactly the approving user  (279ms)
  ✓ C002_JOB_ROUND_TRIP  an enqueued job runs on the owner's daemon and the result comes back  (83ms)
  …
  16 checks passed — my server is byollm-compatible.
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
  round-tripped would be assuming away the very thing the `named` allowlist is
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
| `C006_NAMED_LOCAL_ALLOWLIST`           | `named` runs only once the daemon's own list admits it       |
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

MIT
