> [!WARNING]
> **Alpha (`0.1.0-alpha.40`) — under active development. Don't use this yet.**
>
> Install it deliberately: `npm install @byollm/conformance@alpha`.
>
> The protocol is v0 and **will** change without a deprecation path, this has
> never run outside its own test suite, and nothing here has production miles.
> Read it, take the ideas, tell us what's wrong — but don't put it in front of
> your users.
>
> npm assigns `latest` on a first publish and won't let it be removed, so a
> bare install resolves here too. This notice is the only guard — deliberately
> not an npm deprecation, which would read as *abandoned* rather than *early*.
> Ask for `@alpha` explicitly so your lockfile records that you meant to.>
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
> so `0.1.0-alpha.40` is that release, whole.
>
> If you run the Supabase adapter, `alpha.21` needs
> `20260819010000_completed_by_lease_id.sql`: alpha.19 shipped §3.6's
> ordering without the column it stores the grant in.

<!-- release-note 0.1.0-alpha.40 -->
**`byollm install` — stop keeping a terminal open.** The daemon can now run
under your machine's own supervisor and restart itself if it stops: a launchd
agent on macOS, a `systemd --user` unit on Linux, a logon task on Windows. All
user-level — no root, no system directories, and `byollm uninstall` takes it
away. `byollm status` gained a line saying whether it is actually supervised
right now, including the state that matters most: installed but not running,
which looks fine from an app's dashboard and serves nothing.

If you are running via `npx`, install properly first (`npm install -g
byollm@alpha`) — `install` refuses to supervise a copy in npx's cache, because
npm deletes that directory and the service would fail at some later boot.

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
