#!/usr/bin/env bash
# Print the base-cache key for commit $2, with CI tooling from the git checkout at $1.
# A failure list depends on the commit, the CI tooling (ci/ and ci.yml: runner, versions,
# shard count) and unpinned dependencies; the ISO week bounds how long a list can age.
set -euo pipefail
tools="$(git -C "$1" ls-tree -r HEAD -- ci .github/workflows/ci.yml | sha256sum | cut -c1-16)"
echo "ci-base-v2-${CONTROLLER_SHARDS:?}-$2-$tools-$(date -u +%G-W%V)"
