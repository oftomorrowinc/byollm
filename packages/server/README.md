<!-- release-note 0.1.5 -->
> **`0.1.5` carries site tools and images, and the Supabase adapter needs four
> migrations.** Apply `20261103230000_tool_calls`,
> `20261104010000_tool_charges`, `20261104050000_blob_bucket` and
> `20261104160000_blob_table_grants` before you deploy it: without them the
> first `llm.tools` or image job fails on a missing table. A store you wrote
> yourself needs `putBlob`, `getBlob` and `deleteBlob`, and the tool-call
> methods `recordToolCall`, `outstandingToolCalls`, `answerToolCall`,
> `toolResults` and `chargeToolCall`. `PROTOCOL_VERSION` is still `2`.
> "Tools — the site's own" and "Images — direct lane" below are the guides.
> Full note: `docs/release-notes/0.1.5.md`.
>
> This README used to open with a stack of release notes instead of with the
> package. The history moved to `docs/release-notes/` and `CHANGELOG.md`,
> where none of it was lost.

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
// app/byollm/[...route]/route.ts
import { createHandler } from "@byollm/server/next";
import { siteKeysFromEnv } from "@byollm/server";
import { getStore } from "@/lib/byollm";

export const { POST, GET, PUT } = createHandler(() => ({
  store: getStore(),
  siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
  verificationUrl: "https://your-app.com/settings/runners",
}));
```

**Pass a function, not an object.** `next build` imports every route module to
collect page data, in an environment that has no secrets. A config object is
constructed during that import, so the build fails on credentials it cannot
have. A function is not called until the first request.

Then pair against the origin — `byollm connect https://your-app.com`.

**The route has to live at `/byollm`, not under `/api`.** The daemon pairs
with an _origin_: it drops any path it is given (`https://your-app.com/api`
pairs with `https://your-app.com`) and calls `<origin>/byollm/<endpoint>`.
The handler matches the full path, so a route mounted anywhere else — the
Next-conventional `app/api/byollm/[...route]/route.ts` with
`basePath: "/api/byollm"` included — is one no shipped daemon can reach
today. `basePath` remains for a handler that something other than the daemon
must find; leave it out for the daemon.

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

## Images — direct lane

`llm.vision` (reading images) and `llm.image` (making them) carry images by
reference (byollm_021 §2). Hand the SDK bytes; it never hands you a key.

```ts
const job = await getApp().enqueue({
  kind: "llm.vision",
  owner: ownerId,
  payload: {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this photo?" },
          { type: "image", image: photoBytes }, // PNG, JPEG or WebP
        ],
      },
    ],
  },
});
```

Before anything leaves your server the SDK reads the type and size from the
header (SVG, GIF, HEIC and AVIF are refused — convert first), **strips the
metadata** — a phone photo carries where it was taken, and a teammate's
device should not learn that — pads it to 256 KiB, encrypts it under a fresh
key, and stores the ciphertext. The key travels only inside the sealed
payload. `{ bytes, keepMetadata: true }` uploads an image as given.

An `llm.image` job's images come back through `images()`, never through the
result:

```ts
const images = await job.images(); // [{ mediaType, width, height, bytes }]
```

Each one is decrypted and checked — it belongs to this job, its hash matches,
and its header is the declared type and size — before you get it. Serve it
only with its `mediaType` as `Content-Type` and `X-Content-Type-Options:
nosniff`: it is a model's output, bytes and never a document.

**What is kept, and for how long.** Input images are deleted when the result
is accepted. Output images are deleted when `images()` has verified them (or
`app.received(jobId)`), or one hour after the result was first read, and
anything left goes a day after the job's deadline. Run `app.sweep()` on a
schedule so that last rule fires.

**The mount needs `GET` and `PUT`.** A device downloads input images and
uploads output images through short-lived URLs under `/byollm/blobs/`, so
export all three handlers, as above. On the cloud lane the same calls go
through the relay's blob endpoints instead (`app.enqueue`, `job.images()` and
`app.received()` are unchanged), and byollm.cloud serves them from 0.1.5.

**Adapter authors:** the store contract gains `putBlob`, `getBlob` and
`deleteBlob` — a breaking addition in 0.1.5. The Supabase adapter keeps blobs
in a private Storage bucket (migration `20261104050000_blob_bucket.sql`, which
needs Storage enabled).

## Tools — the site's own

`llm.tools` (byollm_012) lets the model on a user's device call tools **your
site** declares, such as your search or your catalogue. The tools run on your
servers, never on the device: the device seals each call to you, your pump runs
the handler, and the answer goes back sealed. The device owner turns tools on
per service, and sees your tools on the consent screen.

**1. Declare them on the purpose, with its limits.** The declarations are what
the person consents to. On byollm.cloud the hub compares the digest of what you
send at enqueue with the manifest of record, and refuses a mismatch as
`tools-manifest-mismatch` with nothing queued, so change both together. A
changed description is a changed consent, and people are asked again.

