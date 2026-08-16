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

Two is not six. `C005`'s second mutation also fails `C017`, because making
`case "self"` return `ALLOWED` breaks the metered default that narrows _to_
`self`. That is a shared chokepoint doing its job, not a broad mutation —
noted here so the overlap reads as expected rather than as a smell.

## Verified 2026-08-13

| Check                                | File                                | Mutation                                                                                                                                                      | Result               |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `C019_CLAIM_ATOMIC`                  | `packages/server/src/memory.ts`     | Make `claim` async and `await Promise.resolve()` between the claimable decision and `#jobs.set` — the exact race a store without `FOR UPDATE SKIP LOCKED` has | ✓ bites              |
| `C020_PAIR_CODE_EXPIRES`             | `memory.ts` + `handlers.ts`         | Replace both `pairing.expiresAt <= now` guards with `false`                                                                                                   | ✓ bites              |
| `C021_CAPABILITY_IS_DETECTED`        | `packages/daemon/src/runner.ts`     | Replace `if (!health.healthy) continue;` with `if (false) continue;` in `detectCapabilities`                                                                  | ✓ bites              |
| `C022_KIND_NO_CODE`                  | `packages/server/src/app.ts`        | Disable the `KindedPayload` guard in `enqueue` and store `input` unvalidated                                                                                  | ✓ bites              |
| `C030_SITE_REFUSES_UNSIGNED_RESULTS` | `packages/server/src/handlers.ts`   | Two, both verified: accept an envelope that fails to open in `#openResult`; and drop the `outcome !== disposition` comparison                                 | ✓ bites (both)       |
| `C029_DAEMON_REFUSES_UNSIGNED_WORK`  | `packages/protocol/src/envelope.ts` | Disable the `verifyWith` signature check in `open`                                                                                                            | ✓ bites              |
| `C028_STORED_WORK_IS_SEALED`         | `packages/server/src/app.ts`        | Store the plaintext as the envelope's ciphertext instead of sealing                                                                                           | ✓ bites              |
| `C027_CLAIM_ANSWERS_WITH_STUBS`      | `packages/server/src/handlers.ts`   | Two, both verified: add `payload` back to the claim mapping; and drop the `lease.id` check from `#fetch`                                                      | ✓ bites (both)       |
| `C026_LEASE_SCOPED_RELEASE`          | `packages/server/src/memory.ts`     | Drop `job.lease.id !== leaseId` from the release guard, leaving the runner-id match                                                                           | ✓ bites              |
| `C025_SIGNED_REQUESTS`               | `packages/server/src/handlers.ts`   | Two, both verified: skip the `verifyRequest` result check; and verify against `""` rather than `auth.rawBody`                                                 | ✓ bites (both)       |
| `C024_KEY_EXCHANGE`                  | `packages/server/src/handlers.ts`   | Two, both verified: disable the `verifyPublicIdentity(request.device)` guard; and omit `site` from the approval response                                      | ✓ bites (both)       |
| `C023_VERSION_HANDSHAKE`             | `packages/server/src/http.ts`       | Disable the `checkProtocolVersion` guard in the fetch handler                                                                                                 | ✓ bites              |
| `C017_METERED_DEFAULTS_SELF`         | `packages/protocol/src/audience.ts` | Delete the `cost === "metered" && spend?.acknowledged !== true` narrowing in `effectiveOfferScope`                                                            | ✓ bites (2026-08-13) |
| `C018_METERED_CEILING`               | `packages/protocol/src/audience.ts` | Replace `daemon.spend.ceilingReached === true` with `false`                                                                                                   | ✓ bites (2026-08-13) |

## Verified 2026-08-14 — the four with no other enforcement

The four this file previously nominated as most urgent, now done. (It named
them by a wrong id: `C004` is `LEASE_RECLAIM`; the audience check is `C005`.)

| Check                           | File                                | Mutation                                                                                             | Result                        |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| `C005_AUDIENCE_MATRIX`          | `packages/protocol/src/audience.ts` | Two: delete the `audience === "self" && !sameOwner` refusal; and make `case "self"` return `ALLOWED` | ✓ bites (both)                |
| `C007_SUBSCRIPTION_SELF_LOCK`   | `packages/protocol/src/audience.ts` | Delete **both** the `effectiveOfferScope` lock and the `matchAudience` refusal                       | ✓ bites — but only both       |
| `C014_RESULT_PROVENANCE`        | `packages/protocol/src/job.ts`      | Hard-code `untrusted: false` in `provenanceFor`                                                      | ✓ bites                       |
| `C015_INGRESS_BEFORE_EXECUTION` | `packages/daemon/src/runner.ts`     | Two: delete `recordPrompt`; and **move it after the backend call**                                   | ✓ bites (after strengthening) |

Two of these were more than a tick.

### `C007`: neither guard bites alone, and that is correct

