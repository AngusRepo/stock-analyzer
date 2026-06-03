"""
payload_builder.py — Build PredictRequest payloads from D1
2026-04-07 LangGraph A+B refactor

Direct port of worker/src/index.ts:1013-1173 (runMLAndRisk's market_env + per-stock loop).

Key optimization: instead of N stocks × 8 queries (worker did this serially per stock),
we issue ~10 bulk queries that pull data for ALL active stocks at once, then group
in-memory. Reduces D1 round-trips from ~270 (33 stocks × 8) to ~10.
"""
from __future__ import annotations
import logging
import json
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from services import d1_client, kv_client
from services.adaptive import resolve_adaptive_params_for_regime
from services.market_regime_state import resolve_market_regime_contract
from services.market_segment_policy import policy_for_segment

logger = logging.getLogger(__name__)

DAILY_RECOMMENDATION_PIPELINE_COLUMNS = (
    "id, date, stock_id, symbol, name, sector, industry, rank, score, signal, confidence, "
    "reason, watch_points, has_buy_signal, current_price, foreign_net_5d, trust_net_5d, "
    "rsi14, macd_hist, sector_rank, "
    "market_segment, recommendation_lane, eligible_for_ml, eligible_for_pending_buy, "
    "alpha_context, alpha_allocation, ml_vote_summary, score_components"
)

D1_IN_CLAUSE_CHUNK_SIZE = 80


def _dedupe_preserve_order(values: list[Any]) -> list[Any]:
    seen: set[Any] = set()
    out: list[Any] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _chunked(values: list[Any], size: int = D1_IN_CLAUSE_CHUNK_SIZE) -> list[list[Any]]:
    if size <= 0:
        raise ValueError("chunk size must be positive")
    unique_values = _dedupe_preserve_order(values)
    return [unique_values[i:i + size] for i in range(0, len(unique_values), size)]


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _price_close(row: dict | None, default: float = 0.0) -> float:
    if not row:
        return default
    value = row.get("close")
    if value is None:
        value = row.get("avg_price")
    return _as_float(value, default)


def _bucket_from_thresholds(value: float, thresholds: tuple[float, float, float, float]) -> int:
    if value > thresholds[3]:
        return 4
    if value > thresholds[2]:
        return 3
    if value > thresholds[1]:
        return 2
    if value > thresholds[0]:
        return 1
    return 0


def _daily_turnover_bucket(prices: list[dict]) -> int:
    if not prices:
        return 2
    recent = prices[-20:] if len(prices) >= 20 else prices
    avg_close = sum(_price_close(p) for p in recent) / len(recent)
    avg_vol = sum(_as_float(p.get("volume"), 0.0) for p in recent) / len(recent)
    return _bucket_from_thresholds(avg_close * avg_vol, (5e7, 2e8, 1e9, 5e9))


def _load_bull_alignment_by_date(run_date: str) -> dict[str, float]:
    rows = d1_client.query(
        """
        WITH ordered AS (
          SELECT
            sp.stock_id,
            sp.date,
            sp.close,
            AVG(sp.close) OVER (
              PARTITION BY sp.stock_id ORDER BY sp.date
              ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
            ) AS ma5,
            AVG(sp.close) OVER (
              PARTITION BY sp.stock_id ORDER BY sp.date
              ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
            ) AS ma10,
            AVG(sp.close) OVER (
              PARTITION BY sp.stock_id ORDER BY sp.date
              ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ) AS ma20,
            AVG(sp.close) OVER (
              PARTITION BY sp.stock_id ORDER BY sp.date
              ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
            ) AS ma60,
            COUNT(sp.close) OVER (
              PARTITION BY sp.stock_id ORDER BY sp.date
              ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
            ) AS n60
          FROM stock_prices sp
          JOIN stocks s ON s.id = sp.stock_id
          WHERE sp.date <= ?
            AND sp.close IS NOT NULL
            AND COALESCE(s.symbol, '') NOT IN ('0050', 'TAIEX', '^TWII', '^TWOII')
            AND instr(UPPER(COALESCE(s.market, '')), 'ETF') = 0
            AND instr(UPPER(COALESCE(s.market, '')), 'WARRANT') = 0
        )
        SELECT
          date,
          SUM(CASE WHEN n60 >= 60 THEN 1 ELSE 0 END) AS eligible,
          SUM(
            CASE
              WHEN n60 >= 60 AND ma5 > ma10 AND ma10 > ma20 AND ma20 > ma60 THEN 1
              ELSE 0
            END
          ) AS aligned
        FROM ordered
        GROUP BY date
        HAVING eligible > 0
        ORDER BY date ASC
        """,
        [run_date],
        timeout=120.0,
    )
    out: dict[str, float] = {}
    for row in rows or []:
        eligible = _as_float(row.get("eligible"), 0.0)
        if eligible <= 0:
            continue
        out[str(row["date"])] = round(_as_float(row.get("aligned"), 0.0) / eligible, 4)
    return out


def _load_lifecycle_weights_from_model_pool(trading_cfg: dict) -> dict[str, float]:
    """Build legacy PredictRequest lifecycle_weights from model_pool.json.

    model_pool.json is the source of truth. The returned map is only a transport
    adapter for older prediction code that still accepts lifecycle_weights.
    """
    try:
        import json as _json
        import os
        from google.cloud import storage

        bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
        if not bucket_name:
            return {}

        blob = storage.Client().bucket(bucket_name).blob("universal/model_pool.json")
        if not blob.exists():
            return {}

        pool = _json.loads(blob.download_as_text())
        degraded_dampening = (
            trading_cfg.get("mlPool", {}).get("degradedDampening")
            if isinstance(trading_cfg.get("mlPool"), dict)
            else None
        )
        degraded_dampening = float(degraded_dampening if degraded_dampening is not None else 1.0)

        weights: dict[str, float] = {}
        for name, entry in (pool.get("models") or {}).items():
            status = entry.get("status", "active")
            if status == "degraded":
                weights[name] = degraded_dampening
            elif status in ("retired", "challenger"):
                weights[name] = 0.0
        return weights
    except Exception as e:
        logger.warning(f"[payload_builder] model_pool lifecycle weights read failed: {e}")
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# Data shapes (match worker payload schema 1:1)
# ─────────────────────────────────────────────────────────────────────────────

def _load_current_regime_label() -> str | None:
    contract = resolve_market_regime_contract(kv_client)
    if contract.get("missing"):
        return None
    return str(contract.get("alpha_regime") or contract.get("label") or "") or None


def load_effective_adaptive_params() -> dict:
    """Load KV adaptive params and resolve P8 regime overrides for ML runtime."""
    raw = kv_client.get_json("ml:adaptive_params", default={}) or {}
    regime = _load_current_regime_label()
    return resolve_adaptive_params_for_regime(raw, regime)


