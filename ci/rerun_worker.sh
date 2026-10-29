#!/usr/bin/env bash
# Rerun head-only Worker failures ($1) on the head checkout; ids that pass go to $2 (CI-NEW-35).
set -euo pipefail
new="$1"; flaky="$2"
tools="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$flaky")"; : > "$flaky"
[ -s "$new" ] || { echo "no head-only worker failures"; exit 0; }
# ids such as "worker: npm ci" or tsc have no file to rerun; they stay new without an install
grep -q '\.test\.ts :: ' "$new" || { echo "no rerunnable worker failures"; exit 0; }
cd worker
npm ci --no-audit --no-fund
python "$tools/rerun_new_failures.py" rerun-worker "$new" "$flaky"
