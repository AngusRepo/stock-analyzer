"""Screener parity: backtest_engine.score_multi_factor vs Worker marketScreener.scoreMultiFactor.

The Worker side runs in-process through `node --import tsx` with the same call shape as
POST /api/admin/test/score-multi-factor (worker/src/routes/adminSimulationRoutes.ts): the
champion trading config with the Python ScreenerParams merged into `screener`, the route's
chip mapping, and latestClose = last bar close. Without node or the Worker's tsx install the
TS comparison skips with the reason; the Python-only bound checks still run.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import polars as pl
import pytest

from services.backtest_engine import ScreenerParams, score_multi_factor

WORKER_DIR = Path(__file__).resolve().parents[2] / "worker"


# ═══════════════════════════════════════════════════════════════════════════════
# Canonical bar + chip shapes (single source → convert to both formats)
# ═══════════════════════════════════════════════════════════════════════════════

def make_bars(closes: list[float], volumes: list[float] | None = None,
              highs: list[float] | None = None, lows: list[float] | None = None,
              opens: list[float] | None = None, start_date: str = "2026-03-01") -> list[dict]:
    """
    Build a list of canonical bar dicts with date/open/high/low/close/volume.
    Defaults: high=close*1.01, low=close*0.99, open=close, volume=1_000_000.
    """
    n = len(closes)
    if volumes is None:
        volumes = [1_000_000.0] * n
    if highs is None:
        highs = [c * 1.01 for c in closes]
    if lows is None:
        lows = [c * 0.99 for c in closes]
    if opens is None:
        opens = [c for c in closes]
    from datetime import date, timedelta
    d0 = date.fromisoformat(start_date)
    bars = []
    for i in range(n):
        bars.append({
            "date": (d0 + timedelta(days=i)).isoformat(),
            "open": float(opens[i]),
            "high": float(highs[i]),
            "low": float(lows[i]),
            "close": float(closes[i]),
            "volume": float(volumes[i]),
        })
    return bars


def bars_to_python_df(bars: list[dict]) -> pl.DataFrame:
    """Convert canonical bar list → Polars DataFrame expected by score_multi_factor()."""
    return pl.DataFrame(bars).select(["date", "open", "high", "low", "close", "volume"])


def bars_to_worker_json(bars: list[dict]) -> list[dict]:
    """Convert canonical bars → FMStockPrice JSON shape expected by Worker."""
    out = []
    for b in bars:
        out.append({
            "date": b["date"],
            "stock_id": "TEST",
            "Trading_Volume": b["volume"],
            "Trading_money": b["volume"] * b["close"],
            "open": b["open"],
            "max": b["high"],   # TS uses `max` for high
            "min": b["low"],    # TS uses `min` for low
            "close": b["close"],
            "spread": 0.0,
            "Trading_turnover": 0.0,
        })
    return out


def chips_to_python_df(chips: list[dict]) -> pl.DataFrame:
    """Convert canonical chip list to the canonical ScoreV2 chip lane shape."""
    columns = [
        "date", "foreign_net", "trust_net", "dealer_net",
        "broker_net_shares", "broker_estimated_amount", "broker_count", "broker_concentration",
        "margin_balance", "short_balance", "margin_usage_ratio",
        "short_buy", "short_sell", "short_stock_repayment", "short_usage_ratio",
        "security_lending_sell", "security_lending_sell_return",
        "security_lending_sell_balance", "security_lending_balance",
    ]
    if not chips:
        return pl.DataFrame(schema={col: (pl.Utf8 if col == "date" else pl.Float64) for col in columns})
    raw_df = pl.DataFrame(chips)
    df = raw_df.rename({k: v for k, v in {"foreign": "foreign_net", "trust": "trust_net", "dealer": "dealer_net"}.items() if k in raw_df.columns})
    for col in columns:
        if col not in df.columns:
            df = df.with_columns(pl.lit("" if col == "date" else 0.0).alias(col))
    return df.select(columns)


def chips_to_worker_json(chips: list[dict]) -> list[dict]:
    out = []
    for c in chips:
        row = dict(c)
        row.setdefault("foreign", row.get("foreign_net", 0.0))
        row.setdefault("trust", row.get("trust_net", 0.0))
        row.setdefault("dealer", row.get("dealer_net", 0.0))
        out.append(row)
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# Helper price series generators
# ═══════════════════════════════════════════════════════════════════════════════

def steady_up(n: int = 20, start: float = 100.0, step: float = 0.5) -> list[float]:
    return [start + i * step for i in range(n)]


def steady_down(n: int = 20, start: float = 100.0, step: float = 0.5) -> list[float]:
    return [start - i * step for i in range(n)]


def flat(n: int = 20, price: float = 100.0) -> list[float]:
    return [price] * n


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures — each exercises tier boundaries
#
# Each fixture: { id, bars, chips, marketReturn5d, cfg_override? }
# ═══════════════════════════════════════════════════════════════════════════════

def _mk_chip_days(dates: list[str], nets: list[float]) -> list[dict]:
    """nets are combined foreign+trust values; put half in foreign, half in trust."""
    out = []
    for d, net in zip(dates, nets):
        out.append({"date": d, "foreign": net / 2, "trust": net / 2})
    return out


def _chip_dates(bars: list[dict], last_n: int = 5) -> list[str]:
    return [b["date"] for b in bars[-last_n:]]


# Baseline: 20 bars steady up, close ~100
_BASELINE_BARS = make_bars(steady_up(20, 95.0, 0.5))

FIXTURES: list[dict] = [
    # ── Chip tier 0 (intensity > 0.20) ─────────────────────────────────────
    # volume=1M, close=100, turnover=100M, target net_amount > 20M → net_shares > 200k/day
    {
        "id": "chip_tier0_ultra_high",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [80_000, 80_000, 80_000, 80_000, 80_000]),
        "marketReturn5d": 0.0,
    },
    # ── Chip tier 1 (0.10 < intensity <= 0.20) ─────────────────────────────
    # net_amount ≈ 12M → net_shares total 120k, 24k/day
    {
        "id": "chip_tier1_high",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [24_000, 24_000, 24_000, 24_000, 24_000]),
        "marketReturn5d": 0.0,
    },
    # ── Chip tier 2 (0.05 < intensity <= 0.10) ─────────────────────────────
    {
        "id": "chip_tier2_mid",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [14_000, 14_000, 14_000, 14_000, 14_000]),
        "marketReturn5d": 0.0,
    },
    # ── Chip tier 3 (0 < intensity <= 0.05) ────────────────────────────────
    {
        "id": "chip_tier3_weak_positive",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [4_000, 4_000, 4_000, 4_000, 4_000]),
        "marketReturn5d": 0.0,
    },
    # ── Chip tier 4 (-0.05 < intensity <= 0) ───────────────────────────────
    {
        "id": "chip_tier4_mild_negative",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [-3_000, -3_000, -3_000, -3_000, -3_000]),
        "marketReturn5d": 0.0,
    },
    # ── Chip below all tiers (< -0.05) → 0 ─────────────────────────────────
    {
        "id": "chip_below_all_tiers",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [-20_000, -20_000, -20_000, -20_000, -20_000]),
        "marketReturn5d": 0.0,
    },
    {
        "id": "dealer_net_counts_as_institutional_chip",
        "bars": _BASELINE_BARS,
        "chips": [{"date": d, "foreign": 0.0, "trust": 0.0, "dealer": 80_000.0} for d in _chip_dates(_BASELINE_BARS)],
        "marketReturn5d": 0.0,
    },
    {
        "id": "broker_flow_can_seed_chip_score",
        "bars": _BASELINE_BARS,
        "chips": [
            {
                "date": d,
                "foreign": 0.0,
                "trust": 0.0,
                "broker_net_shares": 50_000.0,
                "broker_estimated_amount": 5_000_000.0,
                "broker_count": 8.0,
                "broker_concentration": 0.2,
            }
            for d in _chip_dates(_BASELINE_BARS)
        ],
        "marketReturn5d": 0.0,
    },
    {
        "id": "lending_sell_pressure_penalizes_chip",
        "bars": _BASELINE_BARS,
        "chips": [
            {
                "date": d,
                "foreign": 35_000.0,
                "trust": 35_000.0,
                "security_lending_sell": 60_000.0,
                "security_lending_sell_return": 0.0,
                "security_lending_sell_balance": 200_000.0 + i * 60_000.0,
            }
            for i, d in enumerate(_chip_dates(_BASELINE_BARS))
        ],
        "marketReturn5d": 0.0,
    },
    # ── No chip data ───────────────────────────────────────────────────────
    {
        "id": "no_chip_data",
        "bars": _BASELINE_BARS,
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── Consec buy 5 days → +4 bonus ───────────────────────────────────────
    {
        "id": "consec_5_bonus_tier0",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [8_000, 8_000, 8_000, 8_000, 8_000]),
        "marketReturn5d": 0.0,
    },
    # ── Consec buy 3 days (first 2 flat=0, last 3 positive) → +2 bonus ────
    # Note: consec counts from END backwards; day_net=0 breaks the chain on Python side
    # (day_net > 0 is False when day_net == 0).
    {
        "id": "consec_3_bonus",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [0, 0, 5_000, 5_000, 5_000]),
        "marketReturn5d": 0.0,
    },
    # ── 🔥 Consec bug edge case: [neg, +, +, +, +] ─────────────────────────
    # Python: consec=4 (stops at first negative encountered going back)
    # TS: consec=0 (zeros out when hits first negative, losing all count)
    # This fixture is expected to fail parity before the TS fix.
    {
        "id": "consec_bug_neg_first_then_all_pos",
        "bars": _BASELINE_BARS,
        "chips": _mk_chip_days(_chip_dates(_BASELINE_BARS), [-10_000, 12_000, 12_000, 12_000, 12_000]),
        "marketReturn5d": 0.0,
    },
    # ── RSI overbought but no blunting: 20 flat + last few up only ────────
    # Actually use steady up with large step: RSI > 75 very likely
    {
        "id": "rsi_overbought_tier",
        "bars": make_bars(steady_up(20, 50.0, 3.0)),   # aggressive up → RSI > 75
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── RSI mid 45-55 → tier1 = 8 ─────────────────────────────────────────
    # Oscillating around 100
    {
        "id": "rsi_mid_range",
        "bars": make_bars([100.0, 100.5, 99.8, 100.2, 100.0, 99.7, 100.3, 100.1, 99.9, 100.2,
                           100.0, 99.8, 100.1, 100.0, 99.9, 100.2, 100.0, 99.8, 100.1, 99.95]),
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── RSI low 30-40 → tier4 = 3 ─────────────────────────────────────────
    {
        "id": "rsi_oversold_bounce",
        "bars": make_bars(steady_down(20, 110.0, 0.5)),  # steady down → RSI < 40
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── MACD positive (ma12 > ma26) ───────────────────────────────────────
    # Steady up causes ma12 > ma26 (accelerating up)
    {
        "id": "macd_positive",
        "bars": make_bars(steady_up(20, 90.0, 1.0)),
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── MACD weakly negative (within -0.5% threshold) ─────────────────────
    # Slight down: ma12 slightly < ma26
    {
        "id": "macd_weak_negative",
        "bars": make_bars(steady_down(20, 105.0, 0.05)),  # very slow down
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── Keltner breakout + NATR low ───────────────────────────────────────
    # Last bar close shoots above ma20 + 1.5*atr14
    {
        "id": "keltner_breakout",
        "bars": (lambda: (
            make_bars(steady_up(19, 100.0, 0.1)) +
            make_bars([108.0], start_date="2026-03-20")  # final big jump
        ))(),
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── Excess return vs market (positive outperform) ─────────────────────
    # +3% stock return vs 0% market → excess 0.03, normalize in [-0.03, 0.05] range
    {
        "id": "excess_return_high",
        "bars": make_bars(
            flat(14, 100.0) + [100.0, 100.6, 101.2, 101.8, 102.4, 103.0]  # last 6: +3% over 5d
        ),
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── Excess return negative (underperform) ─────────────────────────────
    {
        "id": "excess_return_negative",
        "bars": make_bars(
            flat(14, 100.0) + [100.0, 99.5, 99.0, 98.5, 98.0, 97.5]  # -2.5% vs 0%
        ),
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── High volume ratio (recent 3d vs 20d avg) ──────────────────────────
    {
        "id": "vol_ratio_high",
        "bars": make_bars(
            steady_up(20, 100.0, 0.5),
            volumes=([1_000_000.0] * 17 + [3_000_000.0, 3_000_000.0, 3_000_000.0])
        ),
        "chips": [],
        "marketReturn5d": 0.0,
    },
    # ── Short bar series (n=14) — skips MACD/intent, allows RSI ──────────
    {
        "id": "short_series_n14",
        "bars": make_bars(steady_up(14, 100.0, 0.3)),
        "chips": [],
        "marketReturn5d": 0.0,
    },
]


# ═══════════════════════════════════════════════════════════════════════════════
# Score comparison helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _scores_close(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(float(a) - float(b)) <= tol


# ═══════════════════════════════════════════════════════════════════════════════
# Runners
# ═══════════════════════════════════════════════════════════════════════════════

def _build_py_inputs(fixture: dict) -> tuple[pl.DataFrame, pl.DataFrame, float]:
    prices_df = bars_to_python_df(fixture["bars"])
    chip_df = chips_to_python_df(fixture["chips"])
    return prices_df, chip_df, float(fixture["marketReturn5d"])


# ═══════════════════════════════════════════════════════════════════════════════
# Worker TS bridge
# ═══════════════════════════════════════════════════════════════════════════════

# Only the sub-scores are compared. base_score (TS: ScoreV2 finalScore, Python: chip+tech+mom)
# and the reasons text differ for every fixture today and are not asserted here.
# Fixture ids whose chip_score differs from the Worker today (tech and momentum stay strict).
# Strict xfail: remove the entry once both converge.
KNOWN_CHIP_DRIFT: dict[str, str] = {
    "broker_flow_can_seed_chip_score": (
        "chip Python 29.0 vs TS 24.4: Python rescales broker estimated amount x1000 by ratio, "
        "TS only when the source is finlab.broker_transactions (the route passes no source)"
    ),
}

_TS_SCORE_SCRIPT = r"""
import { readFileSync } from 'node:fs';
import screener from './src/lib/marketScreener.ts';
import tradingConfig from './src/lib/tradingConfig.ts';
const { scoreMultiFactor } = screener;
const { buildChampionTradingConfig } = tradingConfig;
const { cfgOverride, cases } = JSON.parse(readFileSync(0, 'utf8'));
const base = buildChampionTradingConfig({});
const cfg = { ...base, ...cfgOverride, screener: { ...base.screener, ...(cfgOverride.screener ?? {}) } };
const out = {};
for (const f of cases) {
  let chipDates;
  if (f.chips.length > 0) {
    chipDates = new Map();
    for (const chip of f.chips) {
      chipDates.set(String(chip.date), {
        foreign: Number(chip.foreign ?? 0),
        trust: Number(chip.trust ?? 0),
        dealer: Number(chip.dealer ?? chip.dealer_net ?? 0),
        brokerFlow: Number(chip.brokerFlow ?? chip.broker_net_shares ?? 0),
        estimatedAmount: chip.estimatedAmount ?? chip.broker_estimated_amount ?? null,
        brokerCount: chip.brokerCount ?? chip.broker_count ?? null,
        concentration: chip.concentration ?? chip.broker_concentration ?? null,
        marginBalance: chip.marginBalance ?? chip.margin_balance ?? null,
        shortBalance: chip.shortBalance ?? chip.short_balance ?? null,
        marginUsageRatio: chip.marginUsageRatio ?? chip.margin_usage_ratio ?? null,
        shortBuy: chip.shortBuy ?? chip.short_buy ?? null,
        shortSell: chip.shortSell ?? chip.short_sell ?? null,
        shortStockRepayment: chip.shortStockRepayment ?? chip.short_stock_repayment ?? null,
        shortUsageRatio: chip.shortUsageRatio ?? chip.short_usage_ratio ?? null,
        securityLendingSell: chip.securityLendingSell ?? chip.security_lending_sell ?? null,
        securityLendingSellReturn: chip.securityLendingSellReturn ?? chip.security_lending_sell_return ?? null,
        securityLendingSellBalance: chip.securityLendingSellBalance ?? chip.security_lending_sell_balance ?? null,
        securityLendingBalance: chip.securityLendingBalance ?? chip.security_lending_balance ?? null,
      });
    }
  }
  const latestClose = Number(f.prices[f.prices.length - 1]?.close ?? 0);
  const r = scoreMultiFactor(f.prices, chipDates, Number(f.marketReturn5d), latestClose, cfg);
  out[f.id] = { chip_score: r.chip_score, tech_score: r.tech_score, momentum_score: r.momentum_score };
}
console.log(JSON.stringify(out));
"""


def _build_cfg_override_from_params(sc: ScreenerParams) -> dict:
    """Build a trading:config.screener override so Worker uses identical params."""
    return {
        "screener": {
            "consecBuyBonusTiers": list(sc.consec_buy_bonus_tiers),
            "consecBuyDayThresholds": list(sc.consec_buy_day_thresholds),
            "macdNegativeFactor": sc.macd_negative_factor,
            "keltnerMultiplier": sc.keltner_multiplier,
            "natrThreshold": sc.natr_threshold,
            "excessReturnRange": list(sc.excess_return_range),
            "volRatioRange": list(sc.vol_ratio_range),
        }
    }


@pytest.fixture(scope="module")
def ts_scores() -> dict:
    if shutil.which("node") is None:
        pytest.skip("node not on PATH: Worker scoreMultiFactor cannot run")
    if not (WORKER_DIR / "node_modules" / "tsx").is_dir():
        pytest.skip(f"tsx not installed under {WORKER_DIR}/node_modules (run npm ci in worker)")
    cases = [{
        "id": f["id"],
        "prices": bars_to_worker_json(f["bars"]),
        "chips": chips_to_worker_json(f["chips"]),
        "marketReturn5d": float(f["marketReturn5d"]),
    } for f in FIXTURES]
    payload = json.dumps({"cfgOverride": _build_cfg_override_from_params(ScreenerParams()), "cases": cases})
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", _TS_SCORE_SCRIPT],
        cwd=WORKER_DIR, input=payload, capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError("Worker TS bridge failed:\n" + result.stdout + result.stderr)
    return json.loads(result.stdout.strip().splitlines()[-1])


# ═══════════════════════════════════════════════════════════════════════════════
# Tests
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("f", FIXTURES, ids=[f["id"] for f in FIXTURES])
def test_python_scores_stay_in_bounds(f):
    base, chip, tech, mom, _ = score_multi_factor(*_build_py_inputs(f), ScreenerParams())
    assert 0 <= chip <= 40
    assert 0 <= tech <= 30
    assert 0 <= mom <= 20
    assert abs(base - (chip + tech + mom)) < 1e-6


@pytest.mark.parametrize("f", FIXTURES, ids=[f["id"] for f in FIXTURES])
def test_python_tech_and_momentum_match_worker_ts(f, ts_scores):
    _, _, tech, mom, _ = score_multi_factor(*_build_py_inputs(f), ScreenerParams())
    ts = ts_scores[f["id"]]
    assert _scores_close(tech, ts["tech_score"]), (tech, ts["tech_score"])
    assert _scores_close(mom, ts["momentum_score"]), (mom, ts["momentum_score"])


@pytest.mark.parametrize("f", [
    pytest.param(f, id=f["id"], marks=pytest.mark.xfail(strict=True, raises=AssertionError, reason=KNOWN_CHIP_DRIFT[f["id"]]))
    if f["id"] in KNOWN_CHIP_DRIFT else pytest.param(f, id=f["id"])
    for f in FIXTURES
])
def test_python_chip_score_matches_worker_ts(f, ts_scores):
    _, chip, _, _, _ = score_multi_factor(*_build_py_inputs(f), ScreenerParams())
    assert _scores_close(chip, ts_scores[f["id"]]["chip_score"]), (chip, ts_scores[f["id"]]["chip_score"])
