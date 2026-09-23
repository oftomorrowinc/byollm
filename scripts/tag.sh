#!/bin/sh
# The tagging path — cloud_010 morning, 2026-08-20.
#
#     ./scripts/tag.sh            # tag HEAD as v<the version in packages/>
#     ./scripts/tag.sh v0.1.0-alpha.29
#
# It refuses for several reasons, and the first one is why it exists.
# `v0.1.0-alpha.28` was created in `byollm-cloud` — a repository with no
# release workflow — where it sat inertly while everybody waited for npm.
# Nothing was wrong with the tag; it was in a repository that does not
# publish, and the only thing that would have said so is something that
# looked.
#
# The second refusal (tag must match the packages' version) already exists
# server-side in `release.yml`. Having it here too costs a `node -p` and turns
# a failed workflow run into a message before the push.
#
# It deliberately does **not** push. Publishing is irreversible — npm versions
# are immutable — so the last step stays something a person types.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

# 1. Does this repository publish anything at all?
if [ ! -f .github/workflows/release.yml ]; then
  echo "refusing to tag: $root has no .github/workflows/release.yml." >&2
  echo "  A v* tag here publishes nothing. The release repository is the one" >&2
  echo "  with packages/ and that workflow in it." >&2
  exit 1
fi

if [ ! -d packages ]; then
  echo "refusing to tag: no packages/ directory, so there is no version to" >&2
  echo "  agree with." >&2
  exit 1
fi