@dataclass
class MarketEnv:
    """共用 market environment — 對應 worker line 1124-1147"""
    risk_score: float = 50.0
    risk_level: str = "medium"
    twii_return_1d: float = 0.0
    twii_return_5d: float = 0.0
    twii_bias_20d: float = 0.0
    history: dict = field(default_factory=dict)
    us_sox_return: Optional[float] = None
    us_gspc_return: Optional[float] = None
    us_dxy_return: Optional[float] = None
    us_hy_spread: Optional[float] = None
    us_hy_spread_chg: Optional[float] = None
    us_vix: Optional[float] = None
    us_sentiment: Optional[str] = None
    advance_ratio: Optional[float] = None
    bull_alignment_pct: Optional[float] = None
    revenue_yoy: Optional[float] = None
    margin_balance: Optional[float] = None
    short_ratio: Optional[float] = None
    margin_change_5d: Optional[float] = None
    retail_pct: Optional[float] = None


@dataclass
class PredictPayload:
    """單股 PredictRequest payload — 對應 ml-service/app/main.py:69-87 PredictRequest schema"""
    stock_id: int
    symbol: str
    prices: list[dict] = field(default_factory=list)
    indicators: list[dict] = field(default_factory=list)
    chips: list[dict] = field(default_factory=list)
    sentiment_scores: list[dict] = field(default_factory=list)
    horizon: int = 14
    real_accuracies: dict[str, float] = field(default_factory=dict)
    model_stats: dict[str, dict] = field(default_factory=dict)
    market: str = "TW"
    market_env: dict = field(default_factory=dict)
    adaptive_params: dict = field(default_factory=dict)
    trading_config: dict = field(default_factory=dict)  # B12 fix (2026-04-08): Optuna baseline (sltp/signal/circuit)
    lifecycle_weights: dict[str, float] = field(default_factory=dict)
    barrier_params: dict = field(default_factory=dict)
    stock_meta: dict = field(default_factory=dict)  # Universal Model: sector/cap/volume/cross-sectional
    runtime_options: dict = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Shared market env loader (one-shot, all stocks share)
# ─────────────────────────────────────────────────────────────────────────────

