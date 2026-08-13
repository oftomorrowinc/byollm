# byollm_011 — Conformance completeness, and what kind of thing a MUST is

**Status: proposed 2026-08-13.**

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

## Done when

`CLAIM_ATOMIC` and `PAIR_CODE_EXPIRES` have checks;
`CAPABILITY_IS_DETECTED` and `KIND_NO_CODE` are reclassified and
covered; every MUST carries a verification kind; `uncoveredMusts()`
counts only `conformance`-kind gaps and reports zero;
`formatReport` distinguishes "verified elsewhere" from "unverified";
and the mutation list exists for every check the kit ships.
