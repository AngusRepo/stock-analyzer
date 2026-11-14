"""C28-27: research replay universe excludes ETFs with the same rule as Worker L0."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_engine import ETF_PATTERN_SYMBOL_REGEXES, BacktestDataset  # noqa: E402

BOARD_TRADABILITY_TS = Path(__file__).resolve().parents[2] / 'worker' / 'src' / 'lib' / 'boardTradability.ts'
SCREENER_TS = Path(__file__).resolve().parents[2] / 'worker' / 'src' / 'lib' / 'marketScreener.ts'


def _worker_etf_regexes() -> tuple[str, ...]:
    src = BOARD_TRADABILITY_TS.read_text(encoding='utf-8')
    body = re.search(r'export function isEtfPatternSymbol\([^)]*\)[^{]*\{(.*?)\n\}', src, re.S)
    assert body, 'isEtfPatternSymbol not found in boardTradability.ts'
    assert 'String(symbol ?? \'\').trim().toUpperCase()' in body.group(1)
    return tuple(re.findall(r'/(\^[^/]+\$)/\.test\(value\)', body.group(1)))


def test_python_etf_regexes_match_worker_is_etf_pattern_symbol():
    assert _worker_etf_regexes() == ETF_PATTERN_SYMBOL_REGEXES


def test_worker_l0_gate_is_market_etf_or_pattern():
    src = SCREENER_TS.read_text(encoding='utf-8')
    assert "return market === 'ETF' || isEtfPatternSymbol(symbol)" in src


def _dataset(rows):
    dataset = BacktestDataset.__new__(BacktestDataset)
    dataset._universe_cache = {}
    dataset.stocks = pl.DataFrame([
        {'symbol': s, 'market': m, 'listed_date': '2000-01-01', 'delisted_date': None} for s, m in rows])
    dataset.prices = pl.DataFrame({'symbol': [s for s, _ in rows], 'date': ['2026-09-10'] * len(rows)})
    return dataset


def test_get_universe_at_drops_etf_pattern_and_etf_market():
    rows = [('2330', 'TWSE'), ('6488', 'OTC'), ('0050', 'TWSE'), ('0061', 'TWSE'), ('00631L', 'TWSE'),
            ('00679B', 'OTC'), ('020000', 'TWSE'), ('9999', 'ETF'), ('1101', 'TWSE'), ('2002', 'TWSE')]
    assert _dataset(rows).get_universe_at('2026-09-10') == {'2330', '6488', '1101', '2002'}


def test_python_rule_matches_worker_fixtures():
    # Expected values follow the Worker regexes evaluated on trim().toUpperCase().
    cases = {'0050': True, '0061': True, '00631L': True, '00679b': True, ' 006208 ': True, '020000': True,
             '01234': False, '0123': False, '2330': False, '1101': False, '00': False, '005': False, '': False}
    rx = re.compile('|'.join(ETF_PATTERN_SYMBOL_REGEXES))
    assert {s: bool(rx.search(s.strip().upper())) for s in cases} == cases
    dataset = _dataset([(s.strip().upper() or 'X', 'TWSE') for s in cases])
    got = dataset.get_universe_at('2026-09-10')
    assert {s for s in cases if not cases[s] and s} == {s for s in cases if s and s.strip().upper() in got}