def load_market_env(run_date: str) -> tuple[MarketEnv, dict, dict, dict[str, float], dict]:
    """
    Load shared market data + adaptive_params + barrier_params + lifecycle_weights + trading_config.

    Returns:
        (market_env, adaptive_params, barrier_params, lifecycle_weights, trading_config)

    Maps to worker/src/index.ts:1013-1075.
    """
    # ── 1. Latest market_risk row ───────────────────────────────────────────
    risk_rows = d1_client.query(
        "SELECT date, risk_level, risk_score, risk_summary "
        "FROM market_risk WHERE date <= ? ORDER BY date DESC LIMIT 1",
        [run_date],
    )
    risk_row = risk_rows[0] if risk_rows else {}

    # ── 2. TAIEX 25 days for twii returns ───────────────────────────────────
    twii_history_rows = d1_client.query(
        "SELECT date, close FROM stock_prices "
        "WHERE stock_id=(SELECT id FROM stocks WHERE symbol IN ('TAIEX','^TWII') LIMIT 1) "
        "AND date <= ? ORDER BY date ASC LIMIT 800",
        [run_date],
    )
    twii_rows = twii_history_rows[-25:]
    twii_arr = [r["close"] for r in twii_rows]
    twii_1d = (twii_arr[-1] - twii_arr[-2]) / twii_arr[-2] if len(twii_arr) >= 2 else 0.0
    twii_5d = (twii_arr[-1] - twii_arr[-6]) / twii_arr[-6] if len(twii_arr) >= 6 else 0.0
    if len(twii_arr) >= 20:
        twii_ma20 = sum(twii_arr[-20:]) / 20
    else:
        twii_ma20 = twii_arr[-1] if twii_arr else 0.0
    twii_bias_20d = (twii_arr[-1] - twii_ma20) / twii_ma20 if twii_arr and twii_ma20 else 0.0

    # Market history uses market_risk plus true TAIEX/^TWII price history.
    # If TAIEX is missing, the payload degrades instead of substituting ETF data.
    # market_risk 只有 ~15 天（3/23 起），但 retrain 需要 3 年歷史。
    history_map: dict[str, dict] = {}

    # 3a. market_risk 真值（有的日期用這個）
    history_rows = d1_client.query(
        "SELECT date, risk_score, risk_level, twii_bias as market_bias_20d, twii_close, "
        "       foreign_consecutive_sell, foreign_net_5d, limit_down_count, limit_down_pct, "
        "       adl_value, adl_trend "
        "FROM market_risk WHERE date <= ? ORDER BY date ASC LIMIT 500",
        [run_date],
    )
    adl_trend_map = {"up": 1.0, "flat": 0.0, "down": -1.0}
    for i, row in enumerate(history_rows):
        prev1 = history_rows[i - 1]["twii_close"] if i >= 1 else None
        prev5 = history_rows[i - 5]["twii_close"] if i >= 5 else None
        history_map[row["date"]] = {
            "risk_score": row.get("risk_score"),
            "risk_level": row.get("risk_level"),
            "market_bias_20d": row.get("market_bias_20d"),
            "market_return_1d": (row["twii_close"] - prev1) / prev1 if prev1 else 0,
            "market_return_5d": (row["twii_close"] - prev5) / prev5 if prev5 else 0,
            "foreign_consecutive_sell": row.get("foreign_consecutive_sell", 0),
            "foreign_net_5d_market": row.get("foreign_net_5d", 0),
            "limit_down_count": row.get("limit_down_count", 0),
            "limit_down_pct": row.get("limit_down_pct", 0),
            "adl_value": row.get("adl_value", 0),
            "adl_trend_numeric": adl_trend_map.get(str(row.get("adl_trend") or "flat"), 0.0),
        }

    # 3b-pre. US market signals 歷史（VIX 用於 risk_score 計算）
    us_history_by_date: dict[str, dict] = {}
    us_rows = d1_client.query(
        "SELECT date, vix_close, hy_spread, hy_spread_chg, sox_return, gspc_return, dxy_return, sentiment "
        "FROM us_market_signals WHERE date <= ? ORDER BY date ASC",
        [run_date],
    )
    for r in (us_rows or []):
        us_history_by_date[r["date"]] = {
            "vix_close": r.get("vix_close"),
            "hy_spread": r.get("hy_spread"),
            "hy_spread_chg": r.get("hy_spread_chg"),
            "sox_return": r.get("sox_return"),
            "gspc_return": r.get("gspc_return"),
            "dxy_return": r.get("dxy_return"),
            "sentiment": r.get("sentiment"),
        }

    # 3c. ADL (Advance/Decline Line) — 每日上漲家數 - 下跌家數的累積
    # 從全市場 stock_prices 算，不依賴 market_risk 表
    adl_rows = d1_client.query(
        "SELECT date, "
        "  SUM(CASE WHEN close > prev_close THEN 1 ELSE 0 END) as advances, "
        "  SUM(CASE WHEN close < prev_close THEN 1 ELSE 0 END) as declines "
        "FROM ( "
        "  SELECT sp.date, sp.close, "
        "    LAG(sp.close) OVER (PARTITION BY sp.stock_id ORDER BY sp.date) as prev_close "
        "  FROM stock_prices sp "
        ") WHERE prev_close IS NOT NULL AND date <= ? "
        "GROUP BY date ORDER BY date ASC",
        [run_date],
    )
    # 累積 ADL + 5d trend + advance_ratio
    adl_by_date: dict[str, tuple[float, float]] = {}  # {date: (adl_value, adl_trend_numeric)}
    advance_ratio_by_date: dict[str, float] = {}  # {date: advance_ratio}
    if adl_rows:
        cumulative_adl = 0.0
        adl_history = []
        for row in adl_rows:
            advances = row.get("advances") or 0
            declines = row.get("declines") or 0
            daily_ad = advances - declines
            cumulative_adl += daily_ad
            adl_history.append(cumulative_adl)
            # trend: 5d direction (1=up, 0=flat, -1=down)
            if len(adl_history) >= 5:
                trend = 1.0 if cumulative_adl > adl_history[-5] else (-1.0 if cumulative_adl < adl_history[-5] else 0.0)
            else:
                trend = 0.0
            # normalize ADL to ~[-1, 1] range (divide by typical daily count ~2000)
            adl_by_date[row["date"]] = (round(cumulative_adl / 2000, 4), trend)
            # advance_ratio for supplemental official/global time-series
            total = advances + declines
            advance_ratio_by_date[row["date"]] = round(advances / total, 4) if total > 0 else 0.5
        logger.info(f"[payload_builder] ADL computed for {len(adl_by_date)} dates from stock_prices")

    # 3d. Bull alignment + Limit down from stock_prices
    # bull_alignment = % of stocks where MA5 > MA10 > MA20 > MA60.
    # limit_down = stocks hitting -10% daily limit
    breadth_rows = d1_client.query(
        "SELECT sp.date, "
        "  COUNT(*) as total, "
        "  SUM(CASE WHEN sp.close >= sp.open * 0.9 AND sp.close <= sp.open * 0.905 THEN 1 ELSE 0 END) as limit_down_count "
        "FROM stock_prices sp "
        "WHERE sp.date >= '2023-01-01' AND sp.date <= ? "
        "GROUP BY sp.date ORDER BY sp.date ASC",
        [run_date],
    )
    breadth_by_date: dict[str, tuple[float, float]] = {}  # {date: (limit_down_count, limit_down_pct)}
    if breadth_rows:
        for row in breadth_rows:
            total = row.get("total", 1) or 1
            ld_count = row.get("limit_down_count", 0) or 0
            ld_pct = round(ld_count / total, 4)
            breadth_by_date[row["date"]] = (ld_count, ld_pct)
        logger.info(f"[payload_builder] Breadth computed for {len(breadth_by_date)} dates")

    bull_by_date = _load_bull_alignment_by_date(run_date)

    if twii_history_rows:
        for i, row in enumerate(twii_history_rows):
            date_str = row["date"]
            if date_str in history_map:
                # market_risk 有真值，但補上 computed fields if missing
                adl_val, adl_trend = adl_by_date.get(date_str, (0, 0))
                ld_count, ld_pct = breadth_by_date.get(date_str, (0, 0))
                if history_map[date_str].get("adl_value", 0) == 0:
                    history_map[date_str]["adl_value"] = adl_val
                    history_map[date_str]["adl_trend_numeric"] = adl_trend
                if history_map[date_str].get("limit_down_count", 0) == 0:
                    history_map[date_str]["limit_down_count"] = ld_count
                    history_map[date_str]["limit_down_pct"] = ld_pct
                if "bull_alignment_pct" not in history_map[date_str]:
                    history_map[date_str]["bull_alignment_pct"] = bull_by_date.get(date_str, 0)
                continue
            close = float(row["close"])
            prev1_close = float(twii_history_rows[i - 1]["close"]) if i >= 1 else close
            prev5_close = float(twii_history_rows[i - 5]["close"]) if i >= 5 else close
            if i >= 20:
                ma20 = sum(float(twii_history_rows[j]["close"]) for j in range(i - 19, i + 1)) / 20
                bias_20d = (close - ma20) / ma20 if ma20 else 0
            else:
                bias_20d = 0
            adl_val, adl_trend = adl_by_date.get(date_str, (0, 0))
            ld_count, ld_pct = breadth_by_date.get(date_str, (0, 0))
            # ── Compute risk_score from available data (mirrors Worker calcRiskScore) ──
            _rs = 0
            _vix_row = us_history_by_date.get(date_str, {})
            _vix = _vix_row.get("vix_close")
            if _vix is not None:
                if _vix >= 40: _rs += 35
                elif _vix >= 30: _rs += 25
                elif _vix >= 20: _rs += 15
                elif _vix >= 15: _rs += 5
            # bias contribution (max 15)
            _abs_bias = abs(bias_20d * 100) if bias_20d else 0
            if _abs_bias >= 10: _rs += 15
            elif _abs_bias >= 6: _rs += 8
            elif _abs_bias >= 3: _rs += 3
            # ADL trend (max 8)
            if adl_trend < 0: _rs += 8
            # bull alignment (max 8)
            _ba = bull_by_date.get(date_str, 0.5)
            if _ba < 0.2: _rs += 8
            elif _ba < 0.3: _rs += 4
            _rs = min(100, _rs)
            _rl = "green" if _rs <= 25 else "yellow" if _rs <= 45 else "orange" if _rs <= 65 else "red" if _rs <= 85 else "black"

            history_map[date_str] = {
                "risk_score": _rs,
                "risk_level": _rl,
                "market_bias_20d": round(bias_20d, 4),
                "market_return_1d": round((close - prev1_close) / prev1_close, 6) if prev1_close else 0,
                "market_return_5d": round((close - prev5_close) / prev5_close, 6) if prev5_close else 0,
                "foreign_consecutive_sell": 0,
                "foreign_net_5d_market": 0,
                "limit_down_count": ld_count,
                "limit_down_pct": ld_pct,
                "adl_value": adl_val,
                "adl_trend_numeric": adl_trend,
                "bull_alignment_pct": bull_by_date.get(date_str, 0),
            }
        logger.info(f"[payload_builder] Market history: {len(history_rows)} from market_risk + {len(twii_history_rows)} from TAIEX = {len(history_map)} total dates")

    # ── 3e. Merge US signals + advance_ratio into history_map (supplemental official/global time-series) ──
    us_sent_map = {"bullish": 1.0, "neutral": 0.0, "bearish": -1.0}
    merged_us = 0
    for date_str, us_data in us_history_by_date.items():
        if date_str not in history_map:
            history_map[date_str] = {}
        history_map[date_str]["us_sox_return"] = us_data.get("sox_return") or 0.0
        history_map[date_str]["us_gspc_return"] = us_data.get("gspc_return") or 0.0
        history_map[date_str]["us_dxy_return"] = us_data.get("dxy_return") or 0.0
        history_map[date_str]["us_hy_spread"] = us_data.get("hy_spread") or 3.5
        history_map[date_str]["us_hy_spread_chg"] = us_data.get("hy_spread_chg") or 0.0
        history_map[date_str]["us_vix"] = us_data.get("vix_close") or 20.0
        history_map[date_str]["us_sentiment_score"] = us_sent_map.get(
            str(us_data.get("sentiment") or "neutral"), 0.0
        )
        merged_us += 1
    # advance_ratio from ADL computation
    for date_str, ar_val in advance_ratio_by_date.items():
        if date_str not in history_map:
            history_map[date_str] = {}
        history_map[date_str]["advance_ratio"] = ar_val
    if merged_us:
        logger.info(f"[payload_builder] Merged {merged_us} US signal dates + {len(advance_ratio_by_date)} advance_ratio dates into history_map")

    # ── 4. US leading signals (KV us:leading:{date}) ────────────────────────
    us_signal = kv_client.get_json(f"us:leading:{run_date}", default={}) or {}

    # ── 5. Latest market_breadth ────────────────────────────────────────────
    try:
        breadth_rows = d1_client.query(
            "SELECT date, advance_ratio, bull_alignment_pct "
            "FROM market_breadth WHERE date <= ? ORDER BY date DESC LIMIT 5",
            [run_date],
        )
    except RuntimeError as e:
        logger.warning("[payload_builder] market_breadth unavailable; degrading market_env: %s", e)
        breadth_rows = []
    latest_breadth = breadth_rows[0] if breadth_rows else {}

    # ── 6. Adaptive params from KV ──────────────────────────────────────────
    adaptive_params = load_effective_adaptive_params()

    # ── 7. Trading config → barrier_params ──────────────────────────────────
    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    trading_cfg = cfg_result.config
    if cfg_result.contract.degraded:
        logger.warning("[payload_builder] trading:config degraded: %s", cfg_result.contract.to_dict())
    barrier_cfg = trading_cfg.get("barrier", {})
    barrier_params = {
        "upper_mult": barrier_cfg.get("upperMult"),
        "lower_mult": barrier_cfg.get("lowerMult"),
        "upper_pct_cap": barrier_cfg.get("upperPctCap"),
        "lower_pct_cap": barrier_cfg.get("lowerPctCap"),
        "max_days": barrier_cfg.get("maxDays"),
    }

    # 8. Lifecycle weights from model_pool.json (single source of truth).
    lifecycle_weights = _load_lifecycle_weights_from_model_pool(trading_cfg)

    # ── Build MarketEnv ─────────────────────────────────────────────────────
    market_env = MarketEnv(
        risk_score=risk_row.get("risk_score") or 50,
        risk_level=risk_row.get("risk_level") or "medium",
        twii_return_1d=twii_1d,
        twii_return_5d=twii_5d,
        twii_bias_20d=twii_bias_20d,
        history=history_map,
        us_sox_return=us_signal.get("sox_return"),
        us_gspc_return=us_signal.get("gspc_return"),
        us_dxy_return=us_signal.get("dxy_return"),
        us_hy_spread=us_signal.get("hy_spread"),
        us_hy_spread_chg=us_signal.get("hy_spread_chg"),
        us_vix=us_signal.get("vix_close"),
        us_sentiment=us_signal.get("sentiment"),
        advance_ratio=latest_breadth.get("advance_ratio"),
        bull_alignment_pct=latest_breadth.get("bull_alignment_pct"),
    )

    return market_env, adaptive_params, barrier_params, lifecycle_weights, trading_cfg


