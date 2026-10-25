"""Pack main's head failure lists so a later run whose base is this commit can reuse them.

usage: base_cache.py <artifacts-dir> <out-dir> <suite> ...

Writes <out-dir>/failures-<suite>.txt for every suite, minus ids that passed on rerun (flaky:
cached, they would hide a real regression of that test in every later PR). Writes nothing when
a list is missing or holds an infrastructure failure: a base taken from a broken run turns every
pre-existing failure of that suite into a new one, and re-runs would restore it again.
"""
import re
import sys
from pathlib import Path

INFRA = re.compile(r': (npm ci|dependency install|shard assignment|.*produced no report)$')


def read(path):
    return [l.strip() for l in path.read_text(encoding='utf-8').splitlines() if l.strip()] if path.exists() else None


def main():
    root, out, suites = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
    flaky = set(read(root / 'flaky-controller' / 'flaky.txt') or [])
    lists = {}
    for suite in suites:
        ids = read(root / f'failures-{suite}-head' / 'failures.txt')
        if ids is None:
            print(f'{suite}: no head list; not cached')
            return
        infra = [i for i in ids if INFRA.search(i)]
        if infra:
            print(f'{suite}: infrastructure failure {infra[0]!r}; not cached')
            return
        lists[suite] = sorted(set(ids) - flaky)
    out.mkdir(parents=True, exist_ok=True)
    for suite, ids in lists.items():
        (out / f'failures-{suite}.txt').write_text(''.join(i + '\n' for i in ids), encoding='utf-8')
    print(f'cached {len(lists)} suites ({sum(map(len, lists.values()))} ids, {len(flaky)} flaky dropped)')


if __name__ == '__main__':
    main()
