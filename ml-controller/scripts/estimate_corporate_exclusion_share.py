"""Exclusion share per search window, from a compiled corporate-history artifact (local, no network).

Runs the production gate (research_corporate_preflight.exclude_history_blocked_symbols,
limit MAX_EXCLUDED_SYMBOL_SHARE) on a dataset whose universe is the D1 stock list the
fetch sealed (d1/stocks_raw.json) and whose sessions are the artifact's. Every listed
symbol gets a placeholder bar on each live session, so the denominator is the full
holdable universe the controller's get_universe_at would build (ETF gate included once
the branch carries it), not a search subset.

Windows are calendar days back from --end, as the searches choose them:
sltp / screener / l2 90 days, per_regime 365 days.

Exit 4 when any window's share is above the limit: stop and report, do not export.
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

STOP_EXIT = 4


def window_dataset(tape: dict, stocks: list[dict], start: str, end: str):
    import polars as pl
    from services import backtest_engine as engine
    days = sorted(d for d in tape if start <= d <= end)
    if not days:
        raise SystemExit(f'exclusion_window_has_no_sessions:{start}..{end}')
    rows, meta = [], []
    for stock in stocks:
        listed, delisted = stock.get('listed_date') or '0000', stock.get('delisted_date') or '9999'
        live = [d for d in days if listed <= d <= delisted]
        if not live:
            continue
        meta.append(stock)
        rows += [{'symbol': stock['symbol'], 'date': d, 'open': 1., 'high': 1., 'low': 1., 'close': 1.,
                  'volume': 1e6} for d in live]
    frame = pl.DataFrame({name: [m.get(name) for m in meta] for name in ('symbol', 'listed_date', 'delisted_date', 'market')},
                         schema={name: pl.String for name in ('symbol', 'listed_date', 'delisted_date', 'market')})
    return engine.BacktestDataset(prices=pl.DataFrame(rows), indicators=pl.DataFrame(), chips=pl.DataFrame(),
                                  market_risk=pl.DataFrame(), stocks=frame, trading_days=days,
                                  start_date=days[0], end_date=days[-1], corporate_sources={d: tape[d] for d in days})


def estimate(tape: dict, stocks: list[dict], *, end: str, windows: list[int]) -> list[dict]:
    from services.research_corporate_preflight import (
        MAX_EXCLUDED_SYMBOL_SHARE, CorporateExclusionTooHigh, exclude_history_blocked_symbols,
    )
    out = []
    for window in windows:
        start = (date.fromisoformat(end) - timedelta(days=window)).isoformat()
        dataset = window_dataset(tape, stocks, start, end)
        try:
            report, status = exclude_history_blocked_symbols(dataset, dataset.start_date, dataset.end_date), 'runs'
        except CorporateExclusionTooHigh as exc:
            report, status = exc.report, 'STOPS'
        out.append({'window_days': window, 'start_date': report['start_date'], 'end_date': report['end_date'],
                    'status': status, 'excluded_count': report['excluded_count'],
                    'holdable_symbols': report['holdable_symbols'], 'excluded_share': report['excluded_share'],
                    'excluded_share_limit': str(MAX_EXCLUDED_SYMBOL_SHARE),
                    'excluded_reason_counts': report['excluded_reason_counts']})
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('directory', type=Path, help='fetch directory with corporate_history.parquet and d1/stocks_raw.json')
    parser.add_argument('--end', required=True, help='window end: the snapshot end date (YYYY-MM-DD)')
    parser.add_argument('--windows', default='90,365')
    args = parser.parse_args(argv)
    date.fromisoformat(args.end)
    import polars as pl
    from services.research_corporate_history import load_history_tape
    tape = load_history_tape(pl.read_parquet(args.directory / 'corporate_history.parquet'))
    stocks = json.loads((args.directory / 'd1' / 'stocks_raw.json').read_text(encoding='utf-8'))[0]['results']
    results = estimate(tape, stocks, end=args.end, windows=[int(w) for w in args.windows.split(',')])
    print(json.dumps(results, ensure_ascii=False, indent=2))
    stopped = [r['window_days'] for r in results if r['status'] == 'STOPS']
    if stopped:
        print('EXCLUSION_SHARE_ABOVE_LIMIT:' + ','.join(map(str, stopped)), file=sys.stderr)
        return STOP_EXIT
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
