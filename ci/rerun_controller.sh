#!/usr/bin/env bash
# Rerun head-only controller failures ($1) on the head checkout; ids that pass go to $2.
# --base <stale.txt> $1 $2: from the base checkout (cwd), run the ids still failing after the
# head reruns on the base; ids that fail there every time go to stale.txt. If the base cannot
# install, nothing is marked stale and the ids stay new.
set -euo pipefail
stale=""
if [ "${1:-}" = --base ]; then stale="$2"; shift 2; fi
new="$1"; flaky="$2"
tools="$(cd "$(dirname "$0")" && pwd)"
if [ -n "$stale" ]; then
  : > "$stale"
  [ -n "$(comm -23 <(sort -u "$new") <(sort -u "$flaky"))" ] || { echo "no failures left to check on the base"; exit 0; }
  mode=base; args=("$new" "$flaky" "$stale")
else
  : > "$flaky"
  [ -s "$new" ] || { echo "no head-only controller failures"; exit 0; }
  mode=rerun; args=("$new" "$flaky")
fi
source "$tools/controller_deps.sh"
if [ "$mode" = base ]; then
  controller_deps || { echo "base dependency install failed; nothing marked stale"; exit 0; }
else
  controller_deps
fi
cd ml-controller
PYTHONPATH="$(cd .. && pwd):$PWD:$(cd ../ml-service && pwd)" python "$tools/rerun_new_failures.py" "$mode" "${args[@]}"
