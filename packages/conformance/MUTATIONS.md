# Does each check actually bite?

A check that passes against a broken implementation is worse than a missing
one: it reports a gap as covered. This file records, for every check the kit
ships, the smallest change to the reference server or daemon that **must**
make it fail.

## Two rules, because everything below is an instance of one of them

### A MUST enforced only as a side effect of another rule's refusal is coincident, not enforced

> **The test: delete the branch named after it. Does its check fail?**

`RESULT_IDEMPOTENT` failed this. `complete` nulls the lease on success, so a
replayed result was refused for not holding the job and the terminal-state
branch was never reached — deleting idempotency from the reference store broke
nothing, and the conformance check said `RESULT_IDEMPOTENT` in its name.

It mattered beyond tidiness because byollm_009 §4's argument for signing
requests rather than issuing nonces _cites_ it: every write is idempotent per
the instance it names. A MUST that another MUST's security case leans on
cannot be one that holds because a null happens to trip first.

The fix was an ordering — terminal state before holder, in all four stores at
once — and the general shape is worth keeping: **when two rules can refuse the
same request, the order decides which one you are actually enforcing.** Pick
it deliberately, write it once, and make the check distinguish them.

### The one below, which is about tests rather than design

> **When a test cites a MUST, ask what other rule would also make it pass.
> If the answer is "the rule you are replacing", the test is about the
> outcome and not about the MUST — and it will keep passing through the
> regression it exists to catch.**

Six instances in one week, and the sixth is the one that earns this a place
at the top rather than an entry at the bottom. A test for lease renewal
asserted the outcome — one execution, a collected result, final state `done`
— and **passed against a relay that renewed nothing**. The lease lapsed, the
sweep requeued the job, the daemon re-claimed it under a new grant, and the
original run finished and posted its result at the end. Every end-state
assertion was satisfied by a sequence that was wrong in every step between
them.

That is the first time in this series that the wrong sequence produced the
_right_ answer rather than a vacuous one, and it is why the rule has to be
mechanical. There is nothing suspicious to notice, so no amount of reading
finds it. Only mutating does.

The corollary, for anything whose subject is a property of a job's _life_
rather than its end: sample it while it runs. Collect every lease id observed
during the job and assert there was exactly one. A second id means the grant
was taken away and given back, however the job happens to finish.

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
`case "private"` return `ALLOWED` breaks the metered default that narrows
_to_ `private`. That is a shared chokepoint doing its job, not a broad mutation —
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

| Check                           | File                                | Mutation                                                                                                   | Result                        |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `C005_AUDIENCE_MATRIX`          | `packages/protocol/src/audience.ts` | Two: delete the `audience === "private" && !sameOwner` refusal; and make `case "private"` return `ALLOWED` | ✓ bites (both)                |
| `C007_SUBSCRIPTION_SELF_LOCK`   | `packages/protocol/src/audience.ts` | Delete **both** the `effectiveOfferScope` lock and the `matchAudience` refusal                             | ✓ bites — but only both       |
| `C014_RESULT_PROVENANCE`        | `packages/protocol/src/job.ts`      | Hard-code `untrusted: false` in `provenanceFor`                                                            | ✓ bites                       |
| `C015_INGRESS_BEFORE_EXECUTION` | `packages/daemon/src/runner.ts`     | Two: delete `recordPrompt`; and **move it after the backend call**                                         | ✓ bites (after strengthening) |

Two of these were more than a tick.

### `C007`: neither guard bites alone, and that is correct

The subscription self-lock is enforced twice — `effectiveOfferScope` narrows
what the daemon advertises, and `matchAudience` refuses again at match time.
Removing either alone changes nothing observable: with only the first gone
the daemon advertises `public` but still refuses; with only the second gone
it never advertises wider than `private`, so the server never offers the work.

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

## Verified 2026-08-20 — the two checks that arrived without rows (V1-15)

| check                          | mutated                           | mutation                                                          | result  |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------- | ------- |
| `C032_SERVER_REFUSES_TO_OFFER` | `packages/server/src/memory.ts`   | Return `true` from `#isClaimable` before the `matchAudience` call | ✓ bites |
| `C031_ROSTER_NOT_DISCLOSED`    | `packages/server/src/handlers.ts` | Spread `audienceAllow` back onto the claimed stub                 | ✓ bites |

Both were added with the finding they close and neither had a row, which this
file's own closing rule says voids it once there are two. There were two.

`C031`'s mutation is worth reading twice: the field had to be added back
through a **conditional spread**, because that is the only way to put it there
without a type error — and it is exactly how the field survived being deleted
from the schema in the first place (`handlers.ts` says so where it happened).
The mutation and the original bug are the same edit.

## Not yet verified

`C001`–`C004`, `C006`, `C008`, `C009`, `C011`–`C013`, `C016` predate this
practice. `C010` left this list when it was rebuilt around terminal-before-
holder ordering — its mutation is recorded above, and naming it here as well
said the opposite of what the table says. They are
not suspect — several were written against bugs they then caught — but "not
suspect" is not the same as "checked", and the distinction is the whole
reason this file exists.

## The kinds this file does not cover, and the one that now has a reader (2026-08-20)

