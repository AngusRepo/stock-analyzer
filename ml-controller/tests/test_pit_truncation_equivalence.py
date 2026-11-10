"""T1 (C28-02): row t of the 131 features is bit-identical whether the sources end at
t (each truncated to what the contract says was available by t) or run to today."""
from datetime import date, timedelta

import numpy as np
import pytest

from app.features import build_feature_matrix
from services.formal_feature_contract import FEATURES131
from services.pit_certification import CONTRACT_VERSION, load_contract

CLOSED = {date(2026, 7, 10)} | {date(2026, 2, 12) + timedelta(days=i) for i in range(9)}
DAYS = [d for d in (date(2025, 1, 2) + timedelta(days=i) for i in range(640))
        if d.weekday() < 5 and d not in CLOSED]
SESSIONS = [str(d) for d in DAYS]
VMD_FROM = SESSIONS[380]  # a later indicator record must not rewrite earlier rows (PIT-P0 7)
AVG_FROM, SAR_FROM = SESSIONS[350], SESSIONS[300]  # same for avg_price coverage and parabolicSar
DATES = ["2025-03-03", VMD_FROM, SESSIONS[379], "2026-02-11", "2026-02-23", "2026-03-10", "2026-03-11",
         "2026-05-15", "2026-07-09", "2026-07-13", "2026-07-14", "2026-08-14", SESSIONS[-1]]


def _sources():
    rng = np.random.default_rng(7)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, len(DAYS))))
    prices = [{"date": d, "open": c * (1 + rng.normal(0, .005)), "high": c * 1.02, "low": c * .98, "close": c,
               "adj_close": c * .97, "volume": float(rng.integers(5_000, 50_000)),
               **({"avg_price": c * (1 + rng.normal(0, .003))} if d >= AVG_FROM and i % 11 else {})}
              for i, (d, c) in enumerate(zip(SESSIONS, close))]
    indicators = [{"date": d, "CORD_10": float(rng.normal()), "adx14": float(rng.uniform(10, 40)),
                   **({"volumeMomentumDivergence132710": float(rng.normal())} if d >= VMD_FROM and i % 17 else {}),
                   **({"parabolicSar": float(rng.uniform(.9, 1.1))} if d >= SAR_FROM and i % 13 else {})}
                  for i, d in enumerate(SESSIONS)]
    chips = [{"date": d, "foreign_net": float(rng.normal(0, 1e3)), "trust_net": float(rng.normal(0, 1e2)),
              "dealer_net": float(rng.normal(0, 1e2)), "margin_balance": float(5e3 + i + rng.normal(0, 50)),
              "short_balance": float(300 + rng.normal(0, 20)), "broker_net_shares": float(rng.normal(0, 1e3)),
              "broker_count": float(rng.integers(1, 30))} for i, d in enumerate(SESSIONS)]
    history = {d: {"pe": float(rng.uniform(8, 30)), "pb": float(rng.uniform(1, 4)),
                   "dividend_yield": float(rng.uniform(0, 6))} for d in SESSIONS}
    for day in (date(2025, 1, 10) + timedelta(days=30 * i) for i in range(21)):  # monthly revenue keys, incl. holidays
        history.setdefault(str(day), {}).update(revenue=float(rng.uniform(1e5, 2e5)),
                                                revenue_yoy=float(rng.normal()), revenue_mom=float(rng.normal()))
    for key in ("2025-03-31", "2025-05-15", "2025-08-14", "2025-11-14", "2026-03-31", "2026-05-15", "2026-07-10",
                "2026-08-14"):  # financial deadlines, one on the typhoon day
        history.setdefault(key, {}).update(eps=float(rng.normal(2, 1)), roe=float(rng.normal(10, 3)),
                                           revenue_growth_yoy=float(rng.normal()))
    market = {d: {"advance_ratio": float(rng.uniform()), "us_sentiment_score": float(rng.normal())} for d in SESSIONS}
    return prices, indicators, chips, history, market


def _usable_session(key: str, lag: int) -> str | None:
    """First capture session on/after an availability key, plus the contract lag."""
    first = next((i for i, day in enumerate(SESSIONS) if day >= key), None)
    return None if first is None or first + lag >= len(SESSIONS) else SESSIONS[first + lag]


def _truncate(t: str, sources, lags: dict):
    prices, indicators, chips, history, market = sources
    lagged_chips = {f for f in ("margin_balance", "short_balance") if lags.get(f)}
    cut_chips = []
    for row in chips:
        if row["date"] > t:
            continue
        cut_chips.append({k: v for k, v in row.items() if k not in lagged_chips or (_usable_session(row["date"], lags[k]) or "~") <= t})
    cut_history = {}
    for key, values in history.items():
        kept = {k: v for k, v in values.items() if (_usable_session(key, lags.get(k, 0)) or "~") <= t}
        if kept:
            cut_history[key] = kept
    return ([r for r in prices if r["date"] <= t], [r for r in indicators if r["date"] <= t], cut_chips,
            cut_history, {d: v for d, v in market.items() if d <= t})


def _row(sources, t, version):
    prices, indicators, chips, history, market = sources
    df = build_feature_matrix(prices, indicators, chips, [], {"per_stock_ts": history, "history": market},
                              historical_training=True, pit_contract_version=version)
    index = df["date"].cast(str).to_list().index(t)
    return np.asarray([df[name].cast(float)[index] for name in FEATURES131], dtype=np.float64)


def _differing(a, b):
    return [name for name, x, y in zip(FEATURES131, a.view(np.int64), b.view(np.int64)) if x != y]


@pytest.fixture(scope="module")
def full():
    sources = _sources()
    df = build_feature_matrix(*sources[:3], [], {"per_stock_ts": sources[3], "history": sources[4]},
                              historical_training=True, pit_contract_version=CONTRACT_VERSION)
    return sources, df


def test_every_formal_feature_is_identical_at_each_truncation_date(full):
    sources, df = full
    lags = load_contract()["feature_lags"]
    dates = df["date"].cast(str).to_list()
    assert set(DATES) <= set(dates) and all(name in df.columns for name in FEATURES131)
    for t in DATES:
        index = dates.index(t)
        whole = np.asarray([df[name].cast(float)[index] for name in FEATURES131], dtype=np.float64)
        cut = _row(_truncate(t, sources, lags), t, CONTRACT_VERSION)
        assert _differing(whole, cut) == [], t


def test_the_check_has_teeth_without_the_contract(full):
    """Pre-contract builds read same-day margin/financials and whole-column
    indicator/avg_price checks: truncating by availability exposes them."""
    sources, _ = full
    lags = load_contract()["feature_lags"]
    diffs = set()
    for t in ("2026-03-31", "2026-07-13", SESSIONS[379]):
        diffs |= set(_differing(_row(sources, t, None), _row(_truncate(t, sources, lags), t, None)))
    assert {"l1_eps", "l1_volumeMomentumDivergence132710", "vwap_bias"} <= diffs
    assert any("margin" in name or "short" in name for name in diffs)
