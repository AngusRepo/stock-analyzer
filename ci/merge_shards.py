"""Merge controller shard artifacts into the per-side layout the gate reads.

usage: merge_shards.py <artifacts-dir> <shards>

failures-controller-<k>-<side>/failures.txt (k = 1..shards) -> failures-controller-<side>/failures.txt.
A side is merged only when every shard reported; otherwise it is left absent, which the gate
treats as "did not run" for head (blocking) and as an empty baseline for base.
"""
import sys
from pathlib import Path

root, shards = Path(sys.argv[1]), int(sys.argv[2])
for side in ('head', 'base'):
    parts = [root / f'failures-controller-{k}-{side}' / 'failures.txt' for k in range(1, shards + 1)]
    missing = [p.parent.name for p in parts if not p.exists()]
    if missing:
        print(f'{side}: missing {", ".join(missing)}; not merged')
        continue
    ids = sorted({l.strip() for p in parts for l in p.read_text(encoding='utf-8').splitlines() if l.strip()})
    out = root / f'failures-controller-{side}'
    out.mkdir(exist_ok=True)
    (out / 'failures.txt').write_text(''.join(i + '\n' for i in ids), encoding='utf-8')
    print(f'{side}: {len(ids)} failures from {shards} shards')