`MUTATIONS.md` is about the conformance kit. The registry has three other
`verifiedBy` kinds, and `adversarial` — "the reference daemon's own hostile
suites prove this" — was **counted by nothing**: no cross-check, no citation,
no reader. `SITE_KEY_BY_STUB` is the specimen, and its own registry comment
explains why it is the dangerous one: every honest path passes with the site
check deleted, because `open` refuses a signature from the wrong key anyway.
The only thing separating that MUST from unverified is a hostile pairing of
stub and envelope — and no test named it.

`packages/daemon/src/adversarial-citations.test.ts` now fails if any
`adversarial` MUST is named by no test the daemon's suites run. It proves a
citation rather than an enforcement, which is the honest limit: a title can
claim anything. The mutation discipline is what makes a citation worth
something, and this is what stops a MUST from being filed into a category
nobody reads.

`C029` remains the open one. It mutates `packages/protocol/src/envelope.ts` —
a primitive rather than an endpoint — so its recorded mutation is caught by
this repository's tests and would not be caught by a third-party target
running the kit against their own server. That is the shape this file
condemns elsewhere, recorded here rather than quietly left.

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

**The guard deliberately not written, and the day it was waiting for.**
`enqueue` returning an existing job needed a collision check for the day two
sites share a job id. It was left as a comment naming the condition, on the
grounds that this relay served one site so the branch could not be reached and
its test could not fail.

**That day came — cloud_009 §3 — and the answer was not the guard.** The relay
routes for every site its projection holds. `RelayState.#jobs` is keyed by the
pair, `enqueue` is idempotent by `(site, id)`, and `store-contract.ts` carries
the case — _"gives two sites the same id without either seeing the other"_ —
which both implementations run, the in-memory one and the Valkey one behind
`REQUIRE_VALKEY=1`. `enqueue`'s own comment records the move: _"The refusal
that used to live here went with the collision it refused."_ There is no
unreachable branch left here and nothing to add.

Kept rather than deleted, because the reasoning was wrong in a way worth
seeing. It deferred a test on the grounds that a branch could not be reached,
and what made the branch safe in the end was **a key, not a check**. Worse is
how it reads once the premise moves: a note saying a guard is deliberately
absent is read as _collisions are impossible_, and it gives the reason —
one site. Had the multi-tenant router landed without pair-keying, this
paragraph would have said exactly the same thing and been the opposite of
true. A deferral has to name the condition that revives it in a form somebody
trips over, not in prose nobody re-reads.

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

## The second implementation nobody certified (2026-08-17)

Moving `claim`, `takePayload`, `complete`, `seal` and `releaseLeases` out of
the relay's planes and into its store changed no behaviour — every test stayed
green. A mutation run over the moved code killed three of eight.

The five survivors had never been tested **in either location**. Moving them
did not weaken anything; it made a gap visible that had been there since the
relay was written. Four of the five are protocol MUSTs:

| guard                               | MUST                          |
| ----------------------------------- | ----------------------------- |
| `claim` respects the owners set     | `AUDIENCE_BOTH_SIDES`         |
| `takePayload` checks the lease id   | `LEASE_HONORED`               |
| `complete` is a no-op when done     | `RESULT_IDEMPOTENT`           |
| `releaseLeases` checks the lease id | `LEASE_HONORED`, per instance |

### Why the kit did not catch them

**The conformance kit certifies a _target_, and its target has always been
`@byollm/server`.** The relay is a second implementation of the same daemon
plane — a different upstream that daemons claim, fetch, report and heartbeat
against — and it has never been run through the kit.

So `C015_LEASE_HONORED` is green, and has always been green, about the server.
The relay's own `LEASE_HONORED` was enforced by a line of code with nothing
behind it. Reverting that line kept every suite passing, including the one
whose name says it covers the MUST.

This is the week's recurring class again, at the level of a whole suite rather
than one check: **the kit reports a MUST as covered for a reason unrelated to
the implementation you are actually shipping.** Coverage is counted per MUST,
and a MUST can have more than one implementation.

### What was done, and what was not

Seven guards now have tests in `packages/relay/test/store-operations.test.ts`,
each mutation-verified. That is the floor, not the answer.

**The answer is to run the kit against the relay**, which it is shaped to
allow — a `ConformanceTarget` is a `fetch` plus setup hooks, and the relay has
both. It is not done here because the relay's setup half differs (a site seals
through the site plane rather than answering `fetch` itself), and inventing
that adapter at the end of a refactor is how a target gets written to pass
rather than to test. Filed as work, not attempted as a footnote.

### The question this suggests

For any MUST the registry counts as covered: **how many implementations of it
do we ship, and how many does the kit run against?** If those numbers differ,
the count is measuring one of them and reporting all.

## The green that was about a different build (2026-08-17)

A two-line consumer update, four attempts, and **every failed attempt reported
success**. Worth recording as a set, because no single step is surprising and
the sequence is the thing.

1. `pnpm install` failed — a script had versioned every devDependency,
   including `@types/pg`, so npm had no matching version. Its output was
   redirected, so nothing said so.
2. `tsc` then passed and **11 of 11 tests passed** — against a dependency
   three versions stale and still synchronous. Entirely self-consistent, and
   about software nobody was shipping.
3. After fixing the install, `tsc` _still_ passed. A cached `.tsbuildinfo` was
   answering about the previous build.
