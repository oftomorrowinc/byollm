# byollm_011 — Conformance completeness, and what kind of thing a MUST is

**Status: implemented 2026-08-13**, except the §4 exclusion (MUSTs that
byollm_009 introduces) and the backlog of mutation verification for
`C001`–`C016`, tracked in `packages/conformance/MUTATIONS.md`.

Ten of thirty-two MUSTs have no conformance check. The kit reports
them honestly on every run — `uncoveredMusts()` exists precisely so a
gap shows up rather than hides — and that honesty has been doing the
work of a plan for long enough.

This matters more than it did last week. The conformance kit is about
to become the thing that certifies a hosted hub as byollm-compatible:
same public suite, no private dialect. A kit with ten uncovered MUSTs
certifies less than it appears to, and the gap is invisible to anyone
reading "it passes conformance" rather than the run output.

## 1. The ten, sorted by why they are uncovered

Not one list. Three, and they need different answers.

**(a) Server-side, coverable today, simply not written**

- `PAIR_CODE_EXPIRES` — an expired code must not pair.
- `CLAIM_ATOMIC` — two runners racing one job; exactly one wins.

These are ordinary omissions. `CLAIM_ATOMIC` in particular is the one
that would actually catch a bad store adapter: a Postgres
implementation without `FOR UPDATE SKIP LOCKED`, or a memory store
with an `await` in the wrong place, passes every other check in the
kit and double-runs jobs under load. It is the single highest-value
missing check and it should be written first.

**(b) Daemon-side, structurally outside a server-facing kit**

- `NO_SHELL_INTERPOLATION`, `STRIPPED_CHILD_ENV`, `OUTPUT_INERT`,
  `HTTP_BASE_URL_SAFE`, `NO_PAYLOAD_ROUTING`, `CAPABILITY_IS_DETECTED`,
  `KIND_NO_CODE`, `COMMUNITY_BUDGETS`.

The kit certifies *a server*. These are properties of a *daemon*, and
the daemon under test in the harness is our own. Asserting them
against ourselves in the kit would prove nothing about anyone else's
server and would duplicate the adversarial suite, which already tests
them properly — by spawning a real probe and reading back the argv,
environment, cwd and stdin the child actually received.

So the honest answer for most of (b) is **not "write the check" but
"say where it is enforced."** A MUST can be verified by the
adversarial suite, by construction, or by conformance; what it cannot
be is unverified and unlabelled. The registry should carry that, and
`formatReport` should print "verified elsewhere" distinctly from
"nobody checks this".

Two in (b) are misfiled and should move to (a):
`CAPABILITY_IS_DETECTED` and `KIND_NO_CODE` have server-observable
consequences — a runner that advertises what it cannot run, and a
server that accepts an unregistered kind — and both are testable
across the wire.

**(c) The interesting one**

`COMMUNITY_BUDGETS` is enforced daemon-side but is a *protocol*
promise about how much of a stranger's work a machine will absorb. It
sits exactly where the hub will need it, since routed jobs extend the
same budget machinery. Worth deciding deliberately rather than
inheriting.

## 2. The thing to settle before byollm_009 lands

The connection-protocol spec will introduce MUSTs of a kind the
registry has not held before. The clearest example:

> the relay cannot decrypt payloads, by key non-possession

That is a true and important property. It is also **not testable by a
conformance kit**, and no amount of cleverness makes it so. Key
non-possession is not observable over the wire: a relay that holds the
keys and declines to use them passes every check a relay that never
had them passes.

This is worth naming now, because the kit's credibility rests on an
implicit claim that every MUST is checkable, and the ten uncovered
ones have been quietly eroding it. Adding an *uncheckable* MUST
without saying so would erode it faster and in a way nobody notices —
"it passes conformance" would come to include claims conformance never
touched.

The proposal: MUSTs get an explicit **verification kind**.

| Kind | Meaning | Example |
|---|---|---|
| `conformance` | The kit asserts it against any implementation | `CLAIM_ATOMIC` |
| `adversarial` | Our suite proves it by observing a real child | `STRIPPED_CHILD_ENV` |
| `construction` | True by how the code is shaped; a reviewer verifies, a test cannot | fixed argv having no builder |
| `operator` | A claim about someone's deployment, verifiable only by audit or by source | relay key non-possession |

`uncoveredMusts()` then means "MUSTs of kind `conformance` with no
check", which is a number that should be zero, rather than today's
number, which needs a paragraph of explanation.

The `operator` row is the honest one and the point of the exercise. A
protocol may legitimately state a property its test kit cannot verify
— but it must be labelled, so that "byollm-compatible" never silently
covers a claim nobody can check from outside. If our own hosted layer
ever carries an `operator` MUST, this is the mechanism that stops the
public spec from laundering it into something it is not.

## 3. Coverage is not the same as strength

The two conformance checks written for byollm_007 were mutation-tested
before being believed: revert the rule, watch the check fail. Both
did. That habit should be the standard rather than a thing that
happened once — a check that passes against a broken implementation is
worse than a missing check, because it reports a gap as covered.

Cheapest durable version: a documented mutation list — for each check,
the one-line change to the reference server that must make it fail —
runnable on demand. Not in CI (mutating a package and rebuilding per
check is slow), but written down, so "does this check bite?" has an
answer that is not somebody's memory.

## 4. Not in scope

Coverage of MUSTs that byollm_009 introduces. Those land with that
spec and its own checks; this one is about the debt already on the
books and the taxonomy 009 will need to exist first.

## What landed, and one thing it caught

