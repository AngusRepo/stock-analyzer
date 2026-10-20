#!/usr/bin/env bash
# Run one CI suite in the current checkout and write one failure id per line to $2.
# Exit status is always 0 once the list is written: ci/compare_failures.py judges
# head against base. A step that cannot run is itself recorded as a failure id.
set -euo pipefail
suite="$1"; out="$2"
tools="$(cd "$(dirname "$0")" && pwd)"
: > "$out"
fail() { echo "$1" >> "$out"; }
# tsc lines -> stable ids (drop line/col so unrelated edits do not churn ids)
tsc_ids() { grep -E 'error TS[0-9]+' | sed -E 's/\([0-9]+,[0-9]+\)//' | sed "s|^|$1: |" >> "$out" || true; }

case "$suite" in
  worker)
    cd worker
    npm ci --no-audit --no-fund || { fail "worker: npm ci"; exit 0; }
    npx tsc --noEmit -p tsconfig.json > "$RUNNER_TEMP/tsc.txt" 2>&1 || tsc_ids "worker tsc" < "$RUNNER_TEMP/tsc.txt"
    npx tsc --noEmit -p tsconfig.tests.json > "$RUNNER_TEMP/tsc-tests.txt" 2>&1 || tsc_ids "worker tsc tests" < "$RUNNER_TEMP/tsc-tests.txt"
    # Runtime E2E tests need a local server/model runtime (same exclusion as p9_gate.ps1).
    mapfile -t files < <(ls src/lib/*.test.ts | grep -vE 'strategyDiscovery(LocalE2E|RealModelE2E)\.test\.ts$' | sort)
    node --import tsx --test --test-concurrency=4 \
      --test-reporter=dot --test-reporter-destination=stdout \
      --test-reporter="$tools/node_failures_reporter.mjs" --test-reporter-destination="$RUNNER_TEMP/node-fail.txt" \
      "${files[@]}" || true
    [ -f "$RUNNER_TEMP/node-fail.txt" ] && sort -u "$RUNNER_TEMP/node-fail.txt" >> "$out" || fail "worker: test runner produced no report"
    ;;
  controller)
    # Native Paper tests bundle worker/src with esbuild, so they need the worker's node_modules.
    (cd worker && npm ci --no-audit --no-fund) || fail "controller: worker npm ci"
    cd ml-controller
    python -m pip install -q -r requirements.txt pytest==9.0.3 pytest-asyncio==1.4.0 pytest-timeout==2.4.0 \
      pytest-xdist==3.8.0 || { fail "controller: pip install"; exit 0; }
    # Tests import both repo-root `tools` and `tests.*`; a broken module must not hide the rest.
    # One worker per core; loadfile keeps each file's tests in one process. --durations shows the slowest tests.
    PYTHONPATH="$(cd .. && pwd):$PWD" python -m pytest tests -q -p no:cacheprovider --timeout=300 \
      -n auto --dist loadfile --durations=40 \
      --continue-on-collection-errors --junitxml="$RUNNER_TEMP/junit.xml" || true
    python "$tools/junit_failures.py" "$RUNNER_TEMP/junit.xml" >> "$out" || fail "controller: pytest produced no report"
    ;;
  frontend)
    cd frontend
    npm ci --no-audit --no-fund || { fail "frontend: npm ci"; exit 0; }
    npx tsc --noEmit > "$RUNNER_TEMP/tsc.txt" 2>&1 || tsc_ids "frontend tsc" < "$RUNNER_TEMP/tsc.txt"
    npx vite build > "$RUNNER_TEMP/vite.txt" 2>&1 || { tail -40 "$RUNNER_TEMP/vite.txt"; fail "frontend: vite build"; }
    ;;
  hygiene)
    pwsh -NoProfile -File scripts/p12_secret_scan.ps1 -Root "$PWD" || fail "hygiene: P12 secret scan"
    ;;
  *) echo "unknown suite $suite" >&2; exit 2 ;;
esac
echo "== $suite failures: $(wc -l < "$out")"
