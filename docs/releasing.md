# Releasing

Publishing happens in GitHub Actions, using npm **trusted publishing**. There
is no npm token — not on a laptop, not in a GitHub secret, not anywhere. The
workflow proves its identity to npm with a short-lived OIDC credential that
GitHub mints per run and npm verifies against a publisher you configure once.

That property is the point. A long-lived `_authToken` in `~/.npmrc` is a file
that can publish to your packages if it ever leaks; an OIDC credential expires
in minutes and cannot be copied off the runner in a useful form. It also means
a release does not depend on one person's passkey being in the room.

Trusted publishing requires a **public repository**, which is why this became
possible only after the repo went public.

## One-time setup

Authorize the workflow once per package. Use the CLI — it is exact, it is
reviewable in a diff, and it does not depend on finding a page:

```bash
for pkg in "@byollm/protocol" "@byollm/server" byollm "@byollm/conformance" "@byollm/relay"; do
  npm trust github "$pkg" \
    --file release.yml \
    --repo oftomorrowinc/byollm \
    --allow-publish -y
done

# Check what you did:
npm trust list byollm
```

**Every new package needs this before its first workflow release**, and the
ordering is awkward on purpose: `npm trust` configures a publisher *for a
package*, so the package has to exist first. A brand-new name therefore takes
one manual publish, then this, and rides the workflow from then on.

`@byollm/relay` went that way at `0.1.0-alpha.5` — which is why it is the one
package without a provenance attestation. It gains one at its next
workflow-published release, and the gap is worth knowing about rather than
discovering while auditing the supply chain.

**The workflow now refuses rather than trusting you to have read this.**
`@byollm/control-plane` was added to `packages/` and tagged without the manual
first publish, and the release got one sibling out before npm answered `404
PUT` — a half-published version, from a precondition this page states and
nothing enforced. The version step checks the registry for every package it is
about to publish and stops the run before anything ships, printing the two
commands above with the name filled in. A paragraph is not a guard.

Add `--dry-run` to see exactly what each call would set without changing
anything; it prints the package, workflow file, repo and permissions back to
you. Each real call is an account write, so expect a passkey prompt per
package.

`--allow-publish` only. `npm stage publish` is a separate action this project
does not use, and authorizing an action nobody calls is free blast radius.

The same thing exists in the web UI at **npmjs.com → your package → Settings →
Trusted Publisher**, but the Settings tab only renders for a logged-in
maintainer and is easy to miss; the CLI is the reliable route.

**What this trades.** After this, anyone who can push to this repo's release
workflow can publish these packages — repository write access becomes publish
access. That is usually the better bargain, because a repo's write access is
easier to audit and revoke than a token that has been copied somewhere. But it
is a real change in who can publish, and it is worth knowing rather than
discovering.

**Names are matched exactly and case-sensitively.** A mismatch is not reported
when you set it — only when a publish fails, with `ENEEDAUTH`, which reads like
an auth problem rather than a typo. If a release fails that way, check the
workflow filename first; it is the usual culprit, and it must include the
`.yml`.

The package's `repository.url` must also match the GitHub repo. It already does
for all four — but it did not while the repo was private, when those fields were
stripped, so re-check if manifests are ever edited.

## Cutting a release

```bash
# 1. Bump all four packages. They move in lockstep; the workflow refuses
#    to publish if they disagree.
#    packages/{protocol,server,daemon,conformance}/package.json
#    and packages/daemon/src/index.ts (DAEMON_VERSION)
#    and the alpha warning in the five READMEs and site/index.html

# 2. Verify locally. CI runs this too, and so does the release workflow —
#    but finding it here is cheaper than finding it mid-release.
pnpm run verify

# 3. Commit, push, and let CI go green.

# 4. Tag it. `tag.sh` refuses to make one this repository cannot publish,
#    and one that disagrees with packages/ — see below.
./scripts/tag.sh
git push origin v0.1.0-alpha.4
```

### Why `tag.sh` rather than `git tag`

On 2026-08-20 the tag for `alpha.28` was created and pushed in
**`byollm-cloud`** — a repository with no release workflow. It sat there
inertly while everybody waited for npm. Nothing was wrong with the tag; it was
in a repository that does not publish, and nothing looked.

So `tag.sh` asks two questions: does this repository have
`.github/workflows/release.yml` at all, and does the tag name the version every
`packages/*/package.json` carries. The second already exists server-side in the
workflow; having it here turns a failed run into a message before the push.

It does **not** push. npm versions are immutable, so the irreversible step
stays something a person types.

The pre-push gate refuses the same two things, in this repository and in
`byollm-cloud` — because the mistake is made in the repository you are standing
in, and that is usually the one that cannot publish. `byollm-cloud-web` has no
hook installer yet; a stray tag there is still only inert.

The tag push triggers the workflow. It re-runs the full gate — `verify`, the
adversarial corpus, and conformance — before publishing anything, because a
tag can point at any commit, including one CI never saw.

### Rehearsing

Actions → **Release** → **Run workflow**, leaving *dry run* checked. That
exercises the build, all four guards, and the packing step without publishing.

It cannot exercise OIDC, though: no publish call is made, so nothing tests the
trusted-publisher configuration. A green dry run means the release is *buildable*,
not that npm will accept it. The first real run is what proves the setup.

## How it publishes, and why it looks odd

The workflow packs with pnpm and publishes with npm:

```bash
pnpm pack                 # rewrites `workspace:*` -> the pinned version
npm publish <tarball>     # speaks OIDC
```