4. `rm -rf .tsbuild` surfaced the real error: production code destructuring a
   Promise. `const { requeued } = relay.sweep()` yields `undefined`, and
   `requeued.length` throws — inside a `setInterval`, on a timer nobody
   watches.

### Two rules

**A build cache makes "typecheck passes" a claim about the last build, not
this one.** Incremental compilation is a performance feature that quietly
converts a verification into a memory of a verification. When a dependency
changes underneath, the memory is the wrong answer and is indistinguishable
from the right one.

**`await` on a synchronous value is invisible.** `await 5` is legal in both
TypeScript and JavaScript, so a half-finished sync→async migration typechecks
and passes every behavioural test — the behaviour is identical either way.
This bit twice in one day: once making `RelayState` async, where two separate
attempts left methods unconverted and stayed green, and once here.
`@typescript-eslint/await-thenable` is the only thing in the toolchain that
sees it.

### What actually worked, both times

Reading the artefact rather than the report:

```sh
node -p "require('./node_modules/@byollm/relay/package.json').version"
grep -nE "^  \w+\(" src/state.ts | grep -v "Promise<"
```

A version out of `node_modules`, and a grep for a method whose return type is
not a `Promise`. Neither consults a tool that might be remembering.

Same move as `scripts/release-check.mjs` asking npm instead of watching the
Release workflow, and as the deployment posture audit requiring a refusal to
be _byollm's_ rather than any 404. **Verify the artifact, not the process** is
now the third distinct place this rule has paid for itself, which is enough to
call it a rule rather than an anecdote.

---

## An outcome test that passed against the wrong sequence — cloud_008 §0.6

The relay never renewed a lease. Its heartbeat returned the literal
`leases: []`, so any job slower than `leaseMs` was swept out from under the
device running it. The test written to prove the fix asserted the outcome:
one execution, a collected result, final state `done`.

**It passed against the unfixed relay.** All three assertions were true, via a
sequence that was wrong in every step between them:

| tick | state              | lease          |
| ---- | ------------------ | -------------- |
| 0    | `running`          | `1d37fa99`     |
| 1    | `awaiting-payload` | **`e6f285b0`** |
| …    | `awaiting-payload` | `e6f285b0`     |
| 7    | `done`             | `e6f285b0`     |

The lease lapsed, the sweep requeued the job, the daemon re-claimed it under a
new grant, and the original run — still going — posted its result at the end
and was accepted. One execution because the requeued copy never got a payload;
`done` because the old holder's write landed anyway.

**Renewal is a property of a job's whole life, so end-state assertions cannot
see it.** The fix was to sample: collect every lease id observed while the job
runs and assert there was exactly one, and assert the recorded expiry moves
forward. A second lease id means the grant was taken away and given back,
however the job happens to end.

This is the fourth instance of _a check that is green for a reason unrelated
to the property it names_, and the first where the wrong sequence produced a
**right** answer rather than a vacuous one — which is worse, because there is
nothing suspicious to notice.

### Two findings the mutation trace produced on its own

- **`complete` does not check the lease id.** `takePayload` and
  `releaseLeases` both do, each citing `LEASE_HONORED` per instance;
  `complete`, the operation that writes the result, checks only `runnerId`.
  That is how the old holder's result landed above. `ResultRequest` carries no
  `leaseId` on either plane, so closing it is a wire change — recorded as
  cloud_008 finding 15, Tier 1.
- **`HeartbeatResponse.leases` is read by nobody.** A mutation returning
  `leases: []` while renewing the store correctly _survives_, and honestly: the
  daemon acts on `lost` and ignores `leases` entirely. Two answers to one
  question, one of them unread — the `audienceAllow` shape again. Recorded as
  finding 16, Tier 1: the daemon should act on it or it comes off the wire.

---

## A `[LEASE_HONORED]` test that could not tell the two rules apart — §1.4a

Making `result` name its lease came with a mutation check: revert the direct
plane to `holder: { by: "runner" }` and see what fails. **Nothing did**, past a
test whose name is `refuses a result from a runner that no longer holds the
lease [LEASE_HONORED]`.

It sweeps an expired lease and then posts a result. After a sweep the job has
no holder at all, so "match the runner" and "match the lease" both refuse — the
test passes identically under either rule, and cites a MUST it cannot observe.
The relay's own store test had the same gap for the same operation, while
`takePayload` and `releaseLeases` were both covered.

The distinguishing case is a **re-claim by the same runner**: the id still
matches and only the grant has changed. It is not hypothetical — it is the
exact sequence the §0.6 mutation trace produced, and it is the sequence under
which a result was accepted for a job its sender no longer held.

Both planes now have it, and both mutants die.

**The rule this suggests:** when a test cites a MUST, ask what _other_ rule
would also make it pass. If the answer is "the rule we are replacing", the test
is about the outcome and not about the MUST — and it will keep passing through
the regression it was written to catch. Finding 42 in cloud_008 names the same
shape in the conformance kit (`C004`/`C001` counting MUSTs they never exercise);
this is the same audit applied one layer down.

## An assertion that renders blank rather than red (2026-08-21)

`web_002 §2` added a per-tier domain allowance where **null means unlimited**.
The test asserted it the obvious way:

```sql
select 'team does not lift the domain limit',
       public.dashboard_apex_allowance(team_group) = 1, …
```

