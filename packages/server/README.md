<!-- release-note 0.1.1 -->
> **`0.1.1` is documentation only — nothing to upgrade.** `PROTOCOL_VERSION`
> is still `2`, so a 0.1.0 party and a 0.1.1 party talk to each other in both
> directions. No dependency, schema, wire field or on-disk shape moved.
>
> This README used to open with a stack of release notes instead of with the
> package. The history moved to `docs/release-notes/` and `CHANGELOG.md`,
> where none of it was lost. Full note: `docs/release-notes/0.1.1.md`.

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
npx --package @byollm/server keygen   # prints BYOLLM_SITE_KEYS=...
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
  owner: ownerId, // who this is depends on your mode — see below
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

## Who `owner` is — this differs by mode

`owner` names the person whose devices should do the work, and the two
connection modes do not use the same names for people. Getting this wrong is
the one integration mistake that produces no error: the job enqueues, returns
an id, and never routes.

**Direct** — daemons reach your own handlers, and you are the only party who
knows who anybody is. `owner` is your own user id, from your session, never
from the client. That is what the example above shows.

**Cloud** — daemons reach `hub.byollm.cloud`, which has its own identity
space: rosters, consents and budgets all speak **BYOLLM ids**. Your user id
means nothing there. `owner` must be the person's BYOLLM id.

Ask them for it. Every signed-in person can read it on their byollm.cloud
account page under **Your BYOLLM id**, with a copy button. Add a settings
field, have them paste it, store it against your own user record.

The id names them and authorises nothing — someone holding it can address work
to a person and cannot deliver it, because the consent row is what opens the
route. So a pasted id is not a credential you are being trusted with, and a
wrong one is harmless. Two things still matter: it must come from the person's
own account rather than being inferred by your app, and they must connect your
site on byollm.cloud before anything routes.

**A wrong id is silence, not an error.** The relay routes on a consented
`(site, owner)` pair, so a mistyped id — or one belonging to somebody who has
not connected your site — matches no route. The job waits, then expires. So
check ids when you receive them rather than when you enqueue:

```ts
const { available } = await getApp().runnerAvailability({
  kind: "llm.generate",
  owner: pastedByollmId,
});

if (!available) {
  // Existence-neutral, deliberately.
  return "That id has no devices for you. Check it, or connect this site on byollm.cloud.";
}
```

Keep that message vague on purpose. A typo'd id and an id belonging to somebody
who has not connected you give the same answer, and that is the system working
rather than a limitation to route around — telling them apart would make this
call an account-existence oracle: probe a guess, sort the answers, enumerate.
Never write "no such account". If you ever get an answer that *does*
distinguish them, that is a bug worth reporting.

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
npm install --save-dev @byollm/conformance
npx byollm-certify ./my-target.js
```

A server is byollm-compatible when the kit passes. See
[`@byollm/conformance`](https://github.com/oftomorrowinc/byollm/tree/main/packages/conformance).

MIT

<!-- family:start -->

## The rest of byollm

Six packages, and they are only interesting together:

- [`byollm`](https://www.npmjs.com/package/byollm) — the daemon — runs models on your own machine and answers for it
- [`@byollm/protocol`](https://www.npmjs.com/package/@byollm/protocol) — the wire: envelopes, signatures and the closed vocabularies both ends validate against
- [`@byollm/relay`](https://www.npmjs.com/package/@byollm/relay) — the broker that holds jobs between a site and a device, and can read neither
- [`@byollm/control-plane`](https://www.npmjs.com/package/@byollm/control-plane) — who may ask whom, and the policy store behind it
- [`@byollm/conformance`](https://www.npmjs.com/package/@byollm/conformance) — the kit that proves an implementation is one — including a posture audit that holds nothing but a URL

### Where the rest lives

- [GitHub](https://github.com/oftomorrowinc/byollm) — the source, and where issues go
- [byo-llm.com](https://byo-llm.com) — what this is, and why
- [byollm.cloud](https://byollm.cloud) — the hosted relay — devices, consent and billing
- [docs.byollm.cloud](https://docs.byollm.cloud) — integrating a site, end to end

<!-- family:end -->
