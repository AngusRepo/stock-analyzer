"""Package a reviewed corporate-history compile spec as the weekly job's frozen baseline.

Local only: no network, no GCS/D1/KV. Reads the spec that produced the last reviewed
artifact (sealed calendar, reviewed MOPS rules, issuer bundle) and writes OUT_DIR with
baseline.json plus every cited extra source, each named by its object file name, and prints
baseline.json's sha256. The pin (ml-controller/services/corporate_history_baseline.json:
object under $GCS_BUCKET_NAME + sha256) ships by PR; the operator (M1-c) uploads OUT_DIR to
that object's prefix. The spec's universe is not kept: the weekly job recomputes it.

Run from ml-controller:
  python scripts/build_corporate_history_baseline.py SPEC --out OUT_DIR --baseline-id ID
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.corporate_history_weekly import BASELINE_SCHEMA  # noqa: E402

RULE_FIELDS = ('reviewed_stock_rules', 'reviewed_subscription_rules', 'cash_rounding_rules')


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _resolve(base: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else base / path


def _rules(base: Path, value, name: str) -> list:
    if isinstance(value, str):  # the compiler also accepts a file path for a rule list
        value = json.loads(_resolve(base, value).read_text(encoding='utf-8'))
    if not isinstance(value, list):
        raise SystemExit(f'baseline_{name}_not_a_list')
    return value


def build(spec_path: Path, out: Path, *, baseline_id: str) -> dict:
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    base = spec_path.resolve().parent
    if spec.get('issuer_evidence'):
        # The weekly compile only carries the reviewed rules and extra sources; never drop evidence silently.
        raise SystemExit('baseline_issuer_evidence_not_supported')
    if isinstance(spec['days'], list):
        days = sorted(spec['days'])
    else:
        raw_days = _resolve(base, spec['days']).read_bytes()
        if spec.get('days_sha256') and _sha256(raw_days) != spec['days_sha256']:
            raise SystemExit('baseline_days_sha256_mismatch')
        days = sorted(json.loads(raw_days))
    out.mkdir(parents=True, exist_ok=False)
    extras = []
    for entry in spec.get('extra_sources') or []:
        source = _resolve(base, entry['path'])
        raw = source.read_bytes()
        if entry.get('sha256') and _sha256(raw) != entry['sha256']:
            raise SystemExit('baseline_extra_source_sha256_mismatch:' + source.name)
        if any(e['object'] == source.name for e in extras):
            raise SystemExit('baseline_extra_source_name_collision:' + source.name)
        (out / source.name).write_bytes(raw)
        extras.append({'dataset': entry['dataset'], 'object': source.name, 'fetched_at': entry['fetched_at'],
                       'sha256': _sha256(raw)})
    baseline = {'schema_version': BASELINE_SCHEMA, 'baseline_id': baseline_id,
                'source_spec_sha256': _sha256(spec_path.read_bytes()),
                'history_start': days[0], 'days': days, 'days_sha256': _sha256(json.dumps(days).encode()),
                **{name: _rules(base, spec.get(name) or [], name) for name in RULE_FIELDS},
                'extra_sources': extras}
    (out / 'baseline.json').write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'baseline_id': baseline_id, 'out': str(out), 'baseline_sha256': _sha256((out / 'baseline.json').read_bytes()), 'history_start': days[0], 'baseline_end': days[-1],
            'sessions': len(days), **{name: len(baseline[name]) for name in RULE_FIELDS},
            'objects': ['baseline.json', *(e['object'] for e in extras)]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('spec', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--baseline-id', required=True)
    args = parser.parse_args(argv)
    print(json.dumps(build(args.spec, args.out, baseline_id=args.baseline_id), ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
