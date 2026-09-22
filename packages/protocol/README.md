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
  { owner: "alice", audience: "team" },
  {
    owner: "bob",
    offerScope: "team",
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

[`docs/protocol.md`](https://github.com/oftomorrowinc/byollm/blob/main/docs/protocol.md). Every MUST there carries a
conformance id that appears in this package's `MUSTS` registry.

MIT

<!-- family:start -->

## The rest of byollm

Six packages, and they are only interesting together:

- [`byollm`](https://www.npmjs.com/package/byollm) — the daemon — runs models on your own machine and answers for it
- [`@byollm/server`](https://www.npmjs.com/package/@byollm/server) — the SDK a site uses to ask a device for work
- [`@byollm/relay`](https://www.npmjs.com/package/@byollm/relay) — the broker that holds jobs between a site and a device, and can read neither
- [`@byollm/control-plane`](https://www.npmjs.com/package/@byollm/control-plane) — who may ask whom, and the policy store behind it
- [`@byollm/conformance`](https://www.npmjs.com/package/@byollm/conformance) — the kit that proves an implementation is one — including a posture audit that holds nothing but a URL

### Where the rest lives

- [GitHub](https://github.com/oftomorrowinc/byollm) — the source, and where issues go
- [byo-llm.com](https://byo-llm.com) — what this is, and why
- [byollm.cloud](https://byollm.cloud) — the hosted relay — devices, consent and billing
- [docs.byollm.cloud](https://docs.byollm.cloud) — integrating a site, end to end

<!-- family:end -->