Then a mutation made every tier unlimited. The allowance came back `null`,
`null = 1` is `null`, and the report printed:

```
 team does not lift the domain limit        |    | allowance unlimited
```

An empty cell. The runner counted it as a failure — `row.ok !== true` — so
the suite did go red, and that is the only reason anybody noticed. In a report
somebody skims, a blank sits between the ticks and reads as nothing at all.

**The rule: an assertion whose subject can be null must be written null-safe.**
`is not distinct from` rather than `=`. Three-valued logic turns a failing
check into an _absent_ one, and absence is the thing this file exists to
catch — it just usually arrives as a missing test rather than a colourless
one.

The neighbouring bug is worth recording with it, because they are the same
shape one layer apart. The allowance function itself read:

```sql
coalesce(entitled_allowance, free_allowance)
```

`null` means unlimited _and_ it means "no rows", so `coalesce` read a paying
group as a free one and Pro fell through to the Free limit. Four existing
fixtures failed with the Free refusal while holding `cloud.pro` — a check
catching a bug in the thing it checks, which is the happiest way for this to
go. Three explicit branches replaced it.

**Both are the same question:** what does this value mean when it is absent?
Answer it in the code and in the assertion, or the two will disagree exactly
once, in the direction of looking fine.

## Verified 2026-11-03 — byollm_012's daemon half and guard (b) (#7055)