# ─────────────────────────────────────────────────────────────────────────────
# Bulk per-stock loaders — pull all active stocks in single queries
# ─────────────────────────────────────────────────────────────────────────────

def _bulk_load_prices(
    stock_ids: list[int],
    limit: int = 500,
    as_of_date: str | None = None,
) -> dict[int, list[dict]]:
    """
    Load last `limit` rows of stock_prices for each stock_id.
    Returns: {stock_id: [{date, close, high, low, open, volume}, ...]} (oldest→newest).

    D1 doesn't support window functions efficiently, so we pull all rows for the
    relevant date range then group in-memory. Use date >= '-2 years' as cutoff.
    """
    if not stock_ids:
        return {}
    grouped: dict[int, list[dict]] = {sid: [] for sid in stock_ids}
    upper_bound_sql = " AND date <= ?" if as_of_date else ""
    for chunk in _chunked(stock_ids):
        placeholders = ",".join("?" * len(chunk))
        params: list[Any] = list(chunk)
        if as_of_date:
            params.append(as_of_date)
        rows = d1_client.query(
            f"SELECT stock_id, date, open, high, low, close, volume, adj_close, avg_price "
            f"FROM stock_prices "
            f"WHERE stock_id IN ({placeholders}) AND date >= date('now','-3 years')"
            f"{upper_bound_sql} "
            f"ORDER BY stock_id ASC, date ASC",
            params,
            timeout=120.0,
        )
        for r in rows:
            sid = r["stock_id"]
            if sid in grouped:
                grouped[sid].append({
                    "date": r["date"],
                    "open": r["open"], "high": r["high"], "low": r["low"],
                    "close": r["close"], "volume": r["volume"],
                    "adj_close": r.get("adj_close"), "avg_price": r.get("avg_price"),
                })
    # Truncate to last `limit` per stock (oldest is dropped if > limit)
    for sid in grouped:
        if len(grouped[sid]) > limit:
            grouped[sid] = grouped[sid][-limit:]
    return grouped


