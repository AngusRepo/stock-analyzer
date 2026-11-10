"""Gate: fail on failures the head has and the base does not, and on any head failure
inside the P9 scope.

usage: compare_failures.py <artifacts-dir> <scripts/p9_gate.ps1>

Input: a directory of downloaded artifacts failures-<suite>-<side>/failures.txt.
A missing head artifact means the suite did not run and fails the gate; a
missing base artifact is treated as an empty baseline (strictest choice).

P9 scope = what scripts/p9_gate.ps1 runs on Windows: the worker, frontend and hygiene
suites, the worker tests that drive controller Python, and the controller test files the
script names. There a failure blocks even when the base has it too. The script stays the
owner of the controller file list; a list that cannot be read blocks the gate.
"""
import os
import re
import sys
from pathlib import Path

SUITES = ('worker', 'controller', 'frontend', 'hygiene')
root = Path(sys.argv[1])
p9_script = Path(sys.argv[2]) if len(sys.argv) > 2 else None
p9_modules = set(re.findall(r'tests\\(test_\w+)\.py', p9_script.read_text(encoding='utf-8'))) \
    if p9_script and p9_script.exists() else set()


def in_p9_scope(suite, failure):
    """Controller ids outside the P9 file list keep the head-vs-base rule; an id without a
    test module (dependency install, missing report) is in scope."""
    if suite != 'controller' or not failure.startswith('controller: '):
        return True
    module = re.search(r'\btest_\w+', failure)
    return module is None or module.group(0) in p9_modules


def read(suite, side):
    path = root / f'failures-{suite}-{side}' / 'failures.txt'
    if not path.exists():
        return None
    return {line.strip() for line in path.read_text(encoding='utf-8').splitlines() if line.strip()}


def read_flaky(suite):
    """Head-only failures that passed when rerun (written by ci/rerun_new_failures.py)."""
    path = root / f'flaky-{suite}' / 'flaky.txt'
    return {l.strip() for l in path.read_text(encoding='utf-8').splitlines() if l.strip()} if path.exists() else set()


# Fails whenever native identity inputs change without a re-pin; still blocking (main must keep
# building), but labelled so it reads as "re-pin needed" (the native-identity check says what).
REPIN = {'controller: tests.test_native_storage_equivalence::test_exact_running_behavior_release_retains_separate_identity'}


def item(n):
    return f'- `{n}`' + (' (re-pin needed: see the native-identity check)' if n in REPIN else '')


lines = ['| suite | head failures | pre-existing | **new** | **P9 scope** | flaky | fixed |', '|---|---|---|---|---|---|---|']
blocked, details = not p9_modules, []
if not p9_modules:
    details.append(f'### P9 scope: no controller test files read from `{p9_script}`')
for suite in SUITES:
    head, base = read(suite, 'head'), read(suite, 'base')
    if head is None:
        blocked = True
        lines.append(f'| {suite} | did not run | - | **blocked** | - | - | - |')
        continue
    base = base or set()
    flaky = (head - base) & read_flaky(suite)
    new, fixed = sorted(head - base - flaky), sorted(base - head)
    # Pre-existing failures inside the P9 scope; new ones are already counted above.
    p9 = sorted(f for f in head & base if in_p9_scope(suite, f))
    blocked |= bool(new) or bool(p9)
    lines.append(f'| {suite} | {len(head)} | {len(head & base)} | **{len(new)}** | **{len(p9)}** | {len(flaky)} | {len(fixed)} |')
    if new:
        details.append(f'### {suite}: new failures\n' + '\n'.join(item(n) for n in new))
    if p9:
        details.append(f'### {suite}: failures in the P9 scope (also on base; blocking)\n' + '\n'.join(item(n) for n in p9))
    if flaky:
        details.append(f'### {suite}: flaky (failed on head, passed on rerun; not blocking)\n'
                       + '\n'.join(f'- `{f}`' for f in sorted(flaky)))
    if fixed:
        details.append(f'### {suite}: fixed\n' + '\n'.join(f'- `{f}`' for f in fixed))

report = '\n'.join(['## CI gate: ' + ('❌ blocked' if blocked else '✅ no new failures, P9 scope clean'), '', *lines, '', *details])
print(report)
summary = os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary, 'a', encoding='utf-8') as fh:
        fh.write(report + '\n')
sys.exit(1 if blocked else 0)