```ts
const PURPOSES = {
  "fact-checker": {
    label: "Fact Checker",
    kinds: ["llm.tools"],
    tools: {
      web_search: {
        description: "Search the web for a claim",
        parameters: {
          type: "object",
          properties: { query: { type: "string", maxLength: 200 } },
          required: ["query"],
        },
      },
    },
    maxToolCalls: 8, // 1 to 20; the job's budget, counted three times
    maxToolResultChars: 32_000, // what one job may read from your tools
  },
};
```

`maxToolResultChars` counts toward the job's size class before it runs, so a
generous number moves a job up a class and narrows who can serve it.

**2. Register a handler per tool, in every process that pumps.**

```ts
import { ToolError } from "@byollm/server";

getApp().tool("web_search", async ({ query }, job) => {
  const hits = await search(String(query));
  if (hits.length === 0) throw new ToolError("no results for that query");
  return hits.map((h) => `${h.title} — ${h.url}`).join("\n");
});
```

The SDK runs a handler only for a call sealed to your site by the device that
holds the job, for a tool **that job's own payload declares**, within the job's
budget, and with arguments that pass the declaration's schema. Anything else
is dropped or answered with a tool error. Throw `ToolError` for an error the
model may read; any other throw is answered with a fixed sentence, so a stack
trace never reaches a device.

**3. Scope every tool to the job, not to the user.** The arguments are chosen
by a model, and a page or a prompt may have talked it into something. On a
purpose a teammate can serve, the caller may also be a teammate's modified
daemon, signed under a real grant. So a tool may return **only what you would
have put in that job's payload**. Authorising as the job's user is not enough,
because the user's authority reaches further than the job does:

```ts
// An editor's assistant whose jobs are about one manuscript.
getApp().tool("read_section", async ({ section }, job) => {
  // Wrong: any manuscript this user can open. A teammate's device could ask
  // for the user's other drafts.
  //   const doc = await manuscripts.forUser(job.user, String(args.manuscriptId));

  // Right: the manuscript this job is about, which you recorded when you
  // enqueued it. The model cannot name another one.
  const manuscriptId = await jobSubjects.get(job.jobId);
  if (manuscriptId === undefined) throw new ToolError("no manuscript for this job");
  return manuscripts.section(manuscriptId, String(section));
});
```

A tool that would act for somebody else is not a tool to declare at all. Start
with read-only tools; a tool that writes is a write chosen by a model.

**4. Enqueue it like chat, with the declarations.**

```ts
const job = await getApp().enqueue({
  kind: "llm.tools",
  owner: ownerId,
  purpose: "fact-checker",
  payload: {
    messages: [{ role: "user", content: `Check this claim: ${claim}` }],
    tools: [{ name: "web_search", ...PURPOSES["fact-checker"].tools.web_search }],
    purposeLimits: { maxToolCalls: 8, maxToolResultChars: 32_000 },
  },
});
```

The result's `ran.toolCalls` counts every call the model made, including
refused and timed-out ones, and `ran.toolOutcomes` says how each ended. A job
that spends its budget ends `ok` with `stop: "tool-budget"`. If every call
timed out, the answer came from the model's memory, not your tools: say so.

**5. Keep the pump turning while tool jobs run.** Your handlers run inside
`app.pump()`, on both lanes. A call nobody answers in 60 seconds is a tool
error to the model, and still counts. A serverless request dies at its
platform's ceiling, and a tool job can outlive the request that enqueued it.
So pump from the request that waits on the job, **and** from a scheduled job
that keeps cycling while `await app.toolJobsInFlight()` is true. If you cannot
schedule work, run one tool job per request and size `maxToolCalls` to fit the
route's ceiling.

**What the round trips cost.** On the direct lane a call waits for your next
pump cycle and the device's next poll, about a second apart. On the cloud lane
add the relay's hop and your pump's cadence: at a 1.5-second pump, a call
costs roughly 2 to 4 seconds before your tool runs, so a job with eight calls
spends perhaps half a minute on round trips. That suits verification and
research. It does not suit interactive chat.

**Older relays and devices.** A pump whose relay answers `404` on `calls` reads
it as a relay that carries no tools and runs the rest of its cycle. A device on
0.1.4, or whose only service is a Claude or Codex subscription, cannot serve
`llm.tools`; the person is told which device to update.

**Adapter authors:** the store contract gains the tool-call methods
(`recordToolCall`, `outstandingToolCalls`, `answerToolCall`, `toolResults`,
`chargeToolCall`). The Supabase adapter needs `20261103230000_tool_calls.sql`
and `20261104010000_tool_charges.sql`.

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

The protocol handler needs the **service role** key: a runner is not a
Supabase user — its requests are signed with its device key, not carried by a
Supabase session — so RLS cannot identify it. RLS still governs everything
the browser does.

## Two things the API makes you confront

**Community results are untrusted.** A `team` result came from someone
else's device and can be anything. Every result carries provenance,
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
