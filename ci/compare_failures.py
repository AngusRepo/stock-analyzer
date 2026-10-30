"""Gate: fail only on failures the head has and the base does not.

usage: compare_failures.py <artifacts-dir> [<main-cache-dir> <main-label>]

Input: a directory of downloaded artifacts failures-<suite>-<side>/failures.txt.
A missing head artifact means the suite did not run and fails the gate; a
missing base artifact is treated as an empty baseline (strictest choice).
For a PR stacked on another PR's branch, main's cached lists (ci/base_cache.py layout,
controller shards separate) add an informational "vs main" section: failures the head
inherits from its stack base would be new once the stack is cut against main. It never
changes the exit code.
"""
import os
import sys
from pathlib import Path

SUITES = ('worker', 'controller', 'frontend', 'hygiene')
root = Path(sys.argv[1])
main_dir, main_label = (Path(sys.argv[2]), sys.argv[3]) if len(sys.argv) > 3 else (None, '')


def read(suite, side):
    path = root / f'failures-{suite}-{side}' / 'failures.txt'
    if not path.exists():
        return None
    return {line.strip() for line in path.read_text(encoding='utf-8').splitlines() if line.strip()}


def read_flaky(suite):
    """Head-only failures that passed when rerun (written by ci/rerun_new_failures.py)."""
    path = root / f'flaky-{suite}' / 'flaky.txt'
    return {l.strip() for l in path.read_text(encoding='utf-8').splitlines() if l.strip()} if path.exists() else set()


lines = ['| suite | head failures | pre-existing | **new** | flaky | fixed |', '|---|---|---|---|---|---|']
blocked, details = False, []
for suite in SUITES:
    head, base = read(suite, 'head'), read(suite, 'base')
    if head is None:
        blocked = True
        lines.append(f'| {suite} | did not run | - | **blocked** | - | - |')
        continue
    base = base or set()
    flaky = (head - base) & read_flaky(suite)
    new, fixed = sorted(head - base - flaky), sorted(base - head)
    blocked |= bool(new)
    lines.append(f'| {suite} | {len(head)} | {len(head & base)} | **{len(new)}** | {len(flaky)} | {len(fixed)} |')
    if new:
        details.append(f'### {suite}: new failures\n' + '\n'.join(f'- `{n}`' for n in new))
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
        new_vs_main = head - ref - read_flaky(suite)
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


report = '\n'.join(['## CI gate: ' + ('❌ new failures' if blocked else '✅ no new failures'), '', *lines, '', *details,
                    *(['', *safe_main_section()] if main_dir else [])])
print(report)
summary = os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary, 'a', encoding='utf-8') as fh:
        fh.write(report + '\n')
sys.exit(1 if blocked else 0)
