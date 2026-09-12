"""Read-only audit of preserved real announcements; NOT portfolio performance.

No downloads, training, ledger writes, maturity credit or production access.
Historical availability reconstruction is diagnostic, not proof of historical
system capture. Run from ml-controller; JSON is emitted to stdout only.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import polars as pl
from services.finlab_corporate_actions import _date, normalize_dividend_announcements
from services.paired_nav_journal import digest


def audit(catalog: Path, inventory: Path) -> dict:
    meta = json.loads(inventory.read_text(encoding='utf-8'))
    rows = pl.read_parquet(catalog)
    checksum = digest(rows.write_json())
    if checksum != meta['data_checksum']:
        raise ValueError('saved_corporate_catalog_checksum_mismatch')
    captured = datetime.fromisoformat(meta['observed_at'])
    start, end = meta['window']
    universe = {}
    for row in rows.select('stock_id', '除息交易日', '除權交易日').iter_rows(named=True):
        symbol = str(row['stock_id'])
        if symbol.startswith('0'):
            continue  # Company feed; do not claim ETF coverage.
        for column in ('除息交易日', '除權交易日'):
            day = _date(row[column])
            if day and start <= day <= end:
                universe.setdefault(day, set()).add(symbol)
    results = []
    blocker_counts = Counter()
    for day, symbols in sorted(universe.items()):
        # Retain every revision for all selected symbols, not just that day's row.
        subset = rows.filter(pl.col('stock_id').cast(pl.String).is_in(sorted(symbols)))
        cutoff = datetime.fromisoformat(day + 'T08:59:59+08:00')
        if cutoff > captured:
            raise ValueError('saved_corporate_catalog_predates_requested_cutoff')
        result = normalize_dividend_announcements(subset, symbols=sorted(symbols),
            session_date=day, observed_at=cutoff)
        for reasons in result['blockers'].values():
            blocker_counts.update(reasons)
        results.append({'session_date': day, 'symbols': len(symbols),
            'actions': len(result['actions']), 'blockers': result['blockers'],
            'cash_actions': sum(a['kind'] == 'cash' for a in result['actions']),
            'stock_actions': sum(a['kind'] == 'stock' for a in result['actions']),
            'subscription_actions': sum(a['kind'] == 'subscription' for a in result['actions'])})
    return {'evidence_class': 'saved_real_corporate_source_diagnostic',
        'catalog': str(catalog.resolve()), 'catalog_checksum': checksum,
        'captured_at': captured.isoformat(), 'window': [start, end],
        'catalog_rows': rows.height, 'catalog_symbols': rows['stock_id'].n_unique(),
        'sessions': len(results), 'symbol_sessions': sum(r['symbols'] for r in results),
        'normalized_actions': sum(r['actions'] for r in results),
        'blocked_symbol_sessions': sum(len(r['blockers']) for r in results),
        'blocker_counts': dict(sorted(blocker_counts.items())), 'daily': results,
        'historical_capture_proven': False, 'prospective_credit': 0,
        'portfolio_returns_available': False, 'performance_improvement_claim': False,
        'production_writes': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.catalog, args.inventory), ensure_ascii=False, allow_nan=False, indent=2))
