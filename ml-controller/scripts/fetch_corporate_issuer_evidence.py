"""Fetch and seal MOPS issuer documents for the research corporate-history compile.

Read-only against MOPS: the existing public company-law notice feed
(`fetch_mops_delivery_announcements`, t146sb10 -> t59sb09), queried back to
--history-start. One paced connection with a hard request budget; nothing goes
to GCS, D1 or KV. Each symbol is sealed once as OUT_DIR/issuer/<symbol>.json
with the clock taken before its first request, so a rerun resumes and never
replaces a sealed file.

The documents are sources for `extract_reviewed_corporate_rules.py`, which
cites them as spec `extra_sources`. They are not spec `issuer_evidence`: that
path runs the live Paper parser, whose unlinked cash/subscription revisions
add blockers that reviewed rules cannot clear.

Run from ml-controller:
  python scripts/fetch_corporate_issuer_evidence.py OUT_DIR --symbols symbols.json [--dry-run]
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ISSUER_DIR = 'issuer'
DATASET = 'mops.t146sb10.t59sb09'
SYMBOL = re.compile(r'[1-9][0-9A-Za-z]{3,7}')
RATE_MARKERS = ('Too many query requests', 'Overrun -', '查詢過於頻繁')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _symbols(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, list) or not data or any(not isinstance(s, str) or not SYMBOL.fullmatch(s) for s in data):
        raise SystemExit(f'symbols must be a non-empty JSON list of company symbols: {path}')
    return sorted(set(data))


def evidence_path(out: Path, symbol: str) -> Path:
    return out / ISSUER_DIR / f'{symbol}.json'


class RequestBudgetExhausted(RuntimeError):
    pass


def paced_client(*, pace_seconds: float, max_requests: int, log: list, transport=None, sleep=time.sleep,
                 monotonic=time.monotonic):
    """One connection; at most one request per pace_seconds and max_requests in total."""
    import httpx
    state = {'last': None, 'count': 0}
    inner = transport or httpx.HTTPTransport()

    class Paced(httpx.BaseTransport):
        def handle_request(self, request):
            if state['count'] >= max_requests:
                raise RequestBudgetExhausted('mops_request_budget_exhausted')
            if state['last'] is not None:
                wait = pace_seconds - (monotonic() - state['last'])
                if wait > 0:
                    sleep(wait)
            state['count'] += 1
            started = monotonic()
            response = inner.handle_request(request)
            response.read()
            state['last'] = monotonic()
            log.append({'n': state['count'], 'path': request.url.path, 'status': response.status_code,
                        'elapsed_s': round(state['last'] - started, 3),
                        'rate_limited': any(m in response.text for m in RATE_MARKERS)})
            return response

    return httpx.Client(transport=Paced(), timeout=30, follow_redirects=False), state


def fetch(out: Path, symbols: list[str], *, history_start: str, pace_seconds: float, max_requests: int,
          reader=None, transport=None, clock=_now, sleep=time.sleep) -> dict:
    """Seal every unsealed symbol; one symbol's failure is reported, never sealed."""
    from services.mops_corporate_terms import fetch_mops_delivery_announcements
    reader = reader or fetch_mops_delivery_announcements
    (out / ISSUER_DIR).mkdir(parents=True, exist_ok=True)
    log, results = [], {}
    client, state = paced_client(pace_seconds=pace_seconds, max_requests=max_requests, log=log,
                                 transport=transport, sleep=sleep)
    with client:
        for symbol in symbols:
            path = evidence_path(out, symbol)
            if path.exists():
                results[symbol] = {'status': 'already_sealed'}
                continue
            before, fetched_at = state['count'], clock()
            try:
                evidence = reader(symbol=symbol, client=client, history_start=history_start)
            except RequestBudgetExhausted:
                results[symbol] = {'status': 'budget_exhausted'}
                break
            except Exception as exc:  # reported per symbol; the run continues
                results[symbol] = {'status': 'error', 'error': f'{type(exc).__name__}:{str(exc)[:200]}',
                                   'requests': state['count'] - before}
                continue
            raw = json.dumps(evidence, ensure_ascii=False, sort_keys=True).encode('utf-8')
            with open(path, 'xb') as handle:  # sealed once
                handle.write(raw)
            results[symbol] = {'status': 'sealed', 'dataset': f'{DATASET}:{symbol}',
                               'path': f'{ISSUER_DIR}/{symbol}.json', 'fetched_at': fetched_at,
                               'sha256': hashlib.sha256(raw).hexdigest(), 'documents': len(evidence['documents']),
                               'query_start': evidence['query_start'], 'query_end': evidence['query_end'],
                               'requests': state['count'] - before}
    counts = {}
    for item in results.values():
        counts[item['status']] = counts.get(item['status'], 0) + 1
    report = {'history_start': history_start, 'pace_seconds': pace_seconds, 'max_requests': max_requests,
              'requests': state['count'], 'rate_limited_responses': sum(r['rate_limited'] for r in log),
              'status_counts': counts, 'symbols': results, 'finished_at': clock()}
    name = f'fetch_report_{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}.json'
    (out / ISSUER_DIR / name).write_text(json.dumps({**report, 'request_log': log}, ensure_ascii=False, indent=2),
                                         encoding='utf-8')
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('out_dir', type=Path)
    parser.add_argument('--symbols', type=Path, required=True, help='JSON list of company symbols')
    parser.add_argument('--history-start', default='2024-06-01')
    parser.add_argument('--pace-seconds', type=float, default=3.0)
    parser.add_argument('--max-requests', type=int, default=50)
    parser.add_argument('--dry-run', action='store_true', help='list symbols to fetch; no network')
    args = parser.parse_args(argv)
    date.fromisoformat(args.history_start)
    if args.pace_seconds < 3.0:
        raise SystemExit('pace below 3 s is unmeasured against MOPS throttling')
    out = args.out_dir.resolve()
    symbols = _symbols(args.symbols)
    pending = [s for s in symbols if not evidence_path(out, s).exists()]
    if args.dry_run:
        print(json.dumps({'dry_run': True, 'out_dir': str(out), 'symbols': len(symbols), 'pending': pending,
                          'history_start': args.history_start, 'max_requests': args.max_requests}, indent=2))
        return 0
    report = fetch(out, pending, history_start=args.history_start, pace_seconds=args.pace_seconds,
                   max_requests=args.max_requests)
    print(json.dumps({k: v for k, v in report.items() if k != 'symbols'}, ensure_ascii=False, indent=2))
    return 0 if set(report['status_counts']) <= {'sealed', 'already_sealed'} else 5


if __name__ == '__main__':
    raise SystemExit(main())
