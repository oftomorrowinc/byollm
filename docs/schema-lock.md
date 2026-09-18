# What 0.1.0 locks, and what it does not

**Status: RULED (Todd, 2026-09-16). This is the promise.**

A version number is a promise about what will not move. This document says
exactly which surfaces are that promise, which are deliberately outside it,
and what makes the promise checkable rather than stated.

## The locked surfaces

Three wire surfaces, and they are locked because `@byollm/conformance` proves
them — a promise nothing verifies is a sentence, not a lock.

| Surface     | Where it is defined                    |
| ----------- | -------------------------------------- |
| **Envelope** | `@byollm/protocol` — `envelope.ts`, `envelope-format.ts`, `keys.ts` |
| **Pairing**  | `@byollm/protocol` — `PairStartRequest`, `PairStartResponse`, `PairPollRequest`, `PairPollResponse` |
| **Claim**    | `@byollm/protocol` — `ClaimRequest`, `ClaimResponse`, `ResultRequest`, `HeartbeatRequest`, and the job shapes they carry |

The proof is the 32 checks in `@byollm/conformance` (`C001`–`C032`). An
implementation that passes them speaks this protocol; one that does not, does
not. **If a change to a locked surface does not break at least one of those
checks, the check set is the thing that is wrong** — that is the tell that a
surface is locked in prose and not in fact.

## What "locked" means here, and the part that surprises people

Locked means: **a party running 0.1.0 can talk to a party running any later
0.1.x, in both directions, without either being upgraded first.**

That is stricter than "we will not remove fields", and the reason is in the
schemas themselves.

**Every wire shape is `.strict()`, so an unknown field is REFUSED, not
ignored.** Which means:

> **Adding an optional field is a breaking change** — on the side that has not
> upgraded.

The new sender emits it; the old receiver refuses the whole message. This is
the opposite of the usual "additive is safe" instinct, and it is the single
most important sentence in this document. It is deliberate: `strict-everywhere`
records what the alternative cost us — a `Lease.identity` our own fixtures had
been sending for months, silently dropped by a schema that never declared it,
with every test asserting against a wire that discarded it. A parser that
silently accepts malformed input is the thing this protocol refuses to be.

So inside 0.1.x, a locked surface takes **no new fields at all**, optional or
otherwise. A new field is a new version, and both ends move together.

**Say the consequence out loud, because it is the part worth deciding
knowingly:** every feature that needs a new field on a locked shape is
**0.2.0**, not a 0.1.x. Not "probably", not "unless it is small" — the
strictness above leaves no third option. That is a real constraint on how fast
the wire can grow, and it is the price of a lock that means anything. Agreeing
to the lock is agreeing to that.

## What is NOT locked, stated here rather than somewhere quieter

Carve-outs belong in the same document as the promise, or the promise reads
wider than it is.

- **The console protocol is EXPERIMENTAL.** `ConsoleFrame`, `consoleEnvelope`,
  `consoleOrder` and everything under `/console/*` on the hub may change shape
  in any 0.1.x. It is published so the pieces that consume it can pin a
  version, not because it has settled — nobody has run a console end to end
  yet, and a shape nobody has used is not a shape anybody should depend on.
- **`known-models` lists are fluid, by design.** The model namespace moves
  faster than our releases; that is B211's whole lesson. A list of model names
  shipping in a release is a snapshot, never a contract, and free text is
  always accepted where a model is named.
- **Refusal MESSAGES are not locked**, though refusal CODES are. The words
  change as we learn to say them better; the code a program branches on does
  not.
- **Everything in `@byollm/server`, `@byollm/relay` and `@byollm/daemon` that
  is not one of the three surfaces above.** Those are implementations. They
  hold to the wire, not to their own internals.

## Three shapes reserved before the lock closes — B236

A lock that takes no new fields is only bearable if the fields a known feature
will need are already there. These three were added **before** 0.1.0 for that
reason, and each one is a key nothing reads yet.

Reserving a shape is not the same as building the feature. The values are
validated; no code branches on them.

