> [!WARNING]
> **Alpha 0.1.0 — under active development. Don't use this yet.**
>
> > Install it deliberately: `npm install @byollm/server@alpha`.
> The protocol is v0 and **will** change without a deprecation path, this has
> never run outside its own test suite, and nothing here has production miles.
> Read it, take the ideas, tell us what's wrong — but don't put it in front of
> your users.
>
> npm assigns `latest` on a first publish and won't let it be removed, so the
> alpha is also `latest`; the version is marked deprecated so every install
> says so out loud.

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
import { store } from "@/lib/byollm";

export const { POST } = createHandler({
  store,
  verificationUrl: "https://your-app.com/settings/runners",
});
```

**2. Pick a store.**

```ts
// lib/byollm.ts
import { ByollmApp, MemoryStore } from "@byollm/server";

export const store = new MemoryStore();
export const app = new ByollmApp({ store });
```

**3. Enqueue.**

```ts
const job = await app.enqueue({
  kind: "llm.generate",
  audience: "self", // this user's own machine only — the default
  owner: userId,
  payload: { prompt: `Summarize this transcript:\n\n${transcript}` },
});

const { outcome } = await job.result({
  timeoutMs: 120_000,
  onNoRunner: () => runOnHostedModel(transcript),
});
```

`result()` is sugar over your delivery channel with a timeout and a
`noRunnerAvailable` path — never a bare promise that hangs forever. If nobody
is online to run the job, you find out and can fall back.

## The approval page

Pairing is a device-code exchange, so you need one page where a signed-in user
types the code their daemon showed them:

```ts
// The owner comes from YOUR session. A daemon can never assert who it is.
const runner = await app.approvePairing({
  userCode: formData.get("code"),
  owner: session.userId,
});
```

`app.pendingPairing(code)` tells you what they are about to approve — machine
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
someone else's machine and can be anything. Every result carries provenance,
and `untrusted` is derived from the audience — you cannot mark volunteer
output as first-party:

```ts
const { outcome, provenance } = await app.result(jobId);
if (provenance?.untrusted) {
  // Do not render as trusted HTML. Do not feed to a privileged step.
  // Disclose where it came from.
}
```

**Jobs can depend on each other.** `dependsOn: [jobId]` keeps a job
unclaimable until its dependencies are `ok`. One field and one claim
predicate, not a DAG engine — so the two halves of a piece of work can land on
two different people's machines, in order, without your app orchestrating the
wait.

## Certifying an adapter

```bash
npx byollm-certify ./my-target.js
```

A server is byollm-compatible when the kit passes. See
[`@byollm/conformance`](../conformance).

MIT
