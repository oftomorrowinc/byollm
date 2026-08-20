#!/bin/sh
# The tagging path — cloud_010 morning, 2026-08-20.
#
#     ./scripts/tag.sh            # tag HEAD as v<the version in packages/>
#     ./scripts/tag.sh v0.1.0-alpha.29
#
# Two refusals, and the first one is why this exists. `v0.1.0-alpha.28` was
# created in `byollm-cloud` — a repository with no release workflow — where it
# sat inertly while everybody waited for npm. Nothing was wrong with the tag;
# it was in a repository that does not publish, and the only thing that would
# have said so is something that looked.
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

# 3. Tag what is committed, not what is lying around.
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to tag: the working tree is dirty." >&2
  echo "  A tag names a commit, and this one would not be the tree you built." >&2
  exit 1
fi

git tag -a "$wanted" -m "$version" HEAD
echo "tagged $(git rev-parse --short HEAD) as $wanted"
echo
echo "  Push it when CI is green on this commit:"
echo "    git push origin $wanted"
