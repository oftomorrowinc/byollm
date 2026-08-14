> [!WARNING]
> **Alpha (`0.1.0-alpha.4`) — under active development. Don't use this yet.**
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
> Ask for `@alpha` explicitly so your lockfile records that you meant to.
>
> **`alpha.3` is a breaking change.** `BackendDescriptor.account` is gone —
> read `cost` (`free` / `metered` / `subscription`) instead. Four new MUSTs
> come with it; see `byollm_007`.

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
