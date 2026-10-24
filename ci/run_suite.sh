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
    source "$tools/controller_deps.sh"
    controller_deps || { fail "controller: dependency install"; exit 0; }
    cd ml-controller
    # Tests import both repo-root `tools` and `tests.*`; a broken module must not hide the rest.
    # One worker per core, tests spread individually: several 4-5 minute tests share files,
    # so loadfile left one worker running them in sequence. --durations shows the slowest tests.
    PYTHONPATH="$(cd .. && pwd):$PWD" python -m pytest tests -q -p no:cacheprovider --timeout=300 \
      -n auto --dist load --durations=40 \
      --continue-on-collection-errors --junitxml="$RUNNER_TEMP/junit.xml" || true
    python "$tools/junit_failures.py" "$RUNNER_TEMP/junit.xml" >> "$out" || fail "controller: pytest produced no report"
    # Worker tests that drive controller Python skip in the worker suite (no pip deps there).
    # Run here the ones pytest does not already spawn with its own fixture.
    cd ../worker
    mapfile -t pyfiles < <(for f in $(grep -l 'NAV_TEST_PYTHON' src/lib/*.test.ts | sort); do
      grep -rqF "$(basename "$f")" ../ml-controller/tests || echo "$f"; done)
    if [ "${#pyfiles[@]}" -gt 0 ]; then
      NAV_TEST_PYTHON="$(command -v python)" PYTHONPATH="$(cd .. && pwd):$(cd ../ml-controller && pwd)" \
        node --import tsx --test --test-concurrency=4 \
        --test-reporter=dot --test-reporter-destination=stdout \
        --test-reporter="$tools/node_failures_reporter.mjs" --test-reporter-destination="$RUNNER_TEMP/node-py-fail.txt" \
        "${pyfiles[@]}" || true
      [ -f "$RUNNER_TEMP/node-py-fail.txt" ] && sed 's/^worker: /controller worker-python: /' "$RUNNER_TEMP/node-py-fail.txt" | sort -u >> "$out" \
        || fail "controller: worker python tests produced no report"
    fi
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
