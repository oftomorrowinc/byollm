# The Next.js integration, compiled

This exists to be built, not to be run. It is the three-file integration from
[`@byollm/server`'s README](../../packages/server/README.md) — copied, not
adapted — in an app that CI puts through a real `next build` on every PR.

## Why

`docs/standards.md` says every example runs in CI, and that was true while
nothing here had ever been through a bundler. The gap showed up as
[#4](https://github.com/oftomorrowinc/byollm/issues/4): the documented pattern
constructed the store at module scope, `next build` imports route modules to
collect page data, and the build failed on a credential it could not have. A
unit test calling `createHandler` directly cannot see that — the failure lives
inside a framework's build, and only that build observes it.

**The build runs with no `BYOLLM_SITE_KEYS` in the environment.** That absence
is the test. A build that only passes with keys set is not reproducing what an
integrator's CI does.

## What to copy

`src/app/api/byollm/[...route]/route.ts` and `src/lib/byollm.ts`. That is the
whole integration. The page in `src/app/page.tsx` exists so Next has something
to render; it is not part of the pattern.

TypeScript is pinned to 5.x here, independently of the repository's own
toolchain: Next 15 does not recognise TypeScript 7 and tries to install 5.x
itself when it finds one.
