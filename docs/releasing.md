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

Do this once per package, on npmjs.com. All four need it:
`@byollm/protocol`, `@byollm/server`, `byollm`, `@byollm/conformance`.

1. Open the package → **Settings** → **Trusted Publisher**.
2. Choose **GitHub Actions** and fill in exactly:

   | Field | Value |
   |---|---|
   | Organization or user | `oftomorrowinc` |
   | Repository | `byollm` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave empty)* |

3. Save.

**Every field is case-sensitive and matched exactly.** A mismatch is not
reported when you save it — only when a publish fails, with `ENEEDAUTH`, which
reads like an auth problem rather than a typo. If a release fails that way, check
the workflow filename first; it is the usual culprit, and it must include the
`.yml`.

The package's `repository.url` must also match the GitHub repo. It already
does for all four — but it did not while the repo was private, when those
fields were stripped, so it is worth re-checking if manifests are ever edited.

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

# 4. Tag it. The tag must match the version, with a leading `v`.
git tag v0.1.0-alpha.4
git push origin v0.1.0-alpha.4
```

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

## The `latest` retag

npm forces `latest` onto a package's first publish and will not let it be
removed, so a bare `npm install byollm` resolves *somewhere* no matter what we
do. We point it at the newest alpha, so a bare install gets the version whose
README carries the current warning rather than one silently older.

Whether OIDC authorizes `npm dist-tag` is undocumented — a trusted publisher
authorizes *publish* actions, and this is a different write. So the workflow
attempts it, is allowed to fail, and prints the manual commands in the run
summary if it does. Whichever way the first real release goes, update this
paragraph to say so rather than leaving the next person to rediscover it.

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
