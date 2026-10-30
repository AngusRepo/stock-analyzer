"""Compile the research corporate-history artifact from sealed local sources.

Local only: no download, no GCS/D1/KV write, no exporter run. Every input is a
file already on disk; each becomes a file:// source ref with its sha256 and
fetch clock, and is re-hashed before compilation. The output is the parquet
that `dataset_snapshot_exporter` accepts as `corporate_history_path`.

Spec (JSON):
  days            JSON list of trading sessions (the exchange calendar)
  universe        JSON list of symbols the research universe may hold
  sources         dataset -> {path, fetched_at} for finlab.dividend_announcement,
                  the four finlab company event catalogs, finlab.tw_etf_dividend_events,
                  finlab.etf_split:恢復買賣日期 and official.etf_registry
  issuer_evidence symbol -> {dataset, path, fetched_at}; reviewed issuer documents
  cash_rounding_rules / reviewed_stock_rules   optional JSON lists
  extra_sources   optional [{dataset, path, fetched_at}] cited by those rules
  captured_at     optional; defaults to now (the real retrieval clock)

Run from ml-controller:
  python scripts/compile_corporate_history.py SPEC --output history.parquet --target-end 2026-11-06
The JSON report goes to stdout: artifact sha256, covered window, the sessions
short of --target-end, and the blocked issuers by reason.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import polars as pl

from services.research_corporate_history import (
    COMPANY_EVENT_CATALOGS, load_history_tape, merge_history_frames, reconstruct_company_sessions,
    reconstruct_etf_sessions, validate_history_coverage, verify_local_sources,
)

TW = timezone(timedelta(hours=8))
COMPANY_SOURCES = ('finlab.dividend_announcement', *('finlab.' + key for key in COMPANY_EVENT_CATALOGS))
ETF_SOURCES = ('finlab.tw_etf_dividend_events', 'finlab.etf_split:恢復買賣日期', 'official.etf_registry')
COMPANY_SYMBOL = re.compile(r'[1-9][0-9A-Za-z]{3,7}')
ETF_SYMBOL = re.compile(r'0[0-9A-Za-z]{3,7}')


def _ref(dataset: str, entry: dict, base: Path) -> dict:
    path = (base / entry['path']).resolve()
    fetched = datetime.fromisoformat(str(entry['fetched_at']).replace('Z', '+00:00'))
    if fetched.tzinfo is None:
        raise ValueError('corporate_history_source_fetch_clock_timezone_missing:' + dataset)
    return {'dataset': dataset, 'uri': path.as_uri(), 'fetched_at': fetched.isoformat(),
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def _path(ref: dict) -> Path:
    from urllib.parse import unquote, urlparse
    return Path(unquote(urlparse(ref['uri']).path))


def _json_list(base: Path, value, name: str) -> list:
    data = json.loads((base / value).read_text(encoding='utf-8')) if isinstance(value, str) else value
    if not isinstance(data, list):
        raise ValueError('corporate_history_spec_list_required:' + name)
    return data


def _registry(path: Path) -> set[str]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, list) or not data or any(not isinstance(s, str) for s in data):
        raise ValueError('corporate_history_etf_registry_invalid')
    return set(data)


def compile_history(spec: dict, *, base: Path, captured_at: str | None = None):
    """Seal, verify and compile. Returns (frame, days, scoped symbols, unscoped symbols)."""
    sources = spec.get('sources') or {}
    missing = [name for name in (*COMPANY_SOURCES, *ETF_SOURCES) if name not in sources]
    if missing:
        raise ValueError('corporate_history_spec_sources_missing:' + ','.join(missing))
    refs = {name: _ref(name, sources[name], base) for name in (*COMPANY_SOURCES, *ETF_SOURCES)}
    issuer_refs = {symbol: _ref(e['dataset'], e, base) for symbol, e in (spec.get('issuer_evidence') or {}).items()}
    extra_refs = [_ref(e['dataset'], e, base) for e in spec.get('extra_sources') or []]
    all_refs = [*refs.values(), *issuer_refs.values(), *extra_refs]
    verify_local_sources(all_refs)
    captured = captured_at or spec.get('captured_at') or datetime.now(timezone.utc).isoformat()
    captured_day = datetime.fromisoformat(captured.replace('Z', '+00:00')).astimezone(TW).date().isoformat()
    # A session after the capture day cannot be reconstructed yet; it stays a named gap.
    days = sorted({d for d in _json_list(base, spec['days'], 'days') if d <= captured_day})
    universe = sorted(set(_json_list(base, spec['universe'], 'universe')))
    if not days or not universe:
        raise ValueError('corporate_history_spec_scope_empty')
    registry = _registry(_path(refs['official.etf_registry']))
    etf = sorted(s for s in universe if s in registry and ETF_SYMBOL.fullmatch(s))
    company = sorted(s for s in universe if s not in registry and COMPANY_SYMBOL.fullmatch(s))
    unscoped = sorted(set(universe) - set(etf) - set(company))

    company_refs = [refs[name] for name in COMPANY_SOURCES] + list(issuer_refs.values()) + extra_refs
    catalogs = {key: pl.read_parquet(_path(refs['finlab.' + key])) for key in COMPANY_EVENT_CATALOGS}
    issuer_evidence = {symbol: json.loads(_path(ref).read_text(encoding='utf-8')) for symbol, ref in issuer_refs.items()}
    frames = []
    if company:
        frames.append(reconstruct_company_sessions(
            pl.read_parquet(_path(refs['finlab.dividend_announcement'])), days=days, symbols=company,
            captured_at=captured, source_refs=company_refs, issuer_evidence=issuer_evidence,
            event_catalogs=catalogs,
            cash_rounding_rules=_json_list(base, spec.get('cash_rounding_rules') or [], 'cash_rounding_rules'),
            reviewed_stock_rules=_json_list(base, spec.get('reviewed_stock_rules') or [], 'reviewed_stock_rules')))
    if etf:
        rows = pl.read_parquet(_path(refs['finlab.tw_etf_dividend_events']))
        if 'symbol' not in rows.columns and 'stock_id' in rows.columns:
            rows = rows.rename({'stock_id': 'symbol'})
        frames.append(reconstruct_etf_sessions(
            rows, split_catalog=pl.read_parquet(_path(refs['finlab.etf_split:恢復買賣日期'])), days=days,
            symbols=etf, captured_at=captured, source_refs=[refs[name] for name in ETF_SOURCES]))
    if not frames:
        raise ValueError('corporate_history_spec_no_scoped_symbols')
    frame = merge_history_frames(*frames) if len(frames) > 1 else frames[0]
    validate_history_coverage(frame, days=days, symbols=[*company, *etf])
    return frame, days, [*company, *etf], unscoped


def gap_report(frame: pl.DataFrame, *, days: list[str], calendar: list[str], target_end: str | None) -> dict:
    tape = load_history_tape(frame)
    reasons, issuers = Counter(), set()
    for snap in tape.values():
        for symbol, items in snap['blockers'].items():
            issuers.add(symbol)
            reasons.update(item.split(':')[0] for item in items)
    short = sorted(d for d in calendar if days[-1] < d <= (target_end or days[-1]))
    return {'history_start': days[0], 'history_end': days[-1], 'sessions': len(days),
            'target_end': target_end, 'sessions_short_of_target': short,
            'target_end_reached': not target_end or days[-1] >= target_end,
            'blocked_issuers': len(issuers), 'blocker_reason_counts': dict(sorted(reasons.items()))}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('spec', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--target-end', default=None)
    args = parser.parse_args(argv)
    spec = json.loads(args.spec.read_text(encoding='utf-8'))
    base = args.spec.resolve().parent
    frame, days, scoped, unscoped = compile_history(spec, base=base)
    frame.write_parquet(args.output)
    report = gap_report(frame, days=days, calendar=sorted(_json_list(base, spec['days'], 'days')),
                        target_end=args.target_end)
    report.update(artifact=str(args.output.resolve()),
                  sha256=hashlib.sha256(args.output.read_bytes()).hexdigest(),
                  scoped_symbols=len(scoped), unscoped_symbols=unscoped)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