The subscription self-lock is enforced twice — `effectiveOfferScope` narrows
what the daemon advertises, and `matchAudience` refuses again at match time.
Removing either alone changes nothing observable: with only the first gone
the daemon advertises `public` but still refuses; with only the second gone
it never advertises wider than `self`, so the server never offers the work.

Deleting both fails `C007` and nothing else. So the MUST is genuinely
enforced, in depth, and the check catches its removal — it just cannot
attribute which layer did the work. Recorded as "bites, both required"
rather than "bites", because a future reader deleting one guard will find
the suite green and should know that is expected rather than proof the guard
is dead.

### `C015`: the check tested the wrong half of its own name

The MUST is `INGRESS_LOGGED_BEFORE_EXECUTION`. The check waited for the job
to finish and then looked for the prompt in the log — which is satisfied by
logging _after_ execution just as well as before. Moving `recordPrompt` to
after the backend call left the suite fully green.

That ordering is the entire point. The daemon is the owner's trust anchor
and `byollm log` promises every prompt that ran here, ever; a daemon logging
afterwards keeps that promise until the first crash or kill mid-job, and
loses exactly the prompt someone would want to look up.

Fixed by hanging the backend and reading the log **while execution is in
flight**, so the two orderings are distinguishable. The ordering mutation now
bites.

The general lesson, which is the same one the `and`-in-a-MUST note below
records from a different direction: a check named after a property does not
necessarily test that property. Read the name as a claim and ask what
mutation would falsify it.

## Verified 2026-08-16 — the relay's device gate

| Check                        | File                                 | Mutation                                            | Result  |
| ---------------------------- | ------------------------------------ | --------------------------------------------------- | ------- |
| Freeze gate 10 (device gate) | `packages/relay/src/daemon-plane.ts` | Disable the `deviceByFingerprint` refusal in `pair` | ✓ bites |

Lives in the relay's freeze gate rather than the conformance kit because it
is a _cloud_ property, not a protocol MUST: a direct site has no projection
and approves devices through its own pairing flow. The kit certifies the
protocol; the gate certifies the relay.

## Not yet verified

`C001`–`C004`, `C006`, `C008`–`C013`, `C016` predate this practice. They are
not suspect — several were written against bugs they then caught — but "not
suspect" is not the same as "checked", and the distinction is the whole
reason this file exists.

## When adding a check

Add its row here, verified, in the same change. A check arriving without a
mutation is a check nobody has confirmed does anything — and the moment
there are two of those, this file stops meaning what it says.

## A gap that was closed (2026-08-14)

The entry below records that `C028` could not test the server's refusal of a
wrong-key envelope, because reaching that needed store access the kit does
not have.

**Closed by C029.** Once the site seals to the _claiming device_, the daemon
became an opener too — and the kit can hand a daemon an envelope nobody it
trusts signed, which is exactly what a relay substituting work looks like.
Mutation-verified against the signature check itself.

The lesson worth keeping: the gap was not closed by trying harder to test
`C028`. It closed because the system changed shape, and the property became
observable somewhere it had not been. Recording a gap honestly is what made
it obvious when that happened.

## Half a MUST is not a covered MUST (2026-08-14)

`ENVELOPE_SEALED_AND_SIGNED` reads "every payload **and result**". For a day
it was cited by `C029` alone, which tests the payload leg — so the registry
counted the MUST as covered while half of the sentence had nothing behind
it. An implementation could have sealed work to the device and accepted
whatever came back, and passed certification.

`C030` is the other half, and it is worth noting what nearly went wrong in
writing it: the natural first draft asserted that the result endpoint
refuses a forged envelope, and stopped. That would have passed against a
server that refused _everything_, so the check also sends a genuine result
and requires a 200 — the same both-directions discipline `C029` uses.

The rule this suggests, which the coverage counter cannot enforce: when a
MUST is a sentence with an "and" in it, check that each side of the "and"
has a mutation that bites. Coverage is counted per MUST, and a MUST can be
larger than one property.

## A check that did not bite, and what was done about it

`C028` was first written with a third assertion: that an envelope signed by
the wrong key is refused. It called `open()` directly, and a mutation
disabling the _server's_ check went unnoticed — because the assertion tested
the primitive, which `envelope.test.ts` already covers, rather than anything
the server does.

The assertion was removed rather than kept as decoration. Testing the
server-side property needs an envelope the site did not seal, and putting one
in front of it needs store access the kit does not have. Recorded here as a
real gap rather than left as a check that cannot fail.

## Observed flake, not yet explained (2026-08-14)

`C004_LEASE_RECLAIM` failed once against the Supabase adapter at **74ms**,
immediately after `supabase start`, then passed three consecutive times warm
at ~2640ms. The fast failure suggests it gave up before the waiting it is
supposed to do.

Not diagnosed, and deliberately not "fixed" — adding a warm-up without
establishing the cause is cargo-culting. Recorded because CI runs
`supabase start` and certifies immediately, so if this is a cold-start race
CI can hit it too, and the next person seeing a lone C004 failure should know
it has been seen before rather than assume they broke leases.