def _bulk_load_indicators(
    stock_ids: list[int],
    limit: int = 500,
    as_of_date: str | None = None,
) -> dict[int, list[dict]]:
    if not stock_ids:
        return {}
    grouped: dict[int, list[dict]] = {sid: [] for sid in stock_ids}
    upper_bound_sql = " AND date <= ?" if as_of_date else ""
    for chunk in _chunked(stock_ids):
        placeholders = ",".join("?" * len(chunk))
        params: list[Any] = list(chunk)
        if as_of_date:
            params.append(as_of_date)
        rows = d1_client.query(
            f"SELECT stock_id, date, ma5, ma10, ma20, ma60, rsi14, "
            f"       macd_hist as macdHist, bb_upper, bb_lower, atr14, "
            f"       plus_di14, minus_di14, adx14, parabolic_sar, cci20, "
            f"       volume_weighted_rsi14, volume_momentum_divergence_13_27_10, "
            f"       squeeze_on, squeeze_release, squeeze_momentum, obv_temperature_60, "
            f"       adaptive_rsi_midline_50, adaptive_rsi_upper_50, adaptive_rsi_lower_50, "
            f"       adaptive_rsi_overbought, adaptive_rsi_oversold "
            f"FROM technical_indicators "
            f"WHERE stock_id IN ({placeholders}) AND date >= date('now','-3 years')"
            f"{upper_bound_sql} "
            f"ORDER BY stock_id ASC, date ASC",
            params,
            timeout=120.0,
        )
        for r in rows:
            sid = r["stock_id"]
            if sid in grouped:
                grouped[sid].append({
                    "date": r["date"],
                    "ma5": r.get("ma5"), "ma10": r.get("ma10"),
                    "ma20": r.get("ma20"), "ma60": r.get("ma60"),
                    "rsi14": r.get("rsi14"), "macdHist": r.get("macdHist"),
                    "bb_upper": r.get("bb_upper"), "bb_lower": r.get("bb_lower"),
                    "atr14": r.get("atr14"),
                    "plusDi14": r.get("plus_di14"),
                    "minusDi14": r.get("minus_di14"),
                    "adx14": r.get("adx14"),
                    "parabolicSar": r.get("parabolic_sar"),
                    "cci20": r.get("cci20"),
                    "volumeWeightedRsi14": r.get("volume_weighted_rsi14"),
                    "volumeMomentumDivergence132710": r.get("volume_momentum_divergence_13_27_10"),
                    "squeezeOn": r.get("squeeze_on"),
                    "squeezeRelease": r.get("squeeze_release"),
                    "squeezeMomentum": r.get("squeeze_momentum"),
                    "obvTemperature60": r.get("obv_temperature_60"),
                    "adaptiveRsiMidline50": r.get("adaptive_rsi_midline_50"),
                    "adaptiveRsiUpper50": r.get("adaptive_rsi_upper_50"),
                    "adaptiveRsiLower50": r.get("adaptive_rsi_lower_50"),
                    "adaptiveRsiOverbought": r.get("adaptive_rsi_overbought"),
                    "adaptiveRsiOversold": r.get("adaptive_rsi_oversold"),
                })
    for sid in grouped:
        if len(grouped[sid]) > limit:
            grouped[sid] = grouped[sid][-limit:]
    return grouped


def _bulk_load_chips(
    symbols: list[str],
    limit: int = 200,
    as_of_date: str | None = None,
) -> dict[str, list[dict]]:
    """Load chip rows with FinLab canonical data first and legacy chip_data fallback.

    `chip_data` stores TWSE/TPEX institution flow by symbol. FinLab V4.1 adds
    canonical tables where listed/OTC keeps institution nets and emerging stocks
    expose ROTC broker flow evidence. The payload must carry that evidence
    or recommendation reasons fall back to the old "institution balance" text.
    """
    if not symbols:
        return {}
    grouped_by_date: dict[str, dict[str, dict]] = {s: {} for s in symbols}
    upper_bound_sql = " AND date <= ?" if as_of_date else ""

    for chunk in _chunked(symbols):
        placeholders = ",".join("?" * len(chunk))
        params: list[Any] = list(chunk)
        if as_of_date:
            params.append(as_of_date)
        rows = d1_client.query(
            f"SELECT symbol, date, foreign_net, trust_net, dealer_net, "
            f"       margin_balance, short_balance "
            f"FROM chip_data "
            f"WHERE symbol IN ({placeholders}) AND date >= date('now','-1 year')"
            f"{upper_bound_sql} "
            f"ORDER BY symbol ASC, date ASC",
            params,
            timeout=60.0,
        )
        for r in rows:
            sym = r["symbol"]
            if sym in grouped_by_date:
                grouped_by_date[sym][r["date"]] = {
                    "date": r["date"],
                    "foreign_net": r.get("foreign_net"),
                    "trust_net": r.get("trust_net"),
                    "dealer_net": r.get("dealer_net"),
                    "margin_balance": r.get("margin_balance"),
                    "short_balance": r.get("short_balance"),
                    "chip_source": "legacy.chip_data",
                }

    try:
        for chunk in _chunked(symbols):
            placeholders = ",".join("?" * len(chunk))
            params: list[Any] = list(chunk)
            if as_of_date:
                params.append(as_of_date)
            canonical_rows = d1_client.query(
                f"SELECT stock_id AS symbol, date, market_segment, foreign_net, trust_net, dealer_net, "
                f"       margin_balance, short_balance, source, as_of_date "
                f"FROM canonical_chip_daily "
                f"WHERE stock_id IN ({placeholders}) AND date >= date('now','-1 year')"
                f"{upper_bound_sql} "
                f"ORDER BY stock_id ASC, date ASC",
                params,
                timeout=60.0,
            )
            for r in canonical_rows:
                sym = r["symbol"]
                if sym not in grouped_by_date:
                    continue
                current = grouped_by_date[sym].get(r["date"], {"date": r["date"]})
                current.update({
                    "foreign_net": r.get("foreign_net"),
                    "trust_net": r.get("trust_net"),
                    "dealer_net": r.get("dealer_net"),
                    "margin_balance": r.get("margin_balance"),
                    "short_balance": r.get("short_balance"),
                    "chip_source": r.get("source") or "canonical_chip_daily",
                    "market_segment": r.get("market_segment"),
                    "as_of_date": r.get("as_of_date"),
                })
                grouped_by_date[sym][r["date"]] = current
    except Exception as exc:
        logger.debug("[payload_builder] canonical_chip_daily unavailable, using legacy chip_data fallback: %s", exc)

    try:
        for chunk in _chunked(symbols):
            placeholders = ",".join("?" * len(chunk))
            params: list[Any] = list(chunk)
            if as_of_date:
                params.append(as_of_date)
            broker_rows = d1_client.query(
                f"SELECT stock_id AS symbol, date, market_segment, net_shares, estimated_amount, "
                f"       broker_count, concentration, source, as_of_date "
                f"FROM canonical_broker_flow_daily "
                f"WHERE stock_id IN ({placeholders}) AND date >= date('now','-1 year')"
                f"{upper_bound_sql} "
                f"ORDER BY stock_id ASC, date ASC",
                params,
                timeout=60.0,
            )
            for r in broker_rows:
                sym = r["symbol"]
                if sym not in grouped_by_date:
                    continue
                current = grouped_by_date[sym].get(r["date"], {"date": r["date"]})
                net_shares = float(r.get("net_shares") or 0.0)
                if str(current.get("market_segment") or r.get("market_segment") or "").upper() == "EMERGING":
                    current["dealer_net"] = net_shares
                else:
                    current["dealer_net"] = float(current.get("dealer_net") or 0.0) + net_shares
                current["broker_net_shares"] = float(current.get("broker_net_shares") or 0.0) + net_shares
                current["broker_estimated_amount"] = float(current.get("broker_estimated_amount") or 0.0) + float(r.get("estimated_amount") or 0.0)
                current["broker_count"] = r.get("broker_count")
                current["broker_concentration"] = r.get("concentration")
                current["chip_source"] = r.get("source") or "finlab.rotc_broker_transactions"
                current["market_segment"] = r.get("market_segment") or "EMERGING"
                current["as_of_date"] = r.get("as_of_date")
                grouped_by_date[sym][r["date"]] = current
    except Exception as exc:
        logger.debug("[payload_builder] canonical_broker_flow_daily unavailable, using institution-only chip payload: %s", exc)

    grouped: dict[str, list[dict]] = {}
    for sym, by_date in grouped_by_date.items():
        rows_for_symbol = sorted(by_date.values(), key=lambda row: str(row.get("date") or ""))
        grouped[sym] = rows_for_symbol[-limit:] if len(rows_for_symbol) > limit else rows_for_symbol
    return grouped


