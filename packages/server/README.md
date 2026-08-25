> [!WARNING]
> **Alpha (`0.1.0-alpha.48`) — under active development. Don't use this yet.**
>
> Install it deliberately: `npm install @byollm/server@alpha`.
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
> **`alpha.7` breaks nobody who is not implementing a relay.** `@byollm/relay`'s
> projection gains `devices` — the device keys a control plane has approved —
> and the relay refuses to pair a device that is not in it. `revoked` becomes
> `{owner, siteId}` instead of a composite string. Sites, daemons, stores and
> the wire format are all untouched; no runner re-pairs.
>
> **`alpha.5` broke store adapters, and nothing else.** If you implement
> `JobStore` yourself, two changes are required: a new `adopt(args)` method
> (record a lease granted by an upstream this store does not own), and
> `CompleteArgs.runnerId` is replaced by `holder` — a discriminated union
> naming either a runner or a lease. Apps, daemons and the wire format are
> unaffected; `@byollm/conformance` will tell you if you missed one.
>
> **`alpha.4` broke every integration.** Three things changed for you:
>
> 1. **`siteKeys` is required.** Run `npx @byollm/server@alpha keygen` once,
>    set `BYOLLM_SITE_KEYS`, and pass it to `ByollmApp` and `createHandler`.
>    Once — not per deploy, never at startup.
> 2. **`createHandler` takes a function.** `next build` imports route modules
>    with no secrets present, so a config object fails the build.
> 3. **Every paired runner re-pairs.** Bearer tokens are replaced by per-request
>    signatures against a pinned device key, so old tokens authenticate nothing.
>
> Your store adapter is unaffected: payloads and results are sealed before they
> reach it, and `JobStore` did not change.

<!-- release-note 0.1.0-alpha.21 -->
> [!NOTE]
> **`0.1.0-alpha.20` is not a complete release — do not pin it.** Four
> packages published and `@byollm/server` did not: a Sigstore
> transparency-log 409 on its provenance attestation. The workflow's
> "already published" guard correctly refuses to resume a partial publish,
> so `0.1.0-alpha.48` is that release, whole.
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

# `@byollm/server`

What app developers drop into their backend: framework-agnostic protocol
handlers, a reference in-memory store, a Next.js mount, and a Supabase
adapter.

```bash
npm install @byollm/server
```

## The three-file integration

**1. Mount the protocol.**

```ts
// app/api/byollm/[...route]/route.ts
import { createHandler } from "@byollm/server/next";
import { siteKeysFromEnv } from "@byollm/server";
import { getStore } from "@/lib/byollm";

export const { POST } = createHandler(() => ({
  store: getStore(),
  siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
  verificationUrl: "https://your-app.com/settings/runners",
  // Next serves this route under /api, so say where it is mounted. The
  // handler matches the full path and will 404 without this.
  basePath: "/api/byollm",
}));
```

**Pass a function, not an object.** `next build` imports every route module to
collect page data, in an environment that has no secrets. A config object is
constructed during that import, so the build fails on credentials it cannot
have. A function is not called until the first request.

Then pair against that same path — `byollm connect https://your-app.com/api`.
The daemon appends `/byollm/<endpoint>` to whatever origin it is given, so
connecting to the bare domain looks for `/byollm/claim` and finds nothing.
To serve at `/byollm` instead, put the route at `app/byollm/[...route]/route.ts`,
drop `basePath`, and pair against the bare domain.

**2. Pick a store.**

```ts
// lib/byollm.ts
import { ByollmApp, MemoryStore, siteKeysFromEnv } from "@byollm/server";

// Lazily, and memoized, for the same reason the mount takes a function: a
// module-scope `new` runs during `next build`.
let store: MemoryStore | undefined;
export function getStore(): MemoryStore {
  return (store ??= new MemoryStore());
}

let app: ByollmApp | undefined;
export function getApp(): ByollmApp {
  return (app ??= new ByollmApp({
    store: getStore(),
    siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
  }));
}
```

Generate that identity once, and keep it:

```bash
npx @byollm/server@alpha keygen   # prints BYOLLM_SITE_KEYS=...
```

Once, not per deploy and never at startup — a daemon pins this identity when
its owner approves the pairing, and regenerating it means every paired device
must pair again. Generating at startup fails only under horizontal scale: each
instance would have a different identity, and a daemon would be refused by
whichever one it did not pair with.

**3. Enqueue.**

```ts
const job = await getApp().enqueue({
  kind: "llm.generate",
  audience: "private", // this user's own device only — the default
  owner: userId,
  payload: { prompt: `Summarize this transcript:\n\n${transcript}` },
});

const { outcome, fallback } = await job.result({
  timeoutMs: 120_000,
  // A string is enough — it is your own fallback answer, not wire data.
  onNoRunner: () => runOnHostedModel(transcript),
});

// `fallback` is true when nobody's device ran it and this came from your
// own substitute. Say so wherever you show the answer: work that did not run
// on the user's compute must not be presented as though it did.
```

`result()` is sugar over your delivery channel with a timeout and a
`noRunnerAvailable` path — never a bare promise that hangs forever. If nobody
is online to run the job, you find out and can fall back.

## The approval page

Pairing is a device-code exchange, so you need one page where a signed-in user
types the code their daemon showed them:

```ts
// The owner comes from YOUR session. A daemon can never assert who it is.
const runner = await getApp().approvePairing({
  userCode: formData.get("code"),
  owner: session.userId,
});
```

`app.pendingPairing(code)` tells you what they are about to approve — device
label, platform, and which models it is offering — so the page can show it.

## Stores

| Store           | For                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MemoryStore`   | Tests, demos, single-process apps. The reference implementation the conformance kit certifies first.             |
| `supabaseStore` | Postgres via Supabase: migrations, an RLS-scoped claim RPC with `FOR UPDATE SKIP LOCKED`, and Realtime delivery. |
| yours           | Implement `JobStore` + `RunnerStore` and run `@byollm/conformance` against it.                                   |

### Supabase

```ts
import {
  supabaseStore,
  supabaseRealtimeDelivery,
} from "@byollm/server/supabase";

const store = supabaseStore({ client: serviceRoleClient });
const app = new ByollmApp({
  store,
  siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
  delivery: supabaseRealtimeDelivery(serviceRoleClient),
});
```

Copy `supabase/migrations/*.sql` into your project's migrations. It ships the
`byollm_*` tables, RLS policies, the atomic claim RPC, the dependency-unblock
trigger and the expiry sweep.

The protocol handler needs the **service role** key: a runner authenticates
with its own bearer token, which is not a Supabase session. RLS still governs
everything the browser does.

## Two things the API makes you confront

**Community results are untrusted.** A `named`/`public` result came from
someone else's device and can be anything. Every result carries provenance,
and `untrusted` is derived from the audience — you cannot mark volunteer
output as first-party:

```ts
const { outcome, provenance } = await getApp().result(jobId);
if (provenance?.untrusted) {
  // Do not render as trusted HTML. Do not feed to a privileged step.
  // Disclose where it came from.
}
```

**Jobs can depend on each other.** `dependsOn: [jobId]` keeps a job
unclaimable until its dependencies are `ok`. One field and one claim
predicate, not a DAG engine — so the two halves of a piece of work can land on
two different people's devices, in order, without your app orchestrating the
wait.

## Certifying an adapter

```bash
npx byollm-certify ./my-target.js
```

A server is byollm-compatible when the kit passes. See
[`@byollm/conformance`](../conformance).

MIT
