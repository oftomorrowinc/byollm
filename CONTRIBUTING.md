# Contributing

**The guide is in [the README's Contributing section](README.md#contributing),
and this file is deliberately a pointer to it rather than a copy.**

GitHub looks for a file called `CONTRIBUTING.md` — it links one from the "new
issue" and "new pull request" screens, which is the moment somebody actually
wants it. What it does not need is a second set of instructions: two copies of
how to build a project drift, and the copy that goes stale is the one nobody
runs commands from.

So the short version lives here and the reasoning lives there:

```sh
pnpm install
pnpm run verify     # format, build, smoke, lint, typecheck, tests, coverage, dead code
```

**Run `pnpm run build` before any bare `tsc`.** On a clean checkout
`tsc -p packages/daemon` reports that `@byollm/protocol` does not exist,
because packages resolve their neighbours through `dist/`. The README explains
why, and why that paragraph exists at all.

## Reporting a security problem

Not here, and not in an issue. [`SECURITY.md`](SECURITY.md) is the one place
that says how.

## What the bar is

CI-enforced rather than review-vigilance: strict TypeScript, coverage floors,
zero-warning lint, no dead code, an adversarial corpus as a blocking gate, and
the conformance kit green against both the reference server and Supabase. The
README lists the numbers; `docs/standards.md` holds the reasoning.

**Early, and honest about it:** the protocol is version 2 as of `0.1.0` and a
party running `0.1.0` can talk to any later `0.1.x`. The software around it is
early, and on-disk and store shapes are still moving. Read the warning at the
top of the README before you build something on this.