Neither tool does both. `npm publish` alone would ship a manifest whose
dependencies read `workspace:*`, which resolves for nobody outside this repo —
that is what `pnpm publish` exists to fix, and it is how the alpha.2 manifests
came out correct. But pnpm's support for OIDC trusted publishing is unclear,
while npm's is documented and version-gated. Handing npm a tarball pnpm packed
gets both properties, and the workflow asserts no `workspace:` survived into a
tarball before it publishes anything.

## What the workflow refuses to do

Each guard is a mistake that would otherwise happen silently:

- **Versions out of lockstep.** Publishing `byollm@0.1.0-alpha.4` that depends
  on `@byollm/protocol@0.1.0-alpha.4` when protocol was left at `.3` ships a
  package nobody can install.
- **A tag that disagrees with the version.** `v0.1.0-alpha.4` pointing at a
  commit where the manifests say `.3`.
- **A version already on npm.** npm versions are immutable, so this would fail
  anyway — but partway through, with two of four packages already public.
- **A prerelease reaching `latest` by accident.** The dist-tag is derived from
  the version string: `-alpha.` → `alpha`, `-beta.` → `beta`, any other
  prerelease → `next`, and only a clean version → `latest`.

## The `latest` retag — the one manual step

npm forces `latest` onto a package's first publish and will not let it be
removed, so a bare `npm install byollm` resolves *somewhere* no matter what we
do. We point it at the newest alpha, so a bare install gets the version whose
README carries the current warning rather than one silently older.

**OIDC does not cover this, and the workflow does not try.** Settled in the
0.1.0-alpha.3 release: `npm publish` exchanged the OIDC credential correctly,
and `npm dist-tag` in the very same job fell through to the placeholder
`NODE_AUTH_TOKEN` that `setup-node` writes and died with `E401`. A trusted
publisher authorizes *publishing*; a retag is a different write, and nothing
authorizes it.

So after a prerelease, run this locally. It is a write per package, so expect
a passkey prompt each time:

```bash
V=0.1.0-alpha.4   # whatever you just released
for n in "@byollm/protocol" "@byollm/server" byollm "@byollm/conformance"; do
  npm dist-tag add "$n@$V" latest
done
```

The run summary prints these commands with the version filled in, so you can
copy them from there.

**Expect the last package to read stale.** The registry's read path is
eventually consistent behind a CDN, so checking tags immediately after setting
them tends to show the package you wrote last still on the old version. It is
lag, not a failed write. Re-read after a few seconds, or go straight to the
registry to skip npm's own cache:

```bash
curl -s "https://registry.npmjs.org/-/package/@byollm%2Fconformance/dist-tags"
```

Two things deliberately *not* done about it. The workflow does not attempt the
retag and report a failure — a step that always fails teaches everyone to
ignore it, which is worse than not having it. And it does not carry a granular
token in a GitHub secret to make the retag work, because a long-lived
publish-capable credential in CI gives back exactly the property trusted
publishing was adopted for.

## If you must publish by hand

You should not need to. If the workflow is broken and a release cannot wait:

```bash
pnpm run verify
for pkg in protocol server daemon conformance; do
  ( cd "packages/$pkg" && pnpm publish --tag alpha --access public --no-git-checks )
done
```

`pnpm publish` (not `npm`) — it does the `workspace:*` rewriting. Expect a
browser authentication per package, and again per `dist-tag`, because the
account requires two-factor on writes and a passkey cannot be scripted.


## When a release publishes some packages and then fails

npm versions are immutable, so a mid-loop failure cannot be retried at the
same number: the packages that already went out will fail the "already
published" guard on the next attempt, and that guard is right to refuse.

**Burn the version and release the next one.** Fix the cause, run
`node scripts/bump-version.mjs <next>`, commit, move the tag. Version numbers
are free; a half-published version that somebody later resolves to is not.

This happened at `0.1.0-alpha.6`: `@byollm/protocol`, `@byollm/conformance`
and `byollm` published, then `@byollm/relay` was rejected with a 422 because
its manifest had no `repository.url` for provenance to match, and
`@byollm/server` — which sorts after it — was never attempted. `alpha.6` is
therefore a partial release that exists on the registry forever, and `alpha.7`
is the real one.

Two checks came out of it, both pre-flight, because the lesson is that a
guard which only runs before the loop cannot save you from a failure inside
it: every package's `repository.url` is verified before anything publishes,
and `scripts/bump-version.mjs` exists so the version mismatch that preceded
this cannot recur by hand.

## Confirming a release, without watching the run

```sh
pnpm release:check              # the version in the repo
pnpm release:check 0.1.0-alpha.11
```

It asks npm, not GitHub. That is the point rather than a convenience.

Watching the Release workflow is the obvious way to answer "did it go out",
and it is answerable about the wrong release: polling `gh run list` for
`alpha.11` matched the still-listed `alpha.10` run, reported success, and npm
was serving the older version the whole time. *A* Release run had succeeded.
Not that one.

The registry has no such ambiguity. A version is there or it is not, and the
`alpha` tag points at it or it does not. The release workflow now runs this as
its final step, so a partial publish — the `alpha.6` state, four packages live
and one missing, every one of them resolvable — fails the job with the name of
the package that is missing.

`latest` is reported and never asserted: moving it needs a human with 2FA, on
purpose, so a `latest` behind `alpha` is a decision nobody has made yet rather
than a broken release.
