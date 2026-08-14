# Does each check actually bite?

A check that passes against a broken implementation is worse than a missing
one: it reports a gap as covered. This file records, for every check the kit
ships, the smallest change to the reference server or daemon that **must**
make it fail.

Not in CI — mutating a package and rebuilding per check is slow, and a
mutation suite that takes ten minutes gets skipped. The point is that "does
this check bite?" has an answer written down rather than living in whoever
last touched it.

## How to run one

```bash
# 1. Apply the mutation to the named file.
# 2. Rebuild and run the kit:
pnpm run build && npx vitest run packages/conformance
# 3. Confirm ONLY the named check fails.
# 4. Revert.
```

Step 3 matters as much as the failure. A mutation that fails six checks has
not isolated anything — it means the mutation was too broad, or the checks
overlap more than intended.

## Verified 2026-08-13

| Check                         | File                                | Mutation                                                                                                                                                      | Result               |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `C019_CLAIM_ATOMIC`           | `packages/server/src/memory.ts`     | Make `claim` async and `await Promise.resolve()` between the claimable decision and `#jobs.set` — the exact race a store without `FOR UPDATE SKIP LOCKED` has | ✓ bites              |
| `C020_PAIR_CODE_EXPIRES`      | `memory.ts` + `handlers.ts`         | Replace both `pairing.expiresAt <= now` guards with `false`                                                                                                   | ✓ bites              |
| `C021_CAPABILITY_IS_DETECTED` | `packages/daemon/src/runner.ts`     | Replace `if (!health.healthy) continue;` with `if (false) continue;` in `detectCapabilities`                                                                  | ✓ bites              |
| `C022_KIND_NO_CODE`           | `packages/server/src/app.ts`        | Disable the `KindedPayload` guard in `enqueue` and store `input` unvalidated                                                                                  | ✓ bites              |
| `C023_VERSION_HANDSHAKE`      | `packages/server/src/http.ts`       | Disable the `checkProtocolVersion` guard in the fetch handler                                                                                                 | ✓ bites              |
| `C017_METERED_DEFAULTS_SELF`  | `packages/protocol/src/audience.ts` | Delete the `cost === "metered" && spend?.acknowledged !== true` narrowing in `effectiveOfferScope`                                                            | ✓ bites (2026-08-13) |
| `C018_METERED_CEILING`        | `packages/protocol/src/audience.ts` | Replace `daemon.spend.ceilingReached === true` with `false`                                                                                                   | ✓ bites (2026-08-13) |

## Not yet verified

`C001`–`C016` predate this practice. They are not suspect — several were
written against bugs they then caught — but "not suspect" is not the same as
"checked", and the distinction is the whole reason this file exists.

Working through them is worth a session. The ones to do first are the checks
whose MUST has no other enforcement: `C004_AUDIENCE_BOTH_SIDES`,
`C007_SUBSCRIPTION_SELF_LOCK`, `C014_RESULT_PROVENANCE`,
`C015_INGRESS_BEFORE_EXECUTION`. If any of those does not bite, a MUST that
looks certified is not.

## When adding a check

Add its row here, verified, in the same change. A check arriving without a
mutation is a check nobody has confirmed does anything — and the moment
there are two of those, this file stops meaning what it says.
