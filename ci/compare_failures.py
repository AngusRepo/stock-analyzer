"""Gate: fail only on failures the head has and the base does not.

Input: a directory of downloaded artifacts failures-<suite>-<side>/failures.txt.
A missing head artifact means the suite did not run and fails the gate; a
missing base artifact is treated as an empty baseline (strictest choice).
"""
import os
import sys
from pathlib import Path

SUITES = ('worker', 'controller', 'frontend', 'hygiene')
root = Path(sys.argv[1])


def read(suite, side):
    path = root / f'failures-{suite}-{side}' / 'failures.txt'
    if not path.exists():
        return None
    return {line.strip() for line in path.read_text(encoding='utf-8').splitlines() if line.strip()}


lines, blocked = ['| suite | head failures | pre-existing | **new** | fixed |', '|---|---|---|---|---|'], False
details = []
for suite in SUITES:
    head, base = read(suite, 'head'), read(suite, 'base')
    if head is None:
        blocked = True
        lines.append(f'| {suite} | did not run | - | **blocked** | - |')
        continue
    base = base or set()
    new, fixed = sorted(head - base), sorted(base - head)
    blocked |= bool(new)
    lines.append(f'| {suite} | {len(head)} | {len(head & base)} | **{len(new)}** | {len(fixed)} |')
    if new:
        details.append(f'### {suite}: new failures\n' + '\n'.join(f'- `{n}`' for n in new))
    if fixed:
        details.append(f'### {suite}: fixed\n' + '\n'.join(f'- `{f}`' for f in fixed))

report = '\n'.join(['## CI gate: ' + ('❌ new failures' if blocked else '✅ no new failures'), '', *lines, '', *details])
print(report)
summary = os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary, 'a', encoding='utf-8') as fh:
        fh.write(report + '\n')
sys.exit(1 if blocked else 0)
