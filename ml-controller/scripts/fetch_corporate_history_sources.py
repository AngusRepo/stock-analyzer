"""Fetch and seal the raw sources for the research corporate-history compile.

Read-only against vendors: seven FinLab `data.get` calls (fresh, in-memory SDK
storage) and one public TWSE `/rwd/api/codeEtf` call. Nothing goes to GCS, D1
or KV. modal_fetch_corporate_history.py may run the FinLab half (collect_finlab)
in a one-off Modal app and seal its bytes here with seal_fetch. Each source is sealed once under OUT_DIR with its sha256 and the
clock taken before its request (the conservative fetch time), then a spec.json
that `compile_corporate_history.py` reads.

FinLab auth is the SDK's headless session, read only from the environment:
FINLAB_API_KEY, FINLAB_REFRESH_TOKEN and FINLAB_SESSION_ID. The session is
checked before any download; a rejected session stops with an error instead of
falling back to a browser login or a stored credential file. A free-tier
account is refused, because its shortened recent data would compile as "no
corporate action". Values are never printed or written.

OUT_DIR must already hold days.json (exchange sessions) and universe.json
(TWSE/OTC symbols), unless --days / --universe name other files; the spec
records their sha256 so a later edit is caught at compile time.

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
import shutil
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


def _scope_file(path: Path, name: str) -> tuple[list[str], str]:
    if not path.is_file():
        raise SystemExit(f'{name} not found: {path} (JSON list required before fetching)')
    raw = path.read_bytes()
    data = json.loads(raw.decode('utf-8'))
    if not isinstance(data, list) or not data or any(not isinstance(x, str) for x in data):
        raise SystemExit(f'{name} must be a non-empty JSON list of strings: {path}')
    return data, hashlib.sha256(raw).hexdigest()


def _require_session_env(env=os.environ) -> None:
    if not finlab_session_auth_available(env):
        present = [name for name in FINLAB_SESSION_ENV_NAMES if str(env.get(name) or '').strip()]
        raise SystemExit('FinLab session auth missing: set FINLAB_API_KEY, FINLAB_REFRESH_TOKEN and '
                         f'FINLAB_SESSION_ID in this shell (set now: {present or "none"}).')


@contextlib.contextmanager
def _quiet():
    """SDK chatter (quota lines, warnings) never reaches the operator log or the JSON report."""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield


def _refuse_login(*_args, **_kwargs):
    raise SystemExit('FinLab server rejected the env session: refresh FINLAB_REFRESH_TOKEN / FINLAB_SESSION_ID '
                     '(no browser login, no stored credential fallback).')


def _refuse_token_refresh(*_args, **_kwargs):
    raise SystemExit('finlab_token_expired: rerun with a fresh FINLAB_REFRESH_TOKEN / FINLAB_SESSION_ID')


def _refuse_session_write(*_args, **_kwargs):
    raise SystemExit('finlab_session_write_refused')


def harden_sdk() -> None:
    """No path of the SDK may log in, loop on a rejected session or persist credentials.

    A server-side rejection makes the SDK call finlab.login() (browser login or an
    unbounded retry); token_expired makes it save the session, env values included,
    to ~/.finlab/credentials.json and retry without bound. Both stop instead.
    """
    import finlab
    import finlab.auth as sdk_auth
    import finlab.data.auth as sdk_data_auth
    finlab.login = _refuse_login
    sdk_auth.save_session = _refuse_session_write
    sdk_data_auth._refresh_id_token = _refuse_token_refresh


def _sdk():
    """Real FinLab callables: env-session token check, fresh download, role."""
    from finlab import data
    from finlab.auth import get_id_token
    harden_sdk()
    data.set_storage(data.CacheStorage())  # in memory; FileStorage would cache on the system disk
    return get_id_token, (lambda key: data.get(key, force_download=True)), data.get_role


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


def _seal(path: Path, data: bytes) -> None:
    with open(path, 'xb') as handle:  # sealed sources are written once
        handle.write(data)


def collect_finlab(finlab_get, role_of, clock=_now) -> dict:
    """The seven FinLab downloads as parquet bytes, each with its pre-request clock.

    Runs locally or inside the one-off Modal entry; returns data only, never env values.
    """
    blobs, sources, described, role = {}, {}, {}, None
    for dataset, key, name, shape in FINLAB_SOURCES:
        fetched_at = clock()
        with _quiet():
            raw = finlab_get(key)
        role = role_of()
        if role in (None, 'free'):
            # A free account's recent rows are shortened: missing events would compile as "no action".
            raise SystemExit(f'finlab_role_insufficient:{role}')
        frame = to_frame(raw, shape)
        buffer = io.BytesIO()
        frame.write_parquet(buffer)
        blobs[name] = buffer.getvalue()
        sources[dataset] = {'path': name, 'fetched_at': fetched_at, 'sha256': hashlib.sha256(blobs[name]).hexdigest()}
        described[dataset] = {'rows': frame.height, 'columns': frame.width, 'returned_at': clock()}
    return {'blobs': blobs, 'sources': sources, 'described': described, 'role': role,
            'finlab_calls': len(FINLAB_SOURCES)}


def check_targets(out: Path, *, days_path: Path, universe_path: Path) -> None:
    """Everything that can fail without the network fails before it."""
    _scope_file(days_path, 'days')
    _scope_file(universe_path, 'universe')
    existing = [str(p) for p in _targets(out) if p.exists()]
    if existing:
        raise SystemExit('refusing to overwrite sealed sources: ' + ', '.join(existing))


def _default_http_get(url):
    import httpx
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.content


def seal_fetch(out: Path, finlab: dict, *, days_path: Path, universe_path: Path, auth_mode: str,
               http_get=None, clock=_now, report_extra: dict | None = None) -> dict:
    """Fetch the public ETF registry, then seal every source, the spec and the report."""
    days, days_sha = _scope_file(days_path, 'days')
    universe, universe_sha = _scope_file(universe_path, 'universe')
    check_targets(out, days_path=days_path, universe_path=universe_path)
    blobs, sources = dict(finlab['blobs']), dict(finlab['sources'])
    report = {'auth_mode': auth_mode, 'finlab_calls': finlab['finlab_calls'], 'twse_calls': 0,
              'finlab_role': finlab['role'], 'sources': dict(finlab['described']), **(report_extra or {})}
    dataset, url, name = ETF_REGISTRY
    fetched_at = clock()
    report['twse_calls'] += 1
    body = (http_get or _default_http_get)(url)
    registry = json.loads(body.decode('utf-8'))
    if not isinstance(registry, list) or not registry or any(not isinstance(s, str) for s in registry):
        raise ValueError('etf_registry_invalid')
    blobs[name] = body
    sources[dataset] = {'path': name, 'fetched_at': fetched_at, 'sha256': hashlib.sha256(body).hexdigest()}
    report['sources'][dataset] = {'symbols': len(registry), 'returned_at': clock()}
    captured_at = clock()
    spec = {'days': os.path.relpath(days_path, out), 'days_sha256': days_sha,
            'universe': os.path.relpath(universe_path, out), 'universe_sha256': universe_sha,
            'sources': sources, 'issuer_evidence': {}, 'cash_rounding_rules': [],
            'reviewed_stock_rules': [], 'captured_at': captured_at}
    report.update(days=len(days), last_day=max(days), universe=len(universe), captured_at=captured_at,
                  spec=str(out / SPEC_NAME))
    blobs[SPEC_NAME] = json.dumps(spec, ensure_ascii=False, indent=2).encode('utf-8')
    blobs[REPORT_NAME] = json.dumps(report, ensure_ascii=False, indent=2).encode('utf-8')
    # Stage in one hidden directory, then move into place: a crash while writing
    # leaves only the staging directory, never a half-sealed OUT_DIR.
    staging = out / f'.partial-{os.getpid()}'
    staging.mkdir()
    linked: list[Path] = []
    try:
        for name, data in blobs.items():
            _seal(staging / name, data)
        for name in blobs:
            os.link(staging / name, out / name)  # fails instead of replacing an existing file
            linked.append(out / name)
    except BaseException:
        for path in linked:  # never leave a half-sealed OUT_DIR behind
            path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return report


def fetch(out: Path, *, days_path: Path, universe_path: Path, sdk=None, http_get=None, clock=_now) -> dict:
    """Fetch, seal and describe every source. `sdk` and `http_get` are injected by tests."""
    check_targets(out, days_path=days_path, universe_path=universe_path)
    _require_session_env()
    id_token, finlab_get, role_of = sdk or _sdk()
    with _quiet():
        token = id_token()
    if not token:
        raise SystemExit('FinLab session rejected: refresh FINLAB_REFRESH_TOKEN / FINLAB_SESSION_ID '
                         '(no browser login, no stored credential fallback).')
    # Everything is fetched into memory first and sealed only after the last call
    # succeeds, so a failed run leaves OUT_DIR as it was and can simply be rerun.
    finlab = collect_finlab(finlab_get, role_of, clock)
    return seal_fetch(out, finlab, days_path=days_path, universe_path=universe_path, auth_mode='session_env',
                      http_get=http_get, clock=clock)


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