def _bulk_load_sentiment(
    stock_ids: list[int],
    limit: int = 90,
    as_of_date: str | None = None,
) -> dict[int, list[dict]]:
    if not stock_ids:
        return {}
    grouped: dict[int, list[dict]] = {sid: [] for sid in stock_ids}
    upper_bound_sql = "AND date(published_at) <= ? " if as_of_date else ""
    for chunk in _chunked(stock_ids):
        placeholders = ",".join("?" * len(chunk))
        params: list[Any] = list(chunk)
        if as_of_date:
            params.append(as_of_date)
        rows = d1_client.query(
            f"SELECT stock_id, date(published_at) as date, "
            f"       AVG(CASE sentiment WHEN 'positive' THEN 1 WHEN 'negative' THEN -1 ELSE 0 END) as score "
            f"FROM news WHERE stock_id IN ({placeholders}) "
            f"AND published_at >= date('now','-180 days') "
            f"{upper_bound_sql}"
            f"GROUP BY stock_id, date(published_at) "
            f"ORDER BY stock_id ASC, date ASC",
            params,
            timeout=60.0,
        )
        for r in rows:
            sid = r["stock_id"]
            if sid in grouped:
                grouped[sid].append({"date": r["date"], "score": r["score"]})
    for sid in grouped:
        if len(grouped[sid]) > limit:
            grouped[sid] = grouped[sid][-limit:]
    return grouped


def _bulk_load_accuracies(
    stock_ids: list[int],
) -> tuple[dict[int, dict[str, float]], dict[int, dict[str, dict]]]:
    """
    Load model_accuracy WHERE period='30d' AND total_count >= 5.
    Returns: (real_accuracies_by_stock, model_stats_by_stock)
    """
    if not stock_ids:
        return {}, {}
    real_acc: dict[int, dict[str, float]] = {sid: {} for sid in stock_ids}
    model_stats: dict[int, dict[str, dict]] = {sid: {} for sid in stock_ids}
    for chunk in _chunked(stock_ids):
        placeholders = ",".join("?" * len(chunk))
        rows = d1_client.query(
            f"SELECT stock_id, model_name, accuracy, profit_factor, expectancy, "
            f"       avg_win_pct, avg_loss_pct, avg_trade_pnl_r, "
            f"       hit_target_rate, hit_stop_rate "
            f"FROM model_accuracy "
            f"WHERE stock_id IN ({placeholders}) AND period='30d' AND total_count >= 5",
            list(chunk),
            timeout=60.0,
        )
        for r in rows:
            sid = r["stock_id"]
            if sid not in real_acc:
                continue
            name = r["model_name"]
            real_acc[sid][name] = r.get("accuracy") or 0
            model_stats[sid][name] = {
                "profit_factor": r.get("profit_factor"),
                "expectancy": r.get("expectancy"),
                "avg_win_pct": r.get("avg_win_pct"),
                "avg_loss_pct": r.get("avg_loss_pct"),
                "avg_pnl_r": r.get("avg_trade_pnl_r"),
                "hit_target_rate": r.get("hit_target_rate"),
                "hit_stop_rate": r.get("hit_stop_rate"),
            }
    return real_acc, model_stats