# 2. Every package moves in lockstep, and the tag names that version.
version="$(node -p 'require("./packages/protocol/package.json").version')"
for manifest in packages/*/package.json; do
  pkg_version="$(node -p "require('./$manifest').version")"
  if [ "$pkg_version" != "$version" ]; then
    echo "refusing to tag: $manifest is $pkg_version but protocol is $version." >&2
    echo "  Packages publish in lockstep; the workflow refuses this too, later." >&2
    exit 1
  fi
done

wanted="${1:-v$version}"
if [ "$wanted" != "v$version" ]; then
  echo "refusing to tag: $wanted does not name version $version." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$wanted" >/dev/null; then
  echo "refusing to tag: $wanted already exists here." >&2
  echo "  npm versions are immutable; bump the version rather than re-tagging." >&2
  exit 1
fi

# 3. A release says what changed, or it is not ready to be one.
#
# B079's copy was approved and never shipped. It was not dropped — the runbook
# was six steps (bump, verify, commit, tag, publish, retag) and none of them
# was "write the note", so there was nowhere to put it. `v0.1.0-alpha.86`'s
# page is the tag annotation's subject line, because that is the only prose
# the release process ever collected.
#
# Refusing here is the same move this script already makes twice: the runbook
# said "remember", and remembering is what a gate is for. The workflow then
# publishes this file as the release body, so writing it is the thing that
# makes it reach a reader.
note="docs/release-notes/$version.md"
if [ ! -s "$note" ]; then
  echo "refusing to tag: $note is missing or empty." >&2
  echo "  A release with no note ships as a truncated tag subject, which is" >&2
  echo "  how an approved paragraph went unpublished for a week. Write what" >&2
  echo "  changed for the people installing it, then tag." >&2
  exit 1
fi

# 4. Tag what is committed, not what is lying around.
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to tag: the working tree is dirty." >&2
  echo "  A tag names a commit, and this one would not be the tree you built." >&2
  exit 1
fi

# 5. The cut carries the pin — B234.
#
# `.95`, `.96` and `.97` were all cut correctly, and all three needed a second,
# separate, human step afterwards: bumping the version this repository had just
# published in the two repositories that pin it again. On `.97` that step was
# not taken, and what caught it was Todd asking before a roll — which is not a
# check, it is a near miss with good manners. The next box rebake would have
# put a `.97` daemon on the fleet under a repository claiming `.96`.
#
# Last, because everything above is about this tree and this one is about two
# others: a dirty tree should fail in a millisecond, not after reading two
# sibling repositories.
#
# The lockfiles are NOT checked here and cannot be. A lockfile records what the
# registry resolved; the registry has nothing to resolve until this tag is
# pushed and published. Demanding the impossible is how a gate acquires an
# escape hatch on its first night — so `release-check.mjs` asks for the
# lockfiles afterwards, when the answer is allowed to exist.
#
# `--committed`, because a pin that is only an unsaved edit is not a pin: a tag
# names a commit, and a `git checkout` an hour later takes the edit and leaves
# the release.
# `--before-publish` — B346. The web repo's catalog cannot name a version npm
# has not served without failing every Vercel production build, so its pin
# lands with its lockfile in one push afterwards and `release-check.mjs`
# refuses the release if it was forgotten. The hub has no such deploy and is
# still checked here. The skip is printed, not silent.
node scripts/pins-checked.mjs "$version" --manifests-only --committed --before-publish || exit 1

# 6. The docs stop saying "alpha" when the version stops being one — B222.
#
# `bump-version.mjs` rewrites the version INSIDE the alpha banner and never
# removes the banner, so the flip would have tagged a tree carrying
# "Alpha (`0.1.0`) — under active development. Don't use this yet." on eight
# READMEs and the site, in the commit that makes the repository public.
#
# The banner is the smaller half. The docs also carry live instructions pinned
# to the `alpha` dist-tag — `npm install @byollm/protocol@alpha`,
# `npx --package @byollm/server@alpha keygen` — and the flip moves `latest`,
# not `alpha`. Each of those would go on resolving to the last prerelease, so
# somebody following our own quickstart installs an OLDER package than the one
# just locked, and the failure looks like theirs.
#
# Here rather than only in `verify` because this is the one moment it matters
# and the one moment somebody is in a hurry.
node scripts/alpha-claims-match-the-version.mjs || exit 1

# 7. Windows and macOS have seen this tree — B344.
#
# A push to `main` runs the daemon suite on ubuntu only; the three-OS matrix
# runs on a tag, a schedule, or a `workflow_dispatch` (B315, for the bill). So
# the FIRST time Windows meets a commit is the release itself, and v0.1.1 found
# that out twice in one night: 87f26b7 green on main and red on the tag
# (changelog.mjs writing on import, byte-identical under LF and not under CRLF),
# then b712b49 red the same way (`import()` given a path, which is only a URL
# scheme error on Windows). Two dead tags, deleted and re-cut, because the tag
# was doing a pre-tag check's work.
#
# So: a completed, successful `schedule` or `workflow_dispatch` CI run must
# exist AT THIS SHA before a tag is made. Not "a green run" — those exist on
# main and are ubuntu-only; the event is what carries the matrix.
#
# **Cancelled runs are dropped, and that is not a detail.** Dispatching CI by
# hand at a sha that already has a push run cancels the push run through the
# concurrency group — I did exactly that on e961280, and `release.yml`'s own
# `Wait for CI` then read the cancelled run as a failure and refused to publish
# a release whose CI had passed on three OSes, twice. A cancelled run is nobody
# answering the question, not an answer.
if command -v gh >/dev/null 2>&1; then
  sha="$(git rev-parse HEAD)"
  matrix="$(gh run list --commit "$sha" --workflow ci.yml \
    --json event,status,conclusion --jq \
    '[.[] | select(.event == "schedule" or .event == "workflow_dispatch")
          | select(.conclusion != "cancelled")]
       | map(select(.status == "completed" and .conclusion == "success"))
       | length' 2>/dev/null || echo 0)"
  if [ "${matrix:-0}" -lt 1 ]; then
    echo
    echo "  No three-OS run has passed on $(git rev-parse --short HEAD)."
    echo
    echo "  A push to main runs ubuntu only. Windows and macOS see a commit"
    echo "  for the first time at the tag, and v0.1.1 lost two tags that way."
    echo
    echo "    gh workflow run ci.yml --ref $(git rev-parse --abbrev-ref HEAD)"
    echo "    gh run watch <id> --exit-status     # then run tag.sh again"
    echo
    echo "  Do not dispatch at a sha whose push run is still going: the"
    echo "  concurrency group cancels it, and a cancelled run is not a verdict."
    exit 1
  fi
  echo "three-OS CI is green on $(git rev-parse --short HEAD)."
else
  # Said, not assumed. A refusal this check cannot make is one somebody has to
  # know it did not make.
  echo
  echo "  gh is not installed, so the three-OS run was NOT checked (B344)."
  echo "  Confirm by hand that a schedule or workflow_dispatch CI run passed"
  echo "  on $(git rev-parse --short HEAD) before pushing this tag."
fi

git tag -a "$wanted" -m "$version" HEAD
echo "tagged $(git rev-parse --short HEAD) as $wanted"
echo
echo "  Push it when CI is green on this commit:"
echo "    git push origin $wanted"
