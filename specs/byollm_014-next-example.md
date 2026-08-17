# byollm_014 — An example that a real `next build` compiles

**Status: open. Filed 2026-08-17 from
[issue #5](https://github.com/oftomorrowinc/byollm/issues/5), which exists
because of Kevin Samsoe's (@KSamsoe) integration report in
[#4](https://github.com/oftomorrowinc/byollm/issues/4).**

## What is missing

`docs/standards.md` says every example runs in CI, and
[`examples/demo`](../examples/demo) does. It is a Node script. **Nothing in
this repository has ever been through a real `next build`**, and the Next.js
integration is the one most people will use.

Issue #4 is the proof that this matters. The documented pattern constructed the
store at module scope; `next build` imports route modules to collect page data,
finds no service-role key in that context, and fails. The fix is in and correct
— `createHandler` takes a thunk, so importing a route has no side effect and
needs no credential — and **nothing we run would notice if it regressed
tomorrow.**

That is this project's recurring shape, recorded in
`packages/conformance/MUTATIONS.md`: a check reporting success for a reason
unrelated to the property it claims. "Every example runs in CI" is true, and
the example that runs is not the one the failure was in.

## Why a unit test is not the answer

The failure only exists inside `next build`. A test that imports `next.ts` and
asserts the config is a thunk proves the *shape* and would pass against a build
that still fails for a reason nobody predicted — a bundler resolution, an edge
runtime constraint, a `dynamic` export the framework stops honouring.

The bug was in the interaction with a framework's build. Only that build
observes it.

## The change

An `examples/next` app, minimal and real:

- one route using `createHandler` exactly as the README documents it, thunk
  and all;
- `next build` run in CI on every PR, on the same matrix `byollm_010` requires
  for anything we let people install;
- **no credentials available to the build**, which is the entire point. If the
  build can only pass with `BYOLLM_SITE_KEYS` set, it is not reproducing what a
  user's CI does.

It does not need to serve traffic, route a job, or have a UI. It needs to
compile.

## The rule this generalises

**A documented integration pattern needs an example the integration's own
toolchain builds.** Not ours — theirs. The demo proves the protocol; it cannot
prove that Next can compile a file that uses it, because Next was never asked.

Where that gets expensive — a framework whose build needs a long toolchain —
the honest move is to record the gap rather than assert coverage from an
adjacent test, the same way `MUTATIONS.md` records the checks that cannot bite.

## Credit

Both halves come from **Kevin Samsoe (@KSamsoe)**. #4 named the bug — the
documented pattern building the store at module scope — and its closing note
named this: *"probably wants an example that CI actually executes, since
docs/standards.md says every example runs in CI."*

Worth recording that the reporter identified the missing coverage in the same
breath as the bug, and that the bug got fixed first while the coverage sat
open for three days. The fix is the satisfying half; the example is the half
that stops it coming back.

## Done when

- `examples/next` exists and its route is the README's pattern verbatim.
- CI runs a real `next build` against it on every PR, with no site keys in the
  environment.
- Reverting `createHandler`'s thunk support fails that build. (Mutation-verified,
  like every other check here — a build step that passes against the broken
  version is a build step that is not testing the bug it was written for.)
- `docs/standards.md`'s "every example runs in CI" is true of the examples that
  matter, not only the one that was easy.