byollm 0.1.5 card 3. These checks drive the **shipped daemon**, not the kit:
`packages/daemon/src/tools-at-the-site.test.ts` (a real `Runner`, a real
`ProtocolClient`, the real `openai-http` backend over loopback HTTP, an
upstream that plays the site with the site's keys and parses every request
and response with `@byollm/protocol`'s own schemas — Owl, #55956 point 1),
`tools-off-by-default.test.ts`, `tool-loop-reaches-nothing.test.ts`, the
hostile-site corpus in `packages/daemon/test/adversarial/hostile-site.test.ts`,
and C060 in `packages/conformance/test/guard-b-against-0.1.4.test.ts` against
`@byollm/server@0.1.4` **as published on npm**. Why the kit does not carry
the first set yet is in byollm_012 §12.

Each mutation was applied by script, the suite run, and the file restored;
"also fails" is what the same mutation failed when the whole check file ran,
not only its own case.

| Check                              | File                                     | Mutation                                                                                                                                                                                | Result                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C033 a call leaves sealed          | `daemon/src/runner.ts`                   | Send the call in the clear: replace the envelope's `ciphertext` with the call's JSON, base64url                                                                                         | ✓ bites. Also fails C034, C037, C038, C041, C042, C046 — every case that needs the site to answer a call, which a call nobody can open never gets. A chokepoint, not a broad mutation |
| C034 nothing runs on the device    | `daemon/src/tool-loop.ts`                | A helper that runs a declared tool locally: `spawn(asked.name)` before the send                                                                                                         | ✓ bites. Also fails `tool-loop-reaches-nothing` (the dynamic import), as intended: one watches the running daemon, the other the module that would have to change                     |
| `tool-loop-reaches-nothing`        | `daemon/src/tool-loop.ts`                | `import { spawn } from "node:child_process"`                                                                                                                                            | ✓ bites, alone                                                                                                                                                                        |
| C035 tools match consent           | `daemon/src/runner.ts`                   | Skip the digest compare: pass `toolsDigest: undefined` to `toolsConsentRefusal`                                                                                                         | ✓ bites: cases 1–3 fail; case 4 (`maxToolCalls` above its limits) still refused, because that compare is separate — as it should be                                                   |
| C035                               | `protocol/src/tools.ts`                  | Leave the limits out of the digest: `canonicalJson({ tools })`                                                                                                                          | ✓ bites: case 3 (limits raised from 8 to 20) fails, alone                                                                                                                             |
| C036 undeclared or ill-typed calls | `daemon/src/tool-loop.ts`                | Let unknown names through: `checkCall` returns `null` for an undeclared name                                                                                                            | ✓ bites, alone                                                                                                                                                                        |
| C037 a result is bound to its call | `daemon/src/tool-loop.ts`                | Drop the callId check: both the label's and the sealed result's `callId`/`seq` compare                                                                                                  | ✓ bites, alone                                                                                                                                                                        |
| C038 the daemon's budget           | `daemon/src/tool-loop.ts`                | Count after sending: `calls >= budget` → `calls > budget` at the one check (at the charge)                                                                                              | ✓ bites: all three C038 cases                                                                                                                                                         |
| C038                               | `daemon/src/tool-loop.ts`                | Delete the check at the charge                                                                                                                                                          | ✓ bites: all three C038 cases                                                                                                                                                         |
| C038                               | `daemon/src/tool-loop.ts`                | The check back where it was, after the switch, where a refusal's `continue` skips it                                                                                                    | ✓ bites: the refused-last-call case, alone                                                                                                                                            |
| C038                               | `daemon/src/tool-loop.ts`                | A check before each call only (Owl's #55998 survivor: the post-call check removed)                                                                                                      | ✓ bites: both spent-on-the-last-call cases                                                                                                                                            |
| C041 a site that does not answer   | `daemon/src/tool-loop.ts`                | Three, all verified: resolve the wait only at the deadline; count a timeout as answered; and (`runner.ts`) stop renewing the lease while waiting — `#active.delete` at the loop's start | ✓ bites (all three), alone                                                                                                                                                            |
| C042 calls logged first            | `daemon/src/tool-loop.ts`                | Log after sending: the `tool-call` line moved after `transport.send`                                                                                                                    | ✓ bites, alone                                                                                                                                                                        |
| C043 other kinds unchanged         | `daemon/src/backends/openai-http.ts`     | Send declarations on every request: `execute` adds a `tools` array                                                                                                                      | ✓ bites, alone                                                                                                                                                                        |
| C043                               | `daemon/src/backends/openai-http.ts`     | Read calls on every kind: `execute` passes `{ readsCalls: true }`                                                                                                                       | ✓ bites: `execute-ignores-tool-calls`, the execute case, alone                                                                                                                        |
| C044 off by default                | `daemon/src/config.ts`                   | Default it on: every HTTP service gains `llm.tools` in `resolveConfig`                                                                                                                  | ✓ bites: both C044 cases                                                                                                                                                              |
| C046 the context cap               | `daemon/src/tool-loop.ts`                | Hand every result to the model: the cap compare replaced by `false`                                                                                                                     | ✓ bites, alone                                                                                                                                                                        |
| C046                               | `protocol/src/kinds.ts`                  | Size the job by its prompt alone: `payloadTextLength` drops `maxToolResultChars`                                                                                                        | ✓ bites: the sizing case, alone                                                                                                                                                       |
| C060 guard (b)                     | `daemon/src/runner.ts`                   | Re-send unchanged: the retry carries the same capabilities                                                                                                                              | ✓ bites: both cases (the second asserts the retry dropped the new kind)                                                                                                               |
| C060                               | `daemon/src/runner.ts`                   | Blame the version when the retry is refused too                                                                                                                                         | ✓ bites: the malformed-heartbeat case, alone                                                                                                                                          |
| C060                               | `daemon/src/runner.ts`                   | Decide from capabilities alone: the withheld entries left out of `newer`                                                                                                                | ✓ bites: the withheld-only case, alone (the first heartbeat's 400 is thrown and llm.chat goes dark — Owl's reproduction, #55998 fix 1)                                                |
| hostile-site corpus                | `daemon/src/tool-loop.ts`                | Hand a site's result to the model as a `user` turn instead of a tool turn                                                                                                               | ✓ bites: all four `RESULT_*` rows                                                                                                                                                     |
| `pending-musts-hold-the-cut`       | `scripts/pending-musts-hold-the-cut.mjs` | Ignore `planned`: `owing = []`                                                                                                                                                          | ✓ bites: the two planned-check cases                                                                                                                                                  |

### C038: a budget checked in two places passed a mutation of one

The first run of "count after sending" — the pre-call check made `>` — left
C038 green. The loop checks the budget twice: before each call (the call that
would exceed it is not made), and after each call (so a turn that spent the
last call goes straight to the closing turn instead of asking the model once
more with tools offered). The test's model asked for one call a turn, so the
second check stopped it every time and the first was never reached.

Strengthened by having the model ask for **two calls a turn**, so the third
and fourth arrive together and only the pre-call check stands between the
fourth and the site. The mutation now changes both comparisons, which is what
"count after sending" means for this loop.

That note went on to say a mutation of either check alone "is still caught
by the other". It was not true (Owl, #55998): the post-call check removed
outright passed every tool and hostile suite, and the mutant is not
equivalent — when a turn's LAST call spends the budget, nothing is left in
the turn for the pre-call check to stop, so the model is asked once more with
tools offered, an extra turn charged to the daily budgets, before the closing
turn. Checking that answer turned up two more things: the pre-call check
mutated alone (`>`, or replaced by `false`) also passed every suite, because
the post-call check had always set the limit first; and the one path where
the pre-call check did matter — a refusal, whose `continue` skipped the
post-call check — had the same extra-turn bug when the refused call was the
turn's last.

So the two checks are now one, at the charge (`calls += 1`, then
`calls >= budget` sets the limit), which no path out of the iteration can
skip; every later call in the turn finds the limit set and is answered "not
run". Two cases were added: the budget spent by a turn's last call when it is
sent, and when it is refused; each asserts the very next request offers no
tools. The four mutations above — `>`, deleted, moved back after the switch,
and a check before each call only — each fail, and the table says which
cases.

### What C060 runs against

`byollm-server-0.1.4` and `byollm-protocol-0.1.4` are npm aliases of the
published packages, in `@byollm/conformance`'s devDependencies, so a server we
wrote this week cannot stand in for the one in the field (Owl, #55956 point
2). The test observes the precondition rather than assuming it: the published
server refuses the first heartbeat, the one that advertised `llm.tools`, with
a 400. It also derives the guard's list of newer kinds from the published
0.1.4 `JOB_KINDS`, so the list cannot drift from what a 0.1.4 upstream
actually refuses.

## Verified 2026-11-03 — the tool endpoints' upstream halves (#6933 card 2, #7054)

byollm_012 §12's C037, C039, C041 and C042, as far as an upstream holds them.
Each was run against its mutation, seen to fail, and reverted; the relay and
server mutations were run with `npx vitest run <file>`, the kit's with the
kit's own test file.

| Check                                     | File                                  | Mutation                                                                                                                                                                                               | Result                                                              |
| ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| C037 a result bound to its call (relay)   | `packages/relay/src/state.ts`         | Drop `row.callId === input.callId` from `answerToolCall`'s lookup, leaving the lease match                                                                                                             | ✓ bites — only "refuses an unknown call id, and another job's call" |
| C037 a result bound to its call (server)  | `packages/server/src/memory.ts`       | Drop `row.callId === callId` from `#currentCall`, leaving the lease match                                                                                                                              | ✓ bites — only its twin in `tool-calls.test.ts`                     |
| C039 the relay's budget                   | `packages/relay/src/state.ts`         | Drop the count: `if ((job.toolCallsMade ?? 0) >= limit) return { refused: "budget" }` in `recordToolCall`                                                                                              | ✓ bites — the three C039 cases, and the replay case                 |
| C041 a site that does not answer (relay)  | `packages/relay/src/state.ts`         | Two, both verified: stop renewing a lease whose job has an unanswered call (`renewLeases`); and drop `call.expiresAt <= now` from `answerToolCall` and `toolCalls`, so only the deadline ends the wait | ✓ bites (both)                                                      |
| C041 a site that does not answer (server) | `packages/server/src/memory.ts`       | Two, both verified: the same two, in `renewLeases` and in `outstandingToolCalls` / `answerToolCall`                                                                                                    | ✓ bites (both)                                                      |
| Rows deleted with their job (server)      | `packages/server/src/memory.ts`       | Drop `if (TERMINAL.has(record.state)) this.#toolCalls.delete(jobId)` from `#write`                                                                                                                     | ✓ bites — "deletes a job's calls with the job", via `heldToolCalls` |
| Rows deleted with their job (relay)       | `packages/relay/src/state.ts`         | Drop `delete job.toolCalls` from `complete`                                                                                                                                                            | ✓ bites — "leaves nothing to land on once job A has ended"          |
| Rows deleted with their grant (relay)     | `packages/relay/src/state.ts`         | Drop `delete job.toolCalls` from the requeue path (beside `delete job.payload`)                                                                                                                        | ✓ bites — "…once A's grant has ended, even if A runs again"         |
| C042 calls logged first (upstream half)   | `packages/conformance/src/harness.ts` | In `observeArrivals`, forward the request to the target before awaiting `observe`                                                                                                                      | ✓ bites — the ordering case and the refusal case                    |

**Halves, and named as halves.** None of the four is a whole check yet, and
the MUSTs they serve stay `pending`. C037's MUST is the daemon's
(`TOOL_ENVELOPES_BOUND`): the relay is blind, so it cannot see a direction
or a job id inside a signature, and the `payload`-direction case is carried
through and refused only where the envelope is opened — the relay file shows
that, with a real envelope, as its last step. C041's third mutation ("count
a timeout as answered") is `toolOutcomes`, which the daemon writes. C042's
ingress line is the daemon's to write; what is proved here is that the kit
can stand at the upstream's door at the instant a call arrives, which is the
only moment the check can tell "logged before sending" from "after". Card 3
builds the daemon halves and promotes the MUSTs.

**C039 is whole, and lives in the relay's suite rather than the kit's.** The
kit certifies a direct server, which has no relay; on the direct lane the
budget is the site SDK's (C040, card 4). So C039 sits where the relay's
device gate does, for the same reason (above, 2026-08-16). `TOOLS_BUDGETED`
lists it as planned `conformance`; whoever promotes that MUST should read
this paragraph first.

**Unreachable is not deleted.** Every read of a call row filters on the
job's current grant, so a finished job's rows are out of reach whether or not
they were deleted. The first build's "deleted with its job" case asserted only
the reach, and the server's delete survived it (Owl, #55977); the relay's
requeue-time delete survived the same way. Signals runs `MemoryStore` and
never deletes a job, so kept rows were memory held until restart. Both suites
now count the rows the store holds (`MemoryStore.heldToolCalls`, the relay's
`RelayState.job(...).toolCalls`), and the three deletes above bite.

**The replay case also fails under the C039 mutation**, and should: it shows
a replayed call is not counted twice by leaning on the count. A shared
chokepoint, not a broad mutation.

The Supabase adapter's SQL (`20261103230000_tool_calls.sql`) was exercised
by hand against the local stack inside a transaction that rolled back: every
refusal in the contract, the timeout, a requeue's calls out of reach but
counted, deletion at `ok`, and `anon` unable to execute. It has no automated
run in `verify`, as the rest of the adapter has none.

## Verified 2026-11-03 — the site SDK's tool work (#6933 card 4, #7056)

byollm_012 §12's C040 whole, and the site SDK's halves of C046 and C047,
with this card's red-team case beside them. Each was run against its
mutation, seen to fail, and reverted. The server mutations were run with
`pnpm exec vitest run packages/server/src/site-tools.test.ts`; the relay
ones with `pnpm exec vitest run packages/relay/test/site-sdk-tools.test.ts`,
after `pnpm run build`, because the relay's suite imports `@byollm/server`
from its build.

| Check                               | File                                | Mutation                                                                                                | Result                                                                 |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C040 the site SDK's budget          | `packages/server/src/site-tools.ts` | Drop the SDK's count: let a `budget` refusal from `chargeToolCall` fall through to the handler          | ✓ bites — both C040 cases                                              |
| C040, across processes              | `packages/server/src/site-tools.ts` | Count in a `Map` on the `SiteTools` instance instead of in the store                                    | ✓ bites — only "keeps the count across pump cycles in fresh processes" |
| Red-team: another purpose's handler | `packages/server/src/site-tools.ts` | Drop the check that the call names a tool the job's own payload declares                                | ✓ bites — only "never runs another purpose's handler for this job"     |
| Arguments before the handler        | `packages/server/src/site-tools.ts` | Drop the `toolArgumentsRefusal` check                                                                   | ✓ bites — only "refuses arguments the declaration does not admit"      |
| C047 SDK half: the digest           | `packages/server/src/app.ts`        | Digest over the job's budget instead of the purpose's limits                                            | ✓ bites — "sends the digest of exactly what it declares"               |
| C047 SDK half: beside the stub      | `packages/server/src/cloud.ts`      | Send no `tools` beside the stub                                                                         | ✓ bites — the relay refuses every `llm.tools` enqueue; four cases fail |
| C047 SDK half: the refusal          | `packages/server/src/cloud.ts`      | Read the hub's mismatch sentence as `RelayUnavailable`, not `EnqueueRefused("tools-manifest-mismatch")` | ✓ bites — only "is refused as tools-manifest-mismatch"                 |
| C047 relay: the verdict             | `packages/relay/src/site-plane.ts`  | Ignore a `tools-mismatch` verdict, so the job is queued                                                 | ✓ bites — only "is refused as tools-manifest-mismatch"                 |
| C046 SDK half                       | `packages/server/src/app.ts`        | Size an `llm.tools` job as `llm.chat`, by its prompt alone                                              | ✓ bites — only "classes the job by its prompt plus maxToolResultChars" |
| 404 on `calls` (021 R2)             | `packages/server/src/cloud.ts`      | Drop the 404 reading, so `calls` 404 fails the cycle                                                    | ✓ bites — only "reads 404 on calls as no tools"                        |

**C040 is whole and lives in the server's suite, not the kit's.** The brief's
"the kit posts maxToolCalls + 1 valid sealed calls on the direct lane" is
played by the server harness's signer, which signs the way a daemon does.
The kit certifies a daemon-facing server and has no handle on a site's
handlers, and the site's count is what is under test. `TOOLS_BUDGETED` stays
`pending`: C038 is the daemon's (card 3), and C046's daemon half is too.
`TOOLS_MATCH_CONSENT` stays `pending` for the same reason (C035 and C036 are
the daemon's), and C047's hub half is byollm-cloud's `satisfiable` (card 9),
which the relay now gives a verdict for: `tools-mismatch`.

**The count is durable.** `chargeToolCall` is a store method because a
serverless site runs each pump cycle in a fresh process. The second C040 case
pumps from a second `ByollmApp` over the same store, and the in-memory
mutation shows it is the case that tells the two apart.

The Supabase SQL (`20261104010000_tool_charges.sql`) was exercised against
the local stack with `packages/server/supabase/probes/tool-charges.sql`,
inside a transaction that rolled back. It covered a charge counted once, the
budget, a re-run of a charged call, an unknown job and a closed job, charges
deleted at `canceled`, in-flight with a queued tool job and with only a chat
job, and `anon` unable to execute either function. Every line matched its
expectation. The adapter's TypeScript calling it has no automated run in
`verify`, as the rest of the adapter has none.

## Verified 2026-11-04 — images by reference (byollm_021 §10, #7057)

Card 5's checks, numbered as byollm_021 §10 numbers them after #7053's
renumbering. The brief named them by the ids first proposed (C057, C062,
C063, C069 and C071 are C048, C053, C054, C057 and C059 here). Each mutation was
applied to the named file, the package rebuilt, and the whole kit run
against the reference server. Every one of them was reverted afterwards.

| check                                 | mutated                           | mutation                                                                         | result                                  |
| ------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `C048_BLOBS_SEALED`                   | `packages/server/src/app.ts`      | Upload the plaintext, zero-padded to the slot's size, in place of the ciphertext | ✓ bites ("holds plaintext image bytes") |
| `C048_BLOBS_SEALED`                   | `packages/server/src/handlers.ts` | Store an output reference's key as it arrived (`wrappedKey: key`)                | ✓ bites; also C054, C059 (see below)    |
| `C053_BLOB_NEEDS_THE_LEASE`           | `packages/server/src/handlers.ts` | Drop the runner and lease-id comparison from `#held`                             | ✓ bites, alone                          |
| `C054_BLOBS_GO_WITH_THE_JOB`          | `packages/server/src/app.ts`      | Skip the sweep: delete `deleteBlob({ due })` from `sweep()`                      | ✓ bites                                 |
| `C054_BLOBS_GO_WITH_THE_JOB`          | `packages/server/src/handlers.ts` | Keep input blobs after the result is accepted                                    | ✓ bites                                 |
| `C057_BLOB_SIZE_CHECKED_BEFORE_OFFER` | `packages/server/src/blobs.ts`    | Trust the slot: drop `blob.data.length !== blob.slotBytes` from `blobFault`      | ✓ bites, alone                          |
| `C059_OUTPUT_OUTLIVES_COLLECTION`     | `packages/server/src/app.ts`      | Delete output blobs at collection (`notAfter: now` in `result()`)                | ✓ bites; also C048, C054 (see below)    |

**The overlaps are shared paths, not broad mutations.** C048, C054 and C059
all collect an `llm.image` result and then read its images. So deleting
outputs at collection fails all three, and that is the chokepoint working as
intended. A key stored unwrapped fails C054 and C059 too, because
`images()` unwraps whatever is stored, and an unwrapped key unwrapped again
opens nothing.

**C057 was rewritten so that its mutation can bite.** The first draft
referenced the oversized blob honestly, declaring its true 300 KB. Its
slot-versus-reference comparison then refused the job, and "trust the slot"
passed. The reference now declares what the slot was issued for, so the
stored size is the only thing wrong, and only reading the stored size
refuses it.

**C048 searches before it opens.** It searches the store first and only then
runs its controls (the device opens its input, the site opens its output). A
plaintext upload is therefore reported as plaintext, not as "the device
could not open its input".

**What the real-clock targets do not exercise.** C054's day-after-deadline
sweep and C059's hour-after-collection deletion wait only on a target that
can move its clock (`advanceTime`). A real-clock target is held to the
recorded deletion time instead, `deleteAt` measured from the blob's own
creation, so the sweep mutation bites only on the reference server. The
Supabase adapter passed all 37 checks against a fresh local stack with
Storage enabled.

**Not kit checks, and why.** byollm_021 §10's C049 ("refused before the
backend"), C050 ("backend saw nothing") and C052 ("download stops at 2 MiB")
are the device's end, and they need a daemon that serves an image kind. That
is card 6 (#7058), so `BLOB_BOUND_TO_JOB` and `MEDIA_VERIFIED` stay
`pending`, and `BLOB_BUDGET_BEFORE_DOWNLOAD` keeps C051 and C052 `planned`.
The site's end of all three is in `packages/server/src/blobs.test.ts`. It
covers a swapped job, `in` passed as `out`, a flipped byte, a JPEG declared
as PNG, an over-cap header, and an object larger than declared, each refused
before the app sees a byte. It does not claim those MUSTs, because half a
MUST is not a covered MUST.

## Verified 2026-11-04 — byollm_021's daemon half: images (#7058)

byollm 0.1.5 card 6. Like card 3's, these drive the **shipped daemon**, not
the kit: `packages/daemon/src/images.test.ts` (a real `Runner` and
`ProtocolClient`, payloads sealed with the site's keys, input blobs made
with the protocol's own `encryptBlob` — the site's encoder, not a copy — an
upstream that counts every `blob-url` call and blob GET, and a backend
double), `served-kinds.test.ts`, and the http-class adversarial corpus
(`packages/daemon/test/adversarial/http-class.test.ts`) for C055 and C056
against the real `openai-http` adapter over loopback. C056 is the corpus row
§10 left for this card to choose.

Each mutation was applied by script, the named files run, and the file
restored.

| Check                               | File                                 | Mutation                                                                                     | Result                                                                    |
| ----------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| C051 budget before download         | `daemon/src/images.ts`               | Never charge: `imageBudgetRefusal` admits every declared sum                                 | ✓ bites: the 3 × 10 MiB case, alone                                       |
| C051                                | `daemon/src/runner.ts`               | Charge after downloading: the gate before `runJob` skipped, so the job reaches its downloads | ✓ bites: the 3 × 10 MiB case (a `blob-url` call is made), alone           |
| C052 a blob larger than declared    | `daemon/src/client.ts`               | Trust the declaration: read the whole body, then compare its length                          | ✓ bites: "stops the download at the declared size", alone — 12 MiB pulled |
| C052                                | `daemon/src/images.ts`               | Ask the store for 64 MiB instead of `blobObjectBytes(ref.bytes)`                             | ✓ bites: the end-to-end vision case, alone                                |
| C055 vision is detected             | `daemon/src/images.ts`               | Probe for a 200 only: pass on any answer                                                     | ✓ bites: the "blue" case in `images.test.ts` and in the http-class corpus |
| C056 image bytes, not URLs          | `daemon/src/backends/openai-http.ts` | Follow the URL: fetch it before returning the error                                          | ✓ bites: both URL cases (the fetch reaches the corpus's server)           |
| C058 no images on a process backend | `daemon/src/config.ts`               | Advertise it: `httpOnlyKind` never objects                                                   | ✓ bites: all four config cases and both runner cases                      |

### What C052's end-to-end case does not prove

The runner-level C052 case (one real image stored with 12 MiB appended) is
refused whichever of the two C052 mutations is applied: `decryptBlob`
refuses any object that is not exactly the declared size, so the job fails
either way. That case proves the job is refused and the model sees nothing.
**That the download stops is proved only by the client-level cases**, which
stream from a counting `ReadableStream` and assert at most the declared size
plus one 64 KiB chunk was pulled. The fake upstream in the runner harness
answers with a whole `Response`, and nothing there counts bytes.

### Live probe

`probeVision` and the real `openai-http` adapter against Ollama on the
building machine, 2026-11-04: `gemma3:4b` answered "red" and passed (1.3 s);
`glm-5.2:cloud` answered "unknown" and was refused with "sent an image, the
model answered \"unknown\" — it is not reading images". The image probe was
not run live: nothing on that machine serves `/v1/images/generations`.