Four checks written and mutation-verified: `C019_CLAIM_ATOMIC`,
`C020_PAIR_CODE_EXPIRES`, `C021_CAPABILITY_IS_DETECTED`,
`C022_KIND_NO_CODE`. Every MUST carries a `verifiedBy` kind;
`uncoveredMusts()` counts only `conformance`-kind gaps and CI asserts
it is empty; `formatReport` lists what was verified elsewhere and says
plainly that this run did not assert it.

`C022` found a real gap on its first run: the server stored and
delivered payload keys the kind does not define — `command`, `argv`,
`model`, `baseUrl`. Nothing executed, because the daemon re-validates
against a strict schema and the argv is fixed. But the daemon parses a
whole claim response at once, so one malformed job would have failed
the batch it arrived in and stalled unrelated work. `enqueue` now
validates against `KindedPayload`, which puts the error where the app
can act on it.

The `miscoveredMusts()` guard — no check may claim a MUST conformance
cannot verify — caught its own author within minutes of existing:
`C022` listed `NO_PAYLOAD_ROUTING`, which it does not establish. It
proves the wire-shape half; the argv proof belongs to the adversarial
suite. The claim was dropped rather than the classification loosened.

## Done when

`CLAIM_ATOMIC` and `PAIR_CODE_EXPIRES` have checks;
`CAPABILITY_IS_DETECTED` and `KIND_NO_CODE` are reclassified and
covered; every MUST carries a verification kind; `uncoveredMusts()`
counts only `conformance`-kind gaps and reports zero;
`formatReport` distinguishes "verified elsewhere" from "unverified";
and the mutation list exists for every check the kit ships.

## What `operator` assumes (2026-08-17)

The taxonomy says `operator` means "a claim about how someone runs a
deployment, verifiable only by audit or by reading source". True, and
it carries an unstated premise: **an audit works by looking at
something once and knowing what it is**, which requires that something
to be stable and under the operator's control.

`SHARED_COMPUTE_DISCLOSED` is `operator`-kind because a consent
screen's wording is not wire-observable. In `byollm-cloud-web` that
wording was built from hidden form fields — chosen per request by
whoever submitted the form. An auditor would have read correct
language every time and been right about nothing.

**An `operator` MUST whose subject an adversary can vary is not
operator-verified; it is unverified.** No conformance check by
classification, no wire observation by construction, and no audit
because nothing stable exists to audit.

This does not change the taxonomy — the label did its job, which was
to stop anyone believing conformance covered it. It adds a question to
ask of every MUST carrying that label: *can a request change what an
auditor would be looking at?* It is a short list, and the only one
where a wrong answer has nothing behind it.

Recorded in full in `packages/conformance/MUTATIONS.md`.

## The surface the kit could not see (2026-08-17)

`certify` drives a real daemon against a `ConformanceTarget`, and the
target's `fetch` "may hand requests to an in-process handler or to a
real HTTP server. Both are certified the same way." That sentence is
correct about the protocol and wrong about everything else, and it
took eleven findings to see which.

**A harness that reaches the system under test by calling it directly
cannot test how the system is reached.** Authentication, transport
framing, header parsing, path routing, and the difference between a
caller who is authorised and one who merely knows a URL all live in
that gap. Eight freeze-gate findings ran against a relay object held
by reference. The site plane had no authentication at all, and nothing
noticed, because nothing in the suite was ever a stranger.

### `byollm-audit-deployment <url>`

A second command, and deliberately not a second target type. It takes
a URL and holds nothing else — no key the deployment knows, no
reference to anything inside it — because that is what an attacker
has. Seven checks, each asking a question that form of access makes
available:

| id | asks |
| --- | --- |
| `D001` | can I enqueue work into someone's machines? |
| `D002` | can I read who is online and what they hold? |
| `D003` | can I claim work? |
| `D004` | is a *well-formed* signature from an unknown key enough? |
| `D005` | is a debug surface served? |
| `D006` | can I reach a handler by dressing a path up to look like one? |
| `D007` | is this TLS, and is plaintext refused? |

`D004` is the one the others cannot make: verifying a signature and
identifying a signer are two steps, and the second is the one that
gets skipped. `D007` fails loudly on an `http://` origin rather than
passing quietly, because an audit that certifies posture over
plaintext has certified the thing that matters least.

### Why this is not a fifth `verifiedBy` kind

The obvious move is a `deployment` verification kind beside
`conformance`, `adversarial`, `construction` and `operator`. It was
not taken, for the reason `miscoveredMusts()` exists: a kind with no
MUST classified under it is a taxonomy entry that cannot be wrong.

The posture checks instead **cite** MUSTs they exercise, and cite
nothing where none applies. `REQUESTS_SIGNED_NOT_BEARER` is the same
MUST `certify` already asserts in-process; these check it at the
ingress, where an implementation can satisfy the first and fail the
second. "The debug page is not public" cites nothing, because it is a
deployment property of one relay and claiming a MUST for it would
launder a local decision as a protocol requirement.

If a MUST is ever written that *only* a deployment audit can verify,
the kind gets added then, with something in it.

### What it costs to be safe against production

Nothing writes, nothing floods, and every request is one an ordinary
scanner would make. That is a design constraint rather than a
coincidence: a posture audit somebody is nervous about running against
the live system is a posture audit nobody runs, and the live system is
the only place the answer is real.

### The suite must be able to fail

`packages/relay/test/deployment-posture.test.ts` runs the audit twice:
once against the reference relay served over HTTP, and once against a
server that answers 200 to everything — the relay as it stood before
`0.1.0-alpha.8`, reproduced. The second exists because a posture suite
that passes against everything is the assertion-that-cannot-fail in
its most dangerous form; it would have reported "posture good" against
the exact state it exists to catch.

The first run is also informative: the reference relay, served naked,
**fails two checks**. It is plain HTTP, and it serves its own debug
page. Both are right for a library and wrong for a deployment, and the
audit is where somebody running it finds that out.