def _bulk_load_per_stock_misc(stock_ids: list[int], as_of_date: str | None = None) -> dict[int, dict]:
    """
    Per-stock margin / shareholding / monthly_revenue (latest 1 row each).
    Returns: {stock_id: {margin_balance, short_ratio, margin_5d_ago, retail_pct, revenue_yoy}}

    Worker did 4 separate queries per stock — we do 4 bulk queries total.
    """
    if not stock_ids:
        return {}
    out: dict[int, dict] = {sid: {} for sid in stock_ids}
    upper_bound_sql = " AND date <= ?" if as_of_date else ""

    # margin: latest
    for chunk in _chunked(stock_ids):
        placeholders = ",".join("?" * len(chunk))
        params: list[Any] = list(chunk)
        if as_of_date:
            params.append(as_of_date)
        margin_rows = d1_client.query(
            f"SELECT m1.stock_id, m1.margin_balance, m1.short_ratio "
            f"FROM margin_data m1 "
            f"INNER JOIN ("
            f"  SELECT stock_id, MAX(date) as max_date "
            f"  FROM margin_data WHERE stock_id IN ({placeholders})"
            f"{upper_bound_sql} GROUP BY stock_id"
            f") m2 ON m1.stock_id = m2.stock_id AND m1.date = m2.max_date",
            params,
            timeout=60.0,
        )
        for r in margin_rows:
            sid = r["stock_id"]
            if sid in out:
                out[sid]["margin_balance"] = r.get("margin_balance")
                out[sid]["short_ratio"] = r.get("short_ratio")

    # margin: 5 days ago (offset 5 from latest) — too complex bulk; do nullable fallback
    # Skip for now; worker behavior is non-blocking (catch → null)

    # shareholding: latest retail_pct
    for chunk in _chunked(stock_ids):
        placeholders = ",".join("?" * len(chunk))
        params = list(chunk)
        if as_of_date:
            params.append(as_of_date)
        sh_rows = d1_client.query(
            f"SELECT s1.stock_id, s1.retail_pct "
            f"FROM shareholding s1 "
            f"INNER JOIN ("
            f"  SELECT stock_id, MAX(date) as max_date "
            f"  FROM shareholding WHERE stock_id IN ({placeholders})"
            f"{upper_bound_sql} GROUP BY stock_id"
            f") s2 ON s1.stock_id = s2.stock_id AND s1.date = s2.max_date",
            params,
            timeout=60.0,
        )
        for r in sh_rows:
            sid = r["stock_id"]
            if sid in out:
                out[sid]["retail_pct"] = r.get("retail_pct")

    # monthly_revenue: latest revenue_yoy
    for chunk in _chunked(stock_ids):
        placeholders = ",".join("?" * len(chunk))
        params = list(chunk)
        if as_of_date:
            params.append(as_of_date)
        rev_rows = d1_client.query(
            f"SELECT r1.stock_id, r1.revenue_yoy "
            f"FROM monthly_revenue r1 "
            f"INNER JOIN ("
            f"  SELECT stock_id, MAX(date) as max_date "
            f"  FROM monthly_revenue WHERE stock_id IN ({placeholders})"
            f"{upper_bound_sql} GROUP BY stock_id"
            f") r2 ON r1.stock_id = r2.stock_id AND r1.date = r2.max_date",
            params,
            timeout=60.0,
        )
        for r in rev_rows:
            sid = r["stock_id"]
            if sid in out:
                out[sid]["revenue_yoy"] = r.get("revenue_yoy")

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def _normalize_market(value: Any) -> str:
    text = str(value or "").strip().upper()
    if text in {"TWSE", "TSE", "LISTED"}:
        return "LISTED"
    if text in {"OTC", "TPEX"}:
        return "OTC"
    if text in {"EMERGING", "ESB"}:
        return "EMERGING"
    return "UNKNOWN"


def _watch_points_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, (str, int, float))]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(v) for v in parsed if isinstance(v, (str, int, float))]
        except Exception:
            return [value]
    return []


def infer_market_segment(stock: dict, latest_price: dict | None = None) -> str:
    """Single ML-facing market segment contract.

    Price-shape wins over stale stock master metadata: avg_price-only rows are
    emerging-board style even when `stocks.market` still says OTC.
    """
    latest_price = latest_price or {}
    if latest_price.get("open") is None and latest_price.get("avg_price") is not None:
        try:
            if float(latest_price.get("avg_price") or 0) > 0:
                return "EMERGING"
        except Exception:
            pass
    lane = str(stock.get("recommendation_lane") or "").strip()
    if lane == "emerging_watchlist":
        return "EMERGING"
    return _normalize_market(stock.get("market"))


def _lane_for_segment(segment: str, stock: dict | None = None) -> str:
    explicit = str((stock or {}).get("recommendation_lane") or "").strip()
    if explicit:
        return explicit
    if segment == "EMERGING":
        return "emerging_watchlist"
    if segment in {"LISTED", "OTC"}:
        return "tradable"
    return "research_only"


def build_stock_meta_with_segment(
    base_meta: dict,
    stock: dict,
    latest_price: dict | None = None,
) -> dict:
    segment = infer_market_segment(stock, latest_price)
    policy = policy_for_segment(segment)
    lane = str(stock.get("recommendation_lane") or "").strip() or policy.recommendation_lane
    if not policy.eligible_for_execution:
        lane = policy.recommendation_lane
    eligible_for_execution = policy.eligible_for_execution and lane == "tradable"
    return {
        **base_meta,
        "market_segment": segment,
        "recommendation_lane": lane,
        "eligible_for_ml": policy.eligible_for_ml,
        "eligible_for_execution": eligible_for_execution,
        "eligible_for_pending_buy": eligible_for_execution,
        "segment_serving_mode": policy.serving_mode,
        "segment_model_pool_scope": policy.model_pool_scope,
        "segment_calibration_scope": policy.calibration_scope,
        "segment_calibration_artifact_prefix": policy.calibration_artifact_prefix,
        "train_serve_parity_required": policy.train_serve_parity_required,
        "segment_min_ic_samples": policy.min_ic_samples,
        "segment_min_active_days": policy.min_active_days,
    }


def build_ml_universe(active_stocks: list[dict], screener_recs: list[dict]) -> list[dict]:
    """Union execution watchlist with research-only ML candidates.

    Execution watchlist remains the source for auto-tradable names. Emerging
    recommendations are added only to ML serving so we can collect predictions,
    IC, and calibration evidence without letting them reach pending buys.
    """
    by_symbol: dict[str, dict] = {}
    for stock in active_stocks or []:
        symbol = str(stock.get("symbol") or "").strip()
        if not symbol:
            continue
        segment = infer_market_segment(stock)
        lane = _lane_for_segment(segment, stock)
        by_symbol[symbol] = {
            **stock,
            "market_segment": segment,
            "recommendation_lane": lane,
            "eligible_for_ml": True,
            "eligible_for_execution": lane == "tradable",
        }

    for rec in screener_recs or []:
        symbol = str(rec.get("symbol") or "").strip()
        stock_id = rec.get("stock_id") or rec.get("id")
        if not symbol or not stock_id or symbol in by_symbol:
            continue
        points = _watch_points_list(rec.get("watch_points"))
        segment = str(rec.get("market_segment") or rec.get("market") or "").strip().upper()
        if not segment:
            segment = "EMERGING" if str(rec.get("recommendation_lane") or "") == "emerging_watchlist" else "LISTED"
        lane = str(rec.get("recommendation_lane") or "").strip()
        is_emerging_research = (
            "research_only:emerging_not_for_auto_trade" in points
            or "board_lane:emerging_watchlist" in points
            or lane == "emerging_watchlist"
            or _normalize_market(segment) == "EMERGING"
        )
        if is_emerging_research:
            segment = "EMERGING"
            lane = "emerging_watchlist"
        else:
            segment = _normalize_market(segment)
            lane = lane or ("tradable" if segment in {"LISTED", "OTC"} else "research_only")
        eligible_for_execution = lane == "tradable" and segment in {"LISTED", "OTC"}
        by_symbol[symbol] = {
            "id": stock_id,
            "symbol": symbol,
            "name": rec.get("name") or symbol,
            "market": segment,
            "sector": rec.get("sector"),
            "source": "daily_recommendations",
            "market_segment": segment,
            "recommendation_lane": lane,
            "eligible_for_ml": True,
            "eligible_for_execution": eligible_for_execution,
        }

    return sorted(by_symbol.values(), key=lambda row: int(row.get("id") or 0))


