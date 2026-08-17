# byollm_013 — Detection must run the thing

**Status: open. Filed 2026-08-17 from a Windows field report by Kevin Samsoe
(@KSamsoe), alongside [PR #6](https://github.com/oftomorrowinc/byollm/pull/6).**
**Amends `CAPABILITY_IS_DETECTED` (byollm_002 §Routing).**

## The MUST, and the hole in it

> An advertised capability matrix MUST be the intersection of owner config and
> **detected, healthy reality** — never config alone.

`C021_CAPABILITY_IS_DETECTED` verifies it, and the daemon satisfies it. Both
are wrong about what "healthy reality" means, and a real user found out how.

Kevin Samsoe, testing on Windows 11 with Claude Code `1.0.61` installed:

```
$ byollm backends
  ✓ llm.generate   claude-cli:claude-opus-5
  ✓ llm.chat       claude-cli:claude-opus-5

2 of 2 routes are healthy and will be advertised.
```

The first job failed with `unknown option '--tools'`.

**Detection confirmed a binary existed. It did not confirm the binary accepts
the arguments it will be given.** So the daemon advertised a capability it
could not serve, which is the exact sentence the MUST forbids — while passing
the check written to enforce it.

## Why this is the recurring class, not a one-off

It is the shape recorded in `packages/conformance/MUTATIONS.md` as *"success
reported for a reason unrelated to the property it claims"*. `health()`
answered a question — *is something there?* — that is adjacent to the one the
MUST asks — *will it run what I am about to send?* — and the two agreed for
long enough to look like the same question.

The same day, the same install produced the opposite failure: after the CLI
updated to 2.x, `backends` reported **0 of 2** and the daemon declined to
advertise anything. That one was correct and silent. Both failures are the
same missing probe seen from either side.

## The change

**`health()` MUST execute the backend the way `execute()` will**, with the
same resolved command and the same argv shape, and MUST treat a non-zero exit
or an unparseable response as unhealthy.

Concretely, for a CLI backend: a one-token prompt through the exact argv the
runner would build. It costs one cheap invocation per health check and it
would have caught both of the day's failures before a job was ever claimed.

Three things this must not become:

1. **Not a model call.** The probe proves the invocation, not the model. A
   backend that answers anything at all has proven what is being asked.
2. **Not a substitute for the runtime error path.** A probe that passed and an
   execution that failed is still possible — a CLI can accept `--tools` and
   reject the prompt. The probe narrows the window; it does not close it.
3. **Not silent when it fails.** Today's failure mode is a route that quietly
   vanishes from the matrix. `backends` MUST say which probe failed and what
   it was told, because "0 of 2 healthy" with no reason is what sent a tester
   to read our source.

## Verification

`C021` currently asserts that a backend the owner configured but that is not
installed does not appear. That is the *absence* half, and it passes against a
daemon that never probes anything.

It needs the other half, and the kit can express it: a backend that is present
and **refuses the argv** must not be advertised. The reference daemon's
`EchoBackend` becomes able to reject a specific flag, and the check asserts the
route is absent for that reason rather than for being missing.

That is the "each side of the *and*" rule from MUTATIONS.md's "half a MUST is
not a covered MUST", applied to a MUST whose "and" is inside the word
*healthy*.

## Config, and the thing a user had no way to reach for

Kevin's report notes that `backends.<name>.binary` is not a recognised key, so
a Windows user whose layout we did not anticipate had nothing to configure
around it. The resolver fix (PR #6, `0.1.0-alpha.11`) removes the immediate
need, and the general point stands: **a detector that can be wrong needs an
override.** Whether that is `binary`, or a fuller `command`/`args` escape
hatch, is open — and it should be decided with the probe above, because a
probe that fails is exactly when someone reaches for it.

## Credit

Found by **Kevin Samsoe (@KSamsoe)** on Windows 11, and reported alongside the
resolver fix rather than folded into it — which is why it is a spec instead of
a footnote in a diff. The daemon was doing exactly what the code said and
exactly what the check verified, and only somebody running it on a machine we
do not have could see that both were wrong. That is what an outside tester is
*for*, and it is the second time this one has produced a finding the suite
could not (see `byollm_010`, which exists because the same tester ran the
daemon on Windows at all).

## Done when

- `health()` runs the resolved command with the runner's argv shape, and a
  backend that rejects it is not advertised.
- `byollm backends` names the failing probe and what it reported.
- `C021` covers both halves: absent-because-missing and
  absent-because-it-refused-the-arguments, each mutation-verified.
- An override exists for a resolver that guesses wrong, or this spec records
  why it does not.
