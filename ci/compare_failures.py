"""Gate: fail on failures the head has and the base does not, and on any head failure
inside the P9 scope.

usage: compare_failures.py <artifacts-dir> <scripts/p9_gate.ps1> [<main-cache-dir> <main-label>]

Input: a directory of downloaded artifacts failures-<suite>-<side>/failures.txt.
A missing head artifact means the suite did not run and fails the gate; a
missing base artifact is treated as an empty baseline (strictest choice).

P9 scope = what scripts/p9_gate.ps1 runs on Windows: the worker, frontend and hygiene
suites, the worker tests that drive controller Python, and the controller test files the
script names. There a failure blocks even when the base has it too. The script stays the
owner of the controller file list; a list that cannot be read blocks the gate.

For a PR stacked on another PR's branch, main's cached lists (ci/base_cache.py layout,
controller shards separate) add an informational "vs main" section: failures the head
inherits from its stack base would be new once the stack is cut against main. It never
changes the exit code.
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
main_dir, main_label = (Path(sys.argv[3]), sys.argv[4]) if len(sys.argv) > 4 else (None, '')


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


def read_rerun(suite, kind):
    """Head-only failures that passed when rerun (flaky) or also failed on the base (stale),
    written by ci/rerun_new_failures.py."""
    path = root / f'{kind}-{suite}' / f'{kind}.txt'
    return {l.strip() for l in path.read_text(encoding='utf-8').splitlines() if l.strip()} if path.exists() else set()


def read_flaky(suite):
    return read_rerun(suite, 'flaky')


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
    stale = (head - base - flaky) & read_rerun(suite, 'stale')
    new, fixed = sorted(head - base - flaky - stale), sorted(base - head)
    # Pre-existing failures (stale ones included) inside the P9 scope; new ones are already counted above.
    p9 = sorted(f for f in (head & base) | stale if in_p9_scope(suite, f))
    blocked |= bool(new) or bool(p9)
    lines.append(f'| {suite} | {len(head)} | {len(head & base) + len(stale)} | **{len(new)}** | **{len(p9)}** | {len(flaky)} | {len(fixed)} |')
    if new:
        details.append(f'### {suite}: new failures\n' + '\n'.join(item(n) for n in new))
    if p9:
        details.append(f'### {suite}: failures in the P9 scope (also on base; blocking)\n' + '\n'.join(item(n) for n in p9))
    if stale:
        details.append(f'### {suite}: pre-existing, missing from the cached base list (also fail on the base now; not blocking)\n'
                       + '\n'.join(f'- `{s}`' for s in sorted(stale)))
    if flaky:
        details.append(f'### {suite}: flaky (failed on head, passed on rerun; not blocking)\n'
                       + '\n'.join(f'- `{f}`' for f in sorted(flaky)))
    if fixed:
        details.append(f'### {suite}: fixed\n' + '\n'.join(f'- `{f}`' for f in fixed))

def read_main(suite):
    """main's cached list for a suite; controller is the union of its shard lists."""
    paths = sorted(main_dir.glob('failures-controller-*.txt')) if suite == 'controller' else [main_dir / f'failures-{suite}.txt']
    if not paths or not all(p.exists() for p in paths):
        return None
    return {l.strip() for p in paths for l in p.read_text(encoding='utf-8').splitlines() if l.strip()}


def main_section():
    title = f'## vs main {main_label} (informational, not blocking)'
    if not main_dir.is_dir():
        return [title, '', 'No cached failure lists for main; nothing to compare.']
    rows = ['| suite | new vs main | of which inherited from the stack base |', '|---|---|---|']
    notes = []
    for suite in SUITES:
        head, ref = read(suite, 'head'), read_main(suite)
        if head is None or ref is None:
            rows.append(f'| {suite} | - | - |')
            continue
        new_vs_main = head - ref - read_flaky(suite) - read_rerun(suite, 'stale')
        inherited = sorted(new_vs_main & (read(suite, 'base') or set()))
        rows.append(f'| {suite} | {len(new_vs_main)} | {len(inherited)} |')
        if inherited:
            notes.append(f'### {suite}: inherited from the stack base, new against main\n'
                         + '\n'.join(f'- `{i}`' for i in inherited))
    return [title, '', *rows, '', *notes]


def safe_main_section():
    """Informational only: whatever goes wrong here must not touch the gate's verdict or report."""
    try:
        return main_section()
    except Exception as error:
        return [f'## vs main {main_label} (informational, not blocking)', '', f'Not compared: {error!r}'[:300]]


report = '\n'.join(['## CI gate: ' + ('❌ blocked' if blocked else '✅ no new failures, P9 scope clean'), '', *lines, '', *details,
                    *(['', *safe_main_section()] if main_dir else [])])
print(report)
summary = os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary, 'a', encoding='utf-8') as fh:
        fh.write(report + '\n')
sys.exit(1 if blocked else 0)