def _build_stock_meta(
    symbol: str,
    sym_to_sector: dict[str, str],
    sector_enc: dict[str, int],
    sector_avg: dict[str, tuple[float, float]],
    stock_returns: dict[str, tuple[float, float]],
    prices: list[dict],
) -> dict:
    """Build stock_meta dict for universal model features."""
    tag = sym_to_sector.get(symbol, "")
    avg = sector_avg.get(tag, (0.0, 0.0))
    sr = stock_returns.get(symbol, (0.0, 0.0))
    # Volume bucket
    vol_bucket = 2
    if prices and len(prices) >= 20:
        avg_vol = sum(_as_float(p.get("volume"), 0.0) for p in prices[-20:]) / 20
        vol_bucket = 4 if avg_vol > 50_000_000 else 3 if avg_vol > 10_000_000 else 2 if avg_vol > 2_000_000 else 1 if avg_vol > 500_000 else 0
    liquidity_turnover_bucket = _daily_turnover_bucket(prices)
    return {
        "sector_encoded": sector_enc.get(tag, 0),
        "market_cap_bucket": liquidity_turnover_bucket,
        "market_cap_bucket_source": "legacy_schema_daily_turnover_bucket",
        "liquidity_turnover_bucket": liquidity_turnover_bucket,
        "avg_volume_bucket": vol_bucket,
        "sector_peer_return_1d": round(avg[0], 6),
        "sector_peer_return_5d": round(avg[1], 6),
        "stock_vs_sector": round(sr[1] - avg[1], 6),
    }


def build_payloads(
    active_stocks: list[dict],
    market_env: MarketEnv,
    adaptive_params: dict,
    barrier_params: dict,
    lifecycle_weights: dict[str, float],
    trading_config: dict | None = None,
    as_of_date: str | None = None,
) -> list[PredictPayload]:
    """
    Build PredictPayload list for all active stocks.

    Strategy: bulk-load all per-stock data in ~10 queries (vs 8 × N stocks),
    then assemble payloads in-memory.
    """
    if not active_stocks:
        return []

    stock_ids = [s["id"] for s in active_stocks]
    symbols = [s["symbol"] for s in active_stocks]
    logger.info(f"[payload_builder] Building payloads for {len(stock_ids)} active stocks")

    # ── Bulk load all per-stock data ────────────────────────────────────────
    prices_by_id = _bulk_load_prices(stock_ids, as_of_date=as_of_date)
    indicators_by_id = _bulk_load_indicators(stock_ids, as_of_date=as_of_date)
    chips_by_sym = _bulk_load_chips(symbols, as_of_date=as_of_date)
    sentiment_by_id = _bulk_load_sentiment(stock_ids, as_of_date=as_of_date)
    real_acc_by_id, model_stats_by_id = _bulk_load_accuracies(stock_ids)
    misc_by_id = _bulk_load_per_stock_misc(stock_ids, as_of_date=as_of_date)

    # ── Stock meta: sector encoding + cross-sectional features ──────────────
    # Sector tags
    tag_rows = d1_client.query(
        "SELECT symbol, tag FROM stock_tags WHERE tag_type='industry'"
    )
    sym_to_sector: dict[str, str] = {}
    for r in tag_rows:
        sym_to_sector[r["symbol"]] = r["tag"]

    # Build sector encoding (same as retrain_trigger)
    all_sectors = sorted(set(sym_to_sector.values()))
    sector_enc = {s: i for i, s in enumerate(all_sectors)}

    # Per-stock returns for cross-sectional features
    stock_returns: dict[str, tuple[float, float]] = {}  # symbol → (r1d, r5d)
    for stock in active_stocks:
        px = prices_by_id.get(stock["id"], [])
        if len(px) >= 6:
            cl = _price_close(px[-1])
            cl1 = _price_close(px[-2])
            cl5 = _price_close(px[-6])
            r1d = (cl - cl1) / cl1 if cl1 > 0 else 0
            r5d = (cl - cl5) / cl5 if cl5 > 0 else 0
            stock_returns[stock["symbol"]] = (r1d, r5d)

    # Sector averages
    sector_agg: dict[str, list[tuple[float, float]]] = {}
    for sym, (r1d, r5d) in stock_returns.items():
        tag = sym_to_sector.get(sym, "")
        if tag:
            sector_agg.setdefault(tag, []).append((r1d, r5d))
    sector_avg: dict[str, tuple[float, float]] = {}
    for tag, rets in sector_agg.items():
        sector_avg[tag] = (
            sum(r[0] for r in rets) / len(rets),
            sum(r[1] for r in rets) / len(rets),
        )

    # ── Assemble payloads ───────────────────────────────────────────────────
    payloads: list[PredictPayload] = []
    base_env = asdict(market_env)
    for stock in active_stocks:
        sid = stock["id"]
        symbol = stock["symbol"]
        misc = misc_by_id.get(sid, {})

        # Per-stock market_env override (margin / retail / revenue)
        env_for_stock = {
            **base_env,
            "revenue_yoy": misc.get("revenue_yoy"),
            "margin_balance": misc.get("margin_balance"),
            "short_ratio": misc.get("short_ratio"),
            "margin_change_5d": None,  # bulk load skipped, fallback null (worker behavior)
            "retail_pct": misc.get("retail_pct"),
        }

        latest_price = prices_by_id.get(sid, [])[-1] if prices_by_id.get(sid) else {}
        stock_meta = _build_stock_meta(symbol, sym_to_sector, sector_enc, sector_avg, stock_returns, prices_by_id.get(sid, []))
        stock_meta = build_stock_meta_with_segment(stock_meta, stock, latest_price)

        payloads.append(PredictPayload(
            stock_id=sid,
            symbol=symbol,
            prices=prices_by_id.get(sid, []),
            indicators=indicators_by_id.get(sid, []),
            chips=chips_by_sym.get(symbol, []),
            sentiment_scores=sentiment_by_id.get(sid, []),
            horizon=14,
            real_accuracies=real_acc_by_id.get(sid, {}),
            model_stats=model_stats_by_id.get(sid, {}),
            market=stock.get("market") or "TW",
            market_env=env_for_stock,
            adaptive_params=adaptive_params,
            trading_config=trading_config or {},
            lifecycle_weights=lifecycle_weights,
            barrier_params=barrier_params,
            stock_meta=stock_meta,
            runtime_options={
                "embedded_time_series": False,
                "embedded_state_space": False,
                "owner": "daily_pipeline_v2.batch_predict",
            },
        ))

    logger.info(f"[payload_builder] Built {len(payloads)} payloads")
    return payloads
