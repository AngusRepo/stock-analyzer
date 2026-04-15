"""
test_screener_parity.py — Sprint 6a.7b screener parity test

Verifies that backtest_engine.score_multi_factor() returns identical scores
and reasons to Worker marketScreener.ts scoreMultiFactor() for the same
inputs. Closes the drift risk between the Mode A Optuna objective and
production Worker pipeline.

Two run modes:

  LOCAL mode (--mode local):
    Runs fixtures against local Python score_multi_factor only. Fast, no
    network, catches bugs in the Python port but cannot detect drift from
    Worker TS.

  PARITY mode (--mode parity):
    POSTs each fixture to Worker /api/admin/test/score-multi-factor and
    asserts all 4 scores + reasons list match. Requires:
      - Worker deployed with /admin/test/score-multi-factor endpoint
      - STOCKVISION_AUTH_TOKEN env var
      - WORKER_URL env var

Usage:
  python tests/test_screener_parity.py --mode local
  WORKER_URL=... STOCKVISION_AUTH_TOKEN=... python tests/test_screener_parity.py --mode parity

Exit code: 0 = all fixtures pass, 1 = any mismatch.

See memory/project_session_2026_04_07_part5.md for the 6a.7b scope.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import polars as pl  # noqa: E402

from services.backtest_engine import ScreenerParams, score_multi_factor  # noqa: E402


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
    """Convert canonical chip list → Polars DataFrame with foreign_net/trust_net columns."""
    if not chips:
        return pl.DataFrame(schema={"date": pl.Utf8, "foreign_net": pl.Float64, "trust_net": pl.Float64})
    df = pl.DataFrame(chips).rename({"foreign": "foreign_net", "trust": "trust_net"})
    return df.select(["date", "foreign_net", "trust_net"])


def chips_to_worker_json(chips: list[dict]) -> list[dict]:
    return [{"date": c["date"], "foreign": c["foreign"], "trust": c["trust"]} for c in chips]


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


def _compare_result(
    py: tuple[float, float, float, float, list[str]],
    ts: dict,
    fixture_id: str,
) -> list[str]:
    """Return list of diff strings (empty = match)."""
    py_base, py_chip, py_tech, py_mom, py_reasons = py
    ts_base = ts.get("base_score", 0)
    ts_chip = ts.get("chip_score", 0)
    ts_tech = ts.get("tech_score", 0)
    ts_mom = ts.get("momentum_score", 0)
    ts_reasons = ts.get("reasons", [])
    diffs = []
    if not _scores_close(py_chip, ts_chip):
        diffs.append(f"chip py={py_chip} ts={ts_chip}")
    if not _scores_close(py_tech, ts_tech):
        diffs.append(f"tech py={py_tech} ts={ts_tech}")
    if not _scores_close(py_mom, ts_mom):
        diffs.append(f"mom py={py_mom} ts={ts_mom}")
    if not _scores_close(py_base, ts_base):
        diffs.append(f"base py={py_base} ts={ts_base}")
    if list(py_reasons) != list(ts_reasons):
        diffs.append(f"reasons py={py_reasons} ts={ts_reasons}")
    return diffs


# ═══════════════════════════════════════════════════════════════════════════════
# Runners
# ═══════════════════════════════════════════════════════════════════════════════

def _build_py_inputs(fixture: dict) -> tuple[pl.DataFrame, pl.DataFrame, float]:
    prices_df = bars_to_python_df(fixture["bars"])
    chip_df = chips_to_python_df(fixture["chips"])
    return prices_df, chip_df, float(fixture["marketReturn5d"])


def run_local(sc: ScreenerParams) -> tuple[int, int, list[str]]:
    """Just run Python and report any crashes; no TS comparison."""
    passed = 0
    failed = 0
    errors: list[str] = []
    for f in FIXTURES:
        try:
            prices_df, chip_df, mkt = _build_py_inputs(f)
            py = score_multi_factor(prices_df, chip_df, mkt, sc)
            base, chip, tech, mom, reasons = py
            # Sanity: scores within clamp bounds
            assert 0 <= chip <= 40, f"chip {chip} out of bounds"
            assert 0 <= tech <= 30, f"tech {tech} out of bounds"
            assert 0 <= mom <= 20, f"mom {mom} out of bounds"
            assert abs(base - (chip + tech + mom)) < 1e-6, f"base {base} != sum"
            passed += 1
        except Exception as e:
            failed += 1
            errors.append(f"  [{f['id']}] Python error: {e}")
    return passed, failed, errors


def _build_cfg_override_from_params(sc: ScreenerParams) -> dict:
    """Build a trading:config.screener override so Worker uses identical params."""
    return {
        "screener": {
            "chipScoreTiers": list(sc.chip_score_tiers),
            "chipIntensityThresholds": list(sc.chip_intensity_thresholds),
            "consecBuyBonusTiers": list(sc.consec_buy_bonus_tiers),
            "consecBuyDayThresholds": list(sc.consec_buy_day_thresholds),
            "rsiScoreTiers": list(sc.rsi_score_tiers),
            "macdNegativeFactor": sc.macd_negative_factor,
            "keltnerMultiplier": sc.keltner_multiplier,
            "natrThreshold": sc.natr_threshold,
            "excessReturnRange": list(sc.excess_return_range),
            "volRatioRange": list(sc.vol_ratio_range),
        }
    }


def run_parity(sc: ScreenerParams, worker_url: str, token: str) -> tuple[int, int, list[str]]:
    try:
        import httpx
    except ImportError:
        print("[ERROR] httpx not installed — pip install httpx")
        return 0, len(FIXTURES), ["httpx missing"]

    passed = 0
    failed = 0
    errors: list[str] = []

    endpoint = f"{worker_url.rstrip('/')}/api/admin/test/score-multi-factor"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    cfg_override = _build_cfg_override_from_params(sc)

    with httpx.Client(timeout=20.0) as client:
        for f in FIXTURES:
            try:
                prices_df, chip_df, mkt = _build_py_inputs(f)
                py = score_multi_factor(prices_df, chip_df, mkt, sc)
            except Exception as e:
                failed += 1
                errors.append(f"  [{f['id']}] Python crashed: {e}")
                continue

            body = {
                "prices": bars_to_worker_json(f["bars"]),
                "chips": chips_to_worker_json(f["chips"]),
                "marketReturn5d": float(f["marketReturn5d"]),
                "cfg": cfg_override,
            }
            try:
                resp = client.post(endpoint, headers=headers, json=body)
                if resp.status_code != 200:
                    failed += 1
                    errors.append(f"  [{f['id']}] HTTP {resp.status_code}: {resp.text[:200]}")
                    continue
                ts = resp.json()
            except Exception as e:
                failed += 1
                errors.append(f"  [{f['id']}] HTTP request failed: {e}")
                continue

            diffs = _compare_result(py, ts, f["id"])
            if diffs:
                failed += 1
                errors.append(f"  [{f['id']}] DRIFT: {' | '.join(diffs)}")
            else:
                passed += 1

    return passed, failed, errors


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["local", "parity"], default="local")
    args = parser.parse_args()

    sc = ScreenerParams()  # production defaults

    print(f"Running {len(FIXTURES)} screener fixtures in {args.mode} mode...")
    print()

    if args.mode == "local":
        passed, failed, errors = run_local(sc)
    else:
        worker_url = os.environ.get("WORKER_URL", "").strip()
        token = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
        if not worker_url or not token:
            print("[ERROR] --mode parity requires WORKER_URL and STOCKVISION_AUTH_TOKEN env vars")
            return 1
        passed, failed, errors = run_parity(sc, worker_url, token)

    print(f"Passed: {passed}/{len(FIXTURES)}")
    print(f"Failed: {failed}/{len(FIXTURES)}")
    if errors:
        print()
        print("Errors:")
        for e in errors:
            print(e)
        return 1

    print()
    print(f"[OK] All {passed} fixtures passed in {args.mode} mode")
    return 0


if __name__ == "__main__":
    sys.exit(main())
