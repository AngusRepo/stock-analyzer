"""Print the controller test files of one CI shard, one path per line (relative to ml-controller).

usage: shard_controller.py <shard 1..N> <N>

Files are packed longest-first onto the lightest shard using the seconds recorded in
ci/controller_durations.json (refresh it with ci/controller_durations.py from the junit
artifacts of a main run). A file without a record weighs the median, so new tests still
land somewhere and every file is in exactly one shard.
"""
import json
import statistics
import sys
from pathlib import Path

shard, total = int(sys.argv[1]), int(sys.argv[2])
if not 1 <= shard <= total:
    raise SystemExit(f'shard {shard} not in 1..{total}')
tests = Path('tests')
files = sorted(p.as_posix() for p in tests.glob('test_*.py'))
recorded_path = Path(__file__).with_name('controller_durations.json')
recorded = json.loads(recorded_path.read_text(encoding='utf-8')) if recorded_path.exists() else {}
default = statistics.median(recorded.values()) if recorded else 1.0
weight = {f: float(recorded.get(f, default)) for f in files}

loads = [0.0] * total
owner = {}
# Ties break on the path so every runner computes the same partition.
for f in sorted(files, key=lambda f: (-weight[f], f)):
    k = min(range(total), key=lambda i: (loads[i], i))
    loads[k] += weight[f]
    owner[f] = k + 1
print('\n'.join(f for f in files if owner[f] == shard))
