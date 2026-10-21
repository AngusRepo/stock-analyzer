#!/usr/bin/env bash
# Rerun head-only controller failures ($1) on the head checkout; ids that pass go to $2.
set -euo pipefail
new="$1"; flaky="$2"
tools="$(cd "$(dirname "$0")" && pwd)"
: > "$flaky"
[ -s "$new" ] || { echo "no head-only controller failures"; exit 0; }
source "$tools/controller_deps.sh"
controller_deps
cd ml-controller
PYTHONPATH="$(cd .. && pwd):$PWD" python "$tools/rerun_new_failures.py" rerun "$new" "$flaky"