1. **`Purpose.routing`** — `@byollm/protocol`, `manifest.ts`. Optional, one of
   `user-choice | site-fixed | user-first-with-fallback`. The manifest is the
   one locked surface a third party writes **by hand**, and it is `.strict()`,
   so a key added later is refused by every validator built before it — on
   machines nobody can upgrade, running a server this repository publishes.
   The window for this field closed at 0.1.0 and it was used.

   A purpose that does not declare one means `user-choice`. That default lives
   in `routingOf()` and **not** in the schema: a zod `.default()` is applied at
   parse, so a hub that read a site's manifest and served it back would hand
   the key to readers that predate it — this reservation performing the break
   it exists to prevent.

2. **`~/.byollm/config.json` carries `version: 1`**, and one function writes
   the file. Not a wire surface, locked for the same reason: it is precious,
   it is the owner's, and a shape with no version is a shape you can only
   migrate by guessing from its contents. Absent means 1, permanently.

3. **The multi-version wire is the operating model, not lockstep.**
   `PROTOCOL_VERSION`, `SUPPORTED_PROTOCOL_VERSIONS` and refusals that name
   the versions they accept already exist in `wire.ts` — lockstep is an alpha
   habit that outlived its mechanism. **Protocol 1's wire is STABLE at 0.1.0.**
   Additions ship as version 2 served *alongside* version 1, routed by the
   version the daemon declares. A field added for a later feature therefore
   never breaks an old daemon; it simply does not reach one.

   This is what makes the previous section's price payable. "Every new field is
   a new version" is a constraint on the wire, not on the roadmap, because two
   versions can be served at once.

## The stability promise

**Locked** — these do not move inside 0.1.x:

- the protocol-1 wire (envelope, pairing, claim — the three surfaces above);
- the site manifest, v1, including the keys reserved above;
- the daemon config, v1;
- the CLI verbs: `setup`, `run`, `start`, `stop`, `status`, `services`,
  `model`, `log`. A wizard is a user interface over `setup`, not a new verb;
- the BYO-lane privacy promises: end-to-end encryption, *"we never access your
  box"*, and a subscription you bring never serving anybody but you.

**Not locked** — stated here so the promise is not read wider than it is:

- console frames (hosted-only at 0.1.0, so both ends are ours — see the
  carve-out above);
- hub internals;
- the dashboard.

## The consent principle

**A lane added later carries its own disclosure, and never weakens an existing
lane's promise.**

One sentence, because it has to survive every future feature that is easier
without it. Routing lanes are the case at hand: `site-fixed` and
`user-first-with-fallback` change who pays and whose service answers, so each
arrives with its own disclosure on the consent screen, and neither changes what
`user-choice` already promised the people who chose it.

The concrete obligation it puts on the reserved field above: **a hub that does
not implement a lane treats the purpose as `user-choice` and says so in a
field** — it does not silently downgrade. A promise quietly unmet is worse than
one refused, because nobody learns.

## How the lock is enforced

Two mechanisms, and neither is optional.

1. **`@byollm/conformance`, against every implementation** — including ours.
   The checks run in CI on this repository and are published so a third party
   can run them against their own.
2. **Cross-repository pin comparison (B164).** Conformance proves an
   implementation speaks the protocol; it says nothing about whether the three
   repositories are speaking the SAME version of it.

   **That second half is not hypothetical.** On 2026-09-16, `byollm-cloud-web`
   was pinned at `0.1.0-alpha.90` while the hub and `latest` were on `.94` —
   four versions of drift, which nothing caught. It was found by somebody
   needing an export and discovering it was absent. A schema lock with no
   cross-repo comparison is a promise each repository makes to itself.

## What breaks the lock, plainly

- A field added to, removed from, or renamed on a locked shape.
- A field's type narrowed, or its meaning changed with its type intact.
- A refusal code removed, or reused for a different condition.
- A conformance check deleted or weakened without the surface it proved
  changing.

Any of those is a version change that moves both ends, announced in the
release note, not a patch.
