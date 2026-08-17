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

## The assertion that cannot fail, and its mirror

Two shapes, met three times now, and worth naming because both read as
perfectly good tests.

**An assertion that cannot fail.** `C028`'s third assertion called `open()`
directly, so it tested the primitive rather than the endpoint that was
supposed to use it. Later, in `lean-customer-discovery`, a positive control
reading "a learner reads their own call, `count(*) = 1`" could not fail
either: the learner was — accidentally — the platform owner, and there was
exactly one call row, so the count is 1 whether scoping works or is bypassed
entirely.

**An assertion that fails for the wrong reason.** The mirror, and the more
dangerous one, because the fix looks obvious. Three checks in
`apps/dashboard/tests/control_plane.test.sql` failed saying Alice could read
Bob's devices. Not a policy hole: `handle_new_user` makes the first profile
in a database an `owner`, and in a fresh transaction that was Alice. She was
correctly permitted to do everything the test said she must not — and the
obvious repair is to loosen the policy until the test goes green, which
would have removed a real protection to satisfy a broken test.

The check that catches both: **name the property the subject must lack, and
assert it.** That test now asserts Alice's role really is `member` before it
asserts anything about what she cannot see. A test whose subject is
accidentally privileged proves the opposite of what it claims, and it proves
it silently.

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

## The plane nobody could reach (2026-08-17)

The freeze gate found eight things in byollm_009 and every one of them was
about the _protocol_. Not one was about the **plane the protocol runs over**,
because in every test that plane was a function call: `SiteConnector` held a
reference to the `Relay` object and invoked `handle()` directly.

So the site plane had no authentication, and nothing noticed for eight
findings. Not a check that failed to bite — a check that was never written,
in a place the test topology could not see. Reading the code before the first
public deploy is what found it, and the deploy is exactly where cloud_001's
Phase 2 plan said to look.

Seven mutations, all killed, listed here because the _set_ is the interesting
part rather than any single one:

| reverted                             | caught by                                   |
| ------------------------------------ | ------------------------------------------- |
| signature verification skipped       | unsigned enqueue is refused                 |
| an unregistered site accepted        | a site the control plane never registered   |
| body-vs-signature site check dropped | a body naming a site the signature does not |
| the routes-for check dropped         | a registered site this relay does not serve |
| `claim`'s siteId filter dropped      | a daemon offered another site's job         |
| `enqueue` overwrites a known id      | a republish that discarded a live lease     |
| the `site/` domain separator dropped | the same call signed for both planes        |

**The one that is a test rather than a scenario.** The domain separator's job
is to stop a daemon-plane signature being replayed on a same-named site-plane
endpoint. There is no such pair today — `result` and `results` differ — so
any staged replay would fail with or without the prefix, and the test would
have been decorative in exactly the way the section above describes. It is
instead a unit test of the property: same key, same endpoint name, same body,
same second, and the two signatures must differ. It fails the moment the
prefix goes, which the scenario version never would.

**The guard deliberately not written.** `enqueue` returning an existing job
needs a collision check for the day two sites share a job id. This relay
serves one site, so that branch cannot be reached and its test could not
fail. It is a comment naming the condition, not code — the multi-tenant
router adds both together.

**The shape to remember:** a test harness that reaches the system under test
by calling it directly cannot see anything about how the system is _reached_.
Auth, transport framing, header parsing, and the difference between a caller
who is authorised and one who merely knows a URL all live in that blind spot.
The two-replica test has the same limitation and says so; this one did not
know it had it.

## Success reported for an unrelated reason (2026-08-17)

The duplicated-value bug has a sibling, and one night produced three of it.
Naming it, because it is now the more dangerous of the two: a duplicated value
fails loudly the moment the copies disagree, and this one never fails at all.

**A check reports success for a reason unrelated to the property it claims.**

| what passed                           | why it passed                                                                | what it claimed             |
| ------------------------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| the deployment posture audit, 6/7     | every probe got a 404 from a load balancer with no matching host rule        | "a stranger got nowhere"    |
| a control-plane test file, "2 passed" | `it.runIf(available)` evaluates at collection time, so three tests never ran | the projection reader works |
| a consent row, looking ordinary       | the disclosure was built from hidden form fields the submitter controls      | this person agreed to this  |

Not one of these is a check that _cannot_ fail. Each can fail, and each was
passing for a reason that had nothing to do with the thing under test — which
is worse, because "it cannot fail" is visible on inspection and "it passed for
another reason" looks exactly like working software.

### How each was actually caught

Worth recording, because none was caught by the suite:

- The audit's 6/7 was caught by **running it against a deployment already
  known to be broken**. A green result where a red one was expected.
- The skipped tests were caught by **reading the skip count**, which was 3 when
  it should have been 0.
- The form-field disclosure was caught by **writing the sentence that
  described it** — "the disclosure shown is the disclosure stored" — and
  noticing the code did not say that.

### The question this suggests

For any check that passes: **name the thing that would have to be true for it
to pass while the property is false.** If that thing is plausible — a
misrouted host, an unrun suite, an attacker-chosen field — the check is
measuring something adjacent to what it claims.

The mechanical version, which caught the first two: a check whose failure mode
is _absence_ (404, skip, empty result) must assert something **positive** about
the thing it found, not merely that it did not find a problem. The posture
audit now requires a refusal to be byollm's own JSON error rather than any
4xx. The projection tests now assert `count(*) = 1` against a fixture with one
visible and two hidden rows, so they fail against a policy that hides
everything as well as one that hides nothing.

## An `operator` MUST whose subject an attacker chooses (2026-08-17)

A refinement of the section above, and the case that motivated it deserves
naming on its own.

`SHARED_COMPUTE_DISCLOSED` — _"before a user's work first runs on compute they
do not own, they MUST be told in plain language that the machine's owner can
see it"_ — is `operator`-kind. byollm_009 §11 says why: **a consent screen's
wording is not wire-observable, and a boolean saying "we disclosed" would be
exactly the box-ticking the MUST exists to prevent.**

That classification is honest and it carries an assumption nobody wrote down.
`operator` means _no automated check can see this; a human audits it instead_.
An audit works by looking at the thing once and knowing what it is — which
requires the thing to be **stable, and ours**.

In `byollm-cloud-web`, the consent screen built the sentence it stored from
hidden form fields. So the audited value was chosen per request by whoever
submitted the form. An auditor reading the code, the screen, or a stored row
would have seen correct disclosure language every time and been right about
nothing: the next submission could say anything, over a `site_id` pointing
somewhere else, and the row would look entirely ordinary afterwards.

**An `operator` MUST whose subject an adversary can vary is not
operator-verified. It is unverified.** There is no layer left: no conformance
check by classification, no wire observation by construction, and no audit
because there is nothing stable to audit.

### The rule

For an `operator`-kind MUST, **the thing being audited must be something the
operator controls.** If a request can change it, the classification is wrong or
the code is — and here it was the code. The fix restores auditability rather
than adding a check: the disclosure is built from the site row the
authorisation used, so what an auditor reads is what every user gets.

### Why this is worth its own entry

The class above — success reported for an unrelated reason — is about checks
that pass wrongly. This is about a MUST that has _no_ check by design, where
the design was sound and one implementation detail removed the only remaining
guarantee. The taxonomy did its job: it labelled the MUST unverifiable so
nobody could think conformance covered it. What it could not do is notice that
the unverifiable thing had become attacker-controlled.

**Where to look for more:** every `operator`-kind MUST, asked one question —
_can a request change what an auditor would be looking at?_ That is a short
list and a cheap sweep, and it is the only list where a wrong answer has no
second line of defence.
