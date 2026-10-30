"""Fetch and seal the raw sources for the research corporate-history compile.

Read-only against vendors: seven FinLab `data.get` calls (fresh, no SDK cache)
and one public TWSE `/rwd/api/codeEtf` call. Nothing goes to GCS, D1, KV or
Modal. Each source is written once under OUT_DIR with its sha256 and the clock
taken before its request (the conservative fetch time), then a spec.json that
`compile_corporate_history.py` reads.

FinLab auth comes only from the environment, the same names the SDK login
helper uses: FINLAB_API_KEY, FINLAB_REFRESH_TOKEN, FINLAB_SESSION_ID
(session auth), or FINLAB_API_KEY alone (legacy token). Values are never
printed or written.

OUT_DIR must already hold days.json (exchange sessions) and universe.json
(TWSE/OTC symbols), unless --days / --universe name other files.

Run from ml-controller:
  python scripts/fetch_corporate_history_sources.py OUT_DIR [--dry-run]
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.finlab_auth import FINLAB_SESSION_ENV_NAMES, finlab_session_auth_available

# spec dataset name -> (FinLab key, local file, table shape)
FINLAB_SOURCES = (
    ('finlab.dividend_announcement', 'dividend_announcement', 'dividend_announcement.parquet', 'long'),
    ('finlab.capital_reduction_tse:恢復買賣日期', 'capital_reduction_tse:恢復買賣日期',
     'capital_reduction_tse__resume.parquet', 'wide'),
    ('finlab.capital_reduction_otc:恢復買賣日期', 'capital_reduction_otc:恢復買賣日期',
     'capital_reduction_otc__resume.parquet', 'wide'),
    ('finlab.par_value_change_tse:恢復買賣日期', 'par_value_change_tse:恢復買賣日期',
     'par_value_change_tse__resume.parquet', 'wide'),
    ('finlab.par_value_change_otc:恢復買賣日期', 'par_value_change_otc:恢復買賣日期',
     'par_value_change_otc__resume.parquet', 'wide'),
    ('finlab.tw_etf_dividend_events', 'tw_etf_dividend_events', 'tw_etf_dividend_events.parquet', 'long'),
    ('finlab.etf_split:恢復買賣日期', 'etf_split:恢復買賣日期', 'etf_split__resume.parquet', 'wide'),
)
ETF_REGISTRY = ('official.etf_registry', 'https://www.twse.com.tw/rwd/api/codeEtf', 'etf_registry.json')
SPEC_NAME = 'spec.json'
REPORT_NAME = 'fetch_report.json'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _targets(out: Path) -> list[Path]:
    return [out / name for _, _, name, _ in FINLAB_SOURCES] + [out / ETF_REGISTRY[2], out / SPEC_NAME, out / REPORT_NAME]


def _scope_file(path: Path, name: str) -> list[str]:
    if not path.is_file():
        raise SystemExit(f'{name} not found: {path} (JSON list required before fetching)')
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, list) or not data or any(not isinstance(x, str) for x in data):
        raise SystemExit(f'{name} must be a non-empty JSON list of strings: {path}')
    return data


def _auth_mode(env=os.environ) -> str:
    if finlab_session_auth_available(env):
        return 'session'
    present = [name for name in FINLAB_SESSION_ENV_NAMES if str(env.get(name) or '').strip()]
    if present == ['FINLAB_API_KEY']:
        return 'legacy_api_token'
    raise SystemExit('FinLab auth missing: set FINLAB_API_KEY, FINLAB_REFRESH_TOKEN and FINLAB_SESSION_ID '
                     '(or FINLAB_API_KEY alone for a legacy token) in this shell. '
                     f'Set now: {present or "none"}.')


def to_frame(raw, shape: str):
    """FinLab pandas -> polars, keeping every vendor row and column.

    Wide event catalogs carry the session in the index; it becomes `date`.
    """
    import pandas as pd
    import polars as pl
    frame = pd.DataFrame(raw)
    if shape == 'wide' and 'date' not in frame.columns:
        frame = frame.rename_axis('date').reset_index()
    frame.columns = [str(c) for c in frame.columns]
    result = pl.from_pandas(frame)
    if result.is_empty():
        raise ValueError('finlab_source_empty')
    return result


def _seal(path: Path, data: bytes) -> str:
    with open(path, 'xb') as handle:  # sealed sources are written once
        handle.write(data)
    return hashlib.sha256(data).hexdigest()


def fetch(out: Path, *, days_path: Path, universe_path: Path, finlab_get=None, login=None,
          http_get=None, clock=_now) -> dict:
    """Fetch, seal and describe every source. Injected callables are for tests."""
    days, universe = _scope_file(days_path, 'days'), _scope_file(universe_path, 'universe')
    existing = [str(p) for p in _targets(out) if p.exists()]
    if existing:
        raise SystemExit('refusing to overwrite sealed sources: ' + ', '.join(existing))
    auth = _auth_mode()
    if finlab_get is None or login is None:
        import finlab
        from finlab import data
        login = login or finlab.login
        finlab_get = finlab_get or (lambda key: data.get(key, force_download=True, save_to_storage=False))
    from services.finlab_auth import login_finlab_sdk
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        login_finlab_sdk(login)  # SDK chatter is dropped so nothing credential-shaped reaches the log
    # Everything is fetched into memory first; files are sealed only after the last call
    # succeeds, so a failed run leaves OUT_DIR untouched and can simply be rerun.
    blobs, sources, report = {}, {}, {'auth_mode': auth, 'finlab_calls': 0, 'twse_calls': 0, 'sources': {}}
    for dataset, key, name, shape in FINLAB_SOURCES:
        fetched_at = clock()
        report['finlab_calls'] += 1
        frame = to_frame(finlab_get(key), shape)
        buffer = io.BytesIO()
        frame.write_parquet(buffer)
        blobs[name] = buffer.getvalue()
        sources[dataset] = {'path': name, 'fetched_at': fetched_at, 'sha256': hashlib.sha256(blobs[name]).hexdigest()}
        report['sources'][dataset] = {'rows': frame.height, 'columns': frame.width, 'returned_at': clock()}
    if http_get is None:
        import httpx

        def http_get(url):
            with httpx.Client(timeout=25, follow_redirects=False) as client:
                response = client.get(url)
                response.raise_for_status()
                return response.content
    dataset, url, name = ETF_REGISTRY
    fetched_at = clock()
    report['twse_calls'] += 1
    body = http_get(url)
    registry = json.loads(body.decode('utf-8'))
    if not isinstance(registry, list) or not registry or any(not isinstance(s, str) for s in registry):
        raise ValueError('etf_registry_invalid')
    blobs[name] = body
    sources[dataset] = {'path': name, 'fetched_at': fetched_at, 'sha256': hashlib.sha256(body).hexdigest()}
    report['sources'][dataset] = {'symbols': len(registry), 'returned_at': clock()}
    for name, data in blobs.items():
        _seal(out / name, data)
    captured_at = clock()
    spec = {'days': os.path.relpath(days_path, out), 'universe': os.path.relpath(universe_path, out),
            'sources': sources, 'issuer_evidence': {}, 'cash_rounding_rules': [],
            'reviewed_stock_rules': [], 'captured_at': captured_at}
    _seal(out / SPEC_NAME, json.dumps(spec, ensure_ascii=False, indent=2).encode('utf-8'))
    report.update(days=len(days), last_day=max(days), universe=len(universe), captured_at=captured_at,
                  spec=str(out / SPEC_NAME))
    _seal(out / REPORT_NAME, json.dumps(report, ensure_ascii=False, indent=2).encode('utf-8'))
    return report


def plan(out: Path, *, days_path: Path, universe_path: Path) -> dict:
    return {'dry_run': True, 'out_dir': str(out),
            'finlab_calls': [{'dataset': d, 'finlab_key': k, 'output': str(out / n)} for d, k, n, _ in FINLAB_SOURCES],
            'twse_calls': [{'dataset': ETF_REGISTRY[0], 'url': ETF_REGISTRY[1], 'output': str(out / ETF_REGISTRY[2])}],
            'days': {'path': str(days_path), 'present': days_path.is_file()},
            'universe': {'path': str(universe_path), 'present': universe_path.is_file()},
            'already_present': [str(p) for p in _targets(out) if p.exists()],
            'auth_env_set': [n for n in FINLAB_SESSION_ENV_NAMES if str(os.environ.get(n) or '').strip()],
            'spec': str(out / SPEC_NAME)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('out_dir', type=Path)
    parser.add_argument('--days', type=Path, default=None)
    parser.add_argument('--universe', type=Path, default=None)
    parser.add_argument('--dry-run', action='store_true', help='list calls and outputs; no network')
    args = parser.parse_args(argv)
    out = args.out_dir.resolve()
    days_path = (args.days or out / 'days.json').resolve()
    universe_path = (args.universe or out / 'universe.json').resolve()
    if args.dry_run:
        print(json.dumps(plan(out, days_path=days_path, universe_path=universe_path), ensure_ascii=False, indent=2))
        return 0
    out.mkdir(parents=True, exist_ok=True)
    print(json.dumps(fetch(out, days_path=days_path, universe_path=universe_path), ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
