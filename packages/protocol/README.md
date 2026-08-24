> [!WARNING]
> **Alpha (`0.1.0-alpha.42`) — under active development. Don't use this yet.**
>
> Install it deliberately: `npm install @byollm/protocol@alpha`.
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
>
> **`alpha.3` is a breaking change.** `BackendDescriptor.account` is gone —
> read `cost` (`free` / `metered` / `subscription`) instead. Four new MUSTs
> come with it; see `byollm_007`.

<!-- release-note 0.1.0-alpha.21 -->
> [!NOTE]
> **`0.1.0-alpha.20` is not a complete release — do not pin it.** Four
> packages published and `@byollm/server` did not: a Sigstore
> transparency-log 409 on its provenance attestation. The workflow's
> "already published" guard correctly refuses to resume a partial publish,
> so `0.1.0-alpha.42` is that release, whole.
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
somebody's machine cannot be reported as though it did (`FALLBACK_LABELED`).
Both delivery channels do it, polling and Supabase Realtime. Records still
work; they just get labelled too.

# `@byollm/protocol`

The BYOLLM wire contract: TypeScript types, zod schemas, and the pure rules
that the daemon and the server **both** enforce.

Nothing in this package does I/O. That is the point — the daemon refuses
misbehaviour, and the server refuses it too, and both run the identical
function rather than two implementations that drift.

```bash
npm install @byollm/protocol
```

## What's in here

| Export                              | What it is                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `matchAudience`                     | The nine-way audience × offer-scope decision, as a pure total function.                |
| `effectiveOfferScope`               | The subscription self-lock, applied at one place so no code path sees a widened scope. |
| `MUSTS`                             | Every normative MUST as data. The conformance kit fails if one has no test.            |
| `BACKENDS`                          | The backend registry — class (`http`/`process`) and account (`open`/`subscription`).   |
| `ClaimedJob`, `HeartbeatRequest`, … | Schemas for the five endpoints.                                                        |
| `canTransition`, `isTerminal`       | The job lifecycle, as data.                                                            |
| `provenanceFor`                     | Builds a result's provenance; `untrusted` is derived, never supplied.                  |

## The two rules worth knowing

**A payload is data handed to a model, never configuration.** There is no
field on the wire for a model, a base URL, a flag, a path, or an environment
variable, and payload objects are `strict()` — an unknown key is a parse
failure, not something quietly ignored deeper in.

```ts
import { GeneratePayload } from "@byollm/protocol";

GeneratePayload.safeParse({ prompt: "hi", model: "gpt-4" }).success; // false
GeneratePayload.parse({ prompt: "$(rm -rf /)" }).prompt; // "$(rm -rf /)" — just characters
```

**Both sides must admit the other.** A job runs on a daemon only if the job's
audience admits the daemon's owner _and_ the backend's offer scope admits the
job's owner.

```ts
import { matchAudience } from "@byollm/protocol";

matchAudience(
  { owner: "alice", audience: "named" },
  {
    owner: "bob",
    offerScope: "named",
    account: "open",
    // The daemon's OWN allowlist decides — never the server's assertion.
    locallyAllows: (owner) => owner === "alice",
  },
); // { ok: true }
```

Refusals are typed and distinct (`not-locally-allowed` is not the same event
as `offer-scope-too-narrow`), because a volunteer debugging their setup needs
to know which one happened.

## Normative spec

[`docs/protocol.md`](../../docs/protocol.md). Every MUST there carries a
conformance id that appears in this package's `MUSTS` registry.

MIT
