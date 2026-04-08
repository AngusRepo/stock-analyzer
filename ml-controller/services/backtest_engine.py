"""
backtest_engine.py — Sprint 6a Backtest Engine (rule-based Mode A)

╔══════════════════════════════════════════════════════════════════════════════╗
║ ⚠️  READ BEFORE EDITING OR ACTING ON OUTPUT ⚠️                              ║
║                                                                              ║
║ This file DUPLICATES 7-layer cascade logic from Worker paper.ts.             ║
║ This is a DELIBERATE duplication forced by runtime boundaries                ║
║ (Worker V8 isolate vs Cloud Run Python) — NOT a design choice.               ║
║                                                                              ║
║ paper.ts is the PRODUCTION live-trading path and WILL NOT BE DEPRECATED.     ║
║ Any logic change in paper.ts MUST be mirrored here and vice versa.           ║
║                                                                              ║
║ Mode A has 15 documented deviations from paper.ts that make its Sharpe       ║
║ UNRELIABLE as an absolute production prediction. Use for RELATIVE            ║
║ comparisons only (e.g. Optuna objective). Check BacktestMetrics              ║
║ .realism_warnings + .absolute_confidence + .sanity_flags before acting.      ║
║                                                                              ║
║ Full design rationale, Mode A impact analysis, drift mitigation plan,        ║
║ parity test design, and paper.ts ↔ backtest_engine symbol table:             ║
║                                                                              ║
║   memory/project_backtest_engine_design_rationale.md                         ║
║                                                                              ║
║ Parity test (tests/test_cascade_parity.py) is NOT yet implemented —          ║
║ scheduled for Sprint 6a.7 smoke test phase along with a new Worker           ║
║ test-only endpoint POST /admin/test/exit-cascade.                            ║
╚══════════════════════════════════════════════════════════════════════════════╝

Parameterized primitive for Optuna objective + robust optimization.

Scope (Sprint 6a, Mode A rule-based replay):
  - Data loader: D1 stock_prices / technical_indicators / chip_data / market_risk
    → in-memory pandas frames, point-in-time correct universe
  - Daily replay: screener → ranking → entry → exit (no ML predictions dep)
  - Parameterized: accepts full (L1 + L2 + L3) params dict matching trading:config shape
  - Metrics: Sharpe / Sortino / Calmar / MaxDD / ProfitFactor / fill_rate + per_regime
  - Helpers: bootstrap_metric() / walk_forward()

Out of scope (deferred):
  - Sprint 6b: walk-forward ML retrain (Mode B)
  - Sprint 4-2 revisit: real HMM regime (placeholder uses market_risk.risk_level)
  - Sprint 5: Optuna wiring (this file is the objective primitive, not the driver)

Relationship to backtest_service.py (existing, NOT deprecated):
  backtest_service.run_full_backtest()  →  fixed config, reads D1 predictions, dashboard use
                                            callers: routers/backtest.py, obsidian_writer.py,
                                            monte_carlo_service.py
  backtest_engine.replay_period(params)  →  parameterized, pure rule-based, Optuna objective
                                            callers: (TODO 6a.6) routers/backtest.py /replay

Sprint 6 author: Claude (Opus 4.6) under Wei's direction, 2026-04-07
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from services import d1_client

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════════
# Data Loader (Phase 6a.0)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class BacktestDataset:
    """
    In-memory snapshot of all D1 data needed to replay a date range.

    Layout:
      - prices:      MultiIndex (symbol, date) → open/high/low/close/volume/avg_price
      - indicators:  MultiIndex (symbol, date) → ma5/10/20/60 + rsi14 + macd* + atr14 + bb_*
      - chips:       MultiIndex (symbol, date) → foreign/trust/dealer net + margin + short
      - market_risk: index date → vix/twii_* + risk_score/level + adl + bull_alignment
      - universe:    dict[date_str, set[symbol]] — point-in-time tradable symbols

    Memory estimate for full D1 (2,346 stocks × 580 days):
      - prices:      ~1.67M rows × 8 cols × 8 bytes ≈ 107 MB
      - indicators:  ~1.67M rows × 14 cols × 8 bytes ≈ 187 MB
      - chips:       ~1.67M rows × 11 cols × 8 bytes ≈ 147 MB
      - market_risk: ~580 rows × 20 cols × 8 bytes ≈ 93 KB (trivial)
      Total: ~440 MB → fits in Cloud Run mem=2GB with headroom for replay state.
    """
    prices: pd.DataFrame
    indicators: pd.DataFrame
    chips: pd.DataFrame
    market_risk: pd.DataFrame
    stocks: pd.DataFrame           # symbol metadata: sector, listed/delisted dates
    trading_days: list[str]        # sorted unique dates that have price data
    start_date: str
    end_date: str

    # Lazy-computed universe cache — point-in-time tradable set per date
    _universe_cache: dict[str, set[str]] = field(default_factory=dict)

    # ─────────────────────────────────────────────────────────────────────────
    # Loader entrypoint
    # ─────────────────────────────────────────────────────────────────────────
    @classmethod
    def load_from_d1(
        cls,
        start_date: str,
        end_date: str,
        symbols: Optional[list[str]] = None,
    ) -> "BacktestDataset":
        """
        Pull all backtest inputs from D1 in one shot.

        Args:
            start_date: 'YYYY-MM-DD' inclusive lower bound
            end_date:   'YYYY-MM-DD' inclusive upper bound
            symbols:    optional subset filter; None = full universe

        Point-in-time correctness (C1 fix from backtest_service):
          universe includes delisted stocks whose delisted_date >= start_date,
          so backtest doesn't have survivorship bias.
        """
        logger.info(f"[BacktestEngine] Loading D1 data {start_date}~{end_date}...")

        stocks_df = cls._load_stocks(symbols, start_date)
        if stocks_df.empty:
            raise RuntimeError("No stocks matched filter")

        stock_ids = stocks_df["id"].tolist()
        symbol_map = dict(zip(stocks_df["id"], stocks_df["symbol"]))
        logger.info(f"[BacktestEngine]   Universe: {len(stock_ids)} stocks")

        prices_df = cls._load_prices(stock_ids, symbol_map, start_date, end_date)
        logger.info(f"[BacktestEngine]   Prices: {len(prices_df)} rows")

        if prices_df.empty:
            raise RuntimeError(f"No prices in range {start_date}~{end_date}")

        indicators_df = cls._load_indicators(stock_ids, symbol_map, start_date, end_date)
        logger.info(f"[BacktestEngine]   Indicators: {len(indicators_df)} rows")

        chip_symbols = stocks_df["symbol"].tolist()
        chips_df = cls._load_chips(chip_symbols, start_date, end_date)
        logger.info(f"[BacktestEngine]   Chips: {len(chips_df)} rows")

        risk_df = cls._load_market_risk(start_date, end_date)
        logger.info(f"[BacktestEngine]   Market risk: {len(risk_df)} rows")

        trading_days = sorted(prices_df.index.get_level_values("date").unique().tolist())
        logger.info(f"[BacktestEngine]   Trading days: {len(trading_days)}")

        return cls(
            prices=prices_df,
            indicators=indicators_df,
            chips=chips_df,
            market_risk=risk_df,
            stocks=stocks_df,
            trading_days=trading_days,
            start_date=start_date,
            end_date=end_date,
        )

    # ─────────────────────────────────────────────────────────────────────────
    # SQL helpers — one query per table, whole range at once
    # ─────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _load_stocks(
        symbols: Optional[list[str]], start_date: str
    ) -> pd.DataFrame:
        """
        Load stock metadata with point-in-time universe filter.
        Include delisted stocks whose delisted_date >= start_date (C1 fix).
        """
        where = [
            "(is_active = 1 OR (delisted_date IS NOT NULL AND delisted_date >= ?))",
            "(listed_date IS NULL OR listed_date <= ?)",
        ]
        params: list = [start_date, start_date]
        if symbols:
            placeholders = ",".join("?" * len(symbols))
            where.append(f"symbol IN ({placeholders})")
            params.extend(symbols)

        sql = f"""
            SELECT id, symbol, name, market, sector, is_active,
                   listed_date, delisted_date
            FROM stocks
            WHERE {' AND '.join(where)}
        """
        rows = d1_client.query(sql, params)
        return pd.DataFrame(rows) if rows else pd.DataFrame()

    @staticmethod
    def _load_prices(
        stock_ids: list[int],
        symbol_map: dict[int, str],
        start_date: str,
        end_date: str,
    ) -> pd.DataFrame:
        """
        Load OHLCV for given stock_ids, date range.

        D1 has ~1.67M total rows — for full-range backtest we hit row limits
        (D1 HTTP API caps at ~100k rows per response). Chunk by date window.
        """
        chunks: list[pd.DataFrame] = []
        # 60-day chunks × 2346 stocks ≈ 140k rows/chunk — safe under D1 limits
        chunk_start = start_date
        while chunk_start <= end_date:
            chunk_end = _date_add(chunk_start, 60)
            if chunk_end > end_date:
                chunk_end = end_date

            sql = """
                SELECT stock_id, date, open, high, low, close, adj_close,
                       volume, avg_price
                FROM stock_prices
                WHERE date >= ? AND date <= ?
            """
            rows = d1_client.query(sql, [chunk_start, chunk_end])
            if rows:
                df = pd.DataFrame(rows)
                # Map stock_id → symbol
                df["symbol"] = df["stock_id"].map(symbol_map)
                df = df.dropna(subset=["symbol"])
                chunks.append(df)

            if chunk_end == end_date:
                break
            chunk_start = _date_add(chunk_end, 1)

        if not chunks:
            return _empty_multiindex_df()

        df = pd.concat(chunks, ignore_index=True)
        df = df.drop(columns=["stock_id"], errors="ignore")
        df = df.set_index(["symbol", "date"]).sort_index()
        return df

    @staticmethod
    def _load_indicators(
        stock_ids: list[int],
        symbol_map: dict[int, str],
        start_date: str,
        end_date: str,
    ) -> pd.DataFrame:
        """Load technical indicators, same chunking strategy as prices."""
        chunks: list[pd.DataFrame] = []
        chunk_start = start_date
        while chunk_start <= end_date:
            chunk_end = _date_add(chunk_start, 60)
            if chunk_end > end_date:
                chunk_end = end_date

            sql = """
                SELECT stock_id, date, ma5, ma10, ma20, ma60,
                       rsi14, macd, macd_signal, macd_hist,
                       atr14, bb_upper, bb_mid, bb_lower
                FROM technical_indicators
                WHERE date >= ? AND date <= ?
            """
            rows = d1_client.query(sql, [chunk_start, chunk_end])
            if rows:
                df = pd.DataFrame(rows)
                df["symbol"] = df["stock_id"].map(symbol_map)
                df = df.dropna(subset=["symbol"])
                chunks.append(df)

            if chunk_end == end_date:
                break
            chunk_start = _date_add(chunk_end, 1)

        if not chunks:
            return _empty_multiindex_df()

        df = pd.concat(chunks, ignore_index=True)
        df = df.drop(columns=["stock_id"], errors="ignore")
        df = df.set_index(["symbol", "date"]).sort_index()
        return df

    @staticmethod
    def _load_chips(
        symbols: list[str], start_date: str, end_date: str
    ) -> pd.DataFrame:
        """
        Load chip data. Note: chip_data uses `symbol` directly (not stock_id).
        Chunk by date to stay under D1 row limit.
        """
        chunks: list[pd.DataFrame] = []
        chunk_start = start_date
        while chunk_start <= end_date:
            chunk_end = _date_add(chunk_start, 60)
            if chunk_end > end_date:
                chunk_end = end_date

            sql = """
                SELECT symbol, date,
                       foreign_buy, foreign_sell, foreign_net,
                       trust_buy, trust_sell, trust_net,
                       dealer_buy, dealer_sell, dealer_net,
                       margin_balance, short_balance
                FROM chip_data
                WHERE date >= ? AND date <= ?
            """
            rows = d1_client.query(sql, [chunk_start, chunk_end])
            if rows:
                chunks.append(pd.DataFrame(rows))

            if chunk_end == end_date:
                break
            chunk_start = _date_add(chunk_end, 1)

        if not chunks:
            return _empty_multiindex_df()

        df = pd.concat(chunks, ignore_index=True)
        df = df.set_index(["symbol", "date"]).sort_index()
        return df

    @staticmethod
    def _load_market_risk(start_date: str, end_date: str) -> pd.DataFrame:
        """Load market-wide risk metrics (~580 rows total — no chunking needed)."""
        sql = """
            SELECT date, vix, vix_level, twii_close, twii_vol20, twii_ma20, twii_bias,
                   foreign_consecutive_sell, foreign_net_5d, margin_ratio,
                   limit_down_count, limit_down_pct,
                   risk_score, risk_level,
                   adl_value, adl_trend,
                   bull_alignment_count, bull_alignment_pct
            FROM market_risk
            WHERE date >= ? AND date <= ?
            ORDER BY date
        """
        rows = d1_client.query(sql, [start_date, end_date])
        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows)
        df = df.set_index("date").sort_index()
        return df

    # ─────────────────────────────────────────────────────────────────────────
    # Accessors (hot path — replay loop calls these every day for every stock)
    # ─────────────────────────────────────────────────────────────────────────
    def get_universe_at(self, date: str) -> set[str]:
        """
        Point-in-time tradable universe for a given date.

        A symbol is tradable at `date` if:
          - it was listed (listed_date <= date or listed_date is NULL), AND
          - it was not yet delisted (delisted_date IS NULL or delisted_date > date), AND
          - it has a price bar in the dataset for that date
        """
        if date in self._universe_cache:
            return self._universe_cache[date]

        # Symbols with a price bar on this date
        try:
            bars_today = self.prices.xs(date, level="date")
            has_bar = set(bars_today.index.tolist())
        except KeyError:
            has_bar = set()

        # Filter by listed/delisted dates
        active = self.stocks[
            ((self.stocks["listed_date"].isna()) | (self.stocks["listed_date"] <= date))
            & (
                (self.stocks["delisted_date"].isna())
                | (self.stocks["delisted_date"] > date)
            )
        ]["symbol"].tolist()

        universe = has_bar & set(active)
        self._universe_cache[date] = universe
        return universe

    def get_bar(self, symbol: str, date: str) -> Optional[dict]:
        """Get OHLCV bar for (symbol, date). Returns None if missing."""
        try:
            row = self.prices.loc[(symbol, date)]
            return row.to_dict()
        except KeyError:
            return None

    def get_indicator(self, symbol: str, date: str) -> Optional[dict]:
        """Get technical indicator snapshot for (symbol, date)."""
        try:
            row = self.indicators.loc[(symbol, date)]
            return row.to_dict()
        except KeyError:
            return None

    def get_chip(self, symbol: str, date: str) -> Optional[dict]:
        """Get chip data for (symbol, date)."""
        try:
            row = self.chips.loc[(symbol, date)]
            return row.to_dict()
        except KeyError:
            return None

    def get_market_risk(self, date: str) -> Optional[dict]:
        """Get market risk row for a date."""
        try:
            row = self.market_risk.loc[date]
            return row.to_dict()
        except KeyError:
            return None

    def get_price_history(
        self, symbol: str, end_date: str, lookback_days: int
    ) -> pd.DataFrame:
        """
        Get trailing N trading bars for a symbol up to (and including) end_date.
        Used by screener for momentum / volatility / ATR calcs.
        """
        try:
            all_bars = self.prices.xs(symbol, level="symbol")
        except KeyError:
            return pd.DataFrame()
        mask = all_bars.index <= end_date
        return all_bars.loc[mask].tail(lookback_days)


# ═══════════════════════════════════════════════════════════════════════════════
# Utilities
# ═══════════════════════════════════════════════════════════════════════════════

def _empty_multiindex_df() -> pd.DataFrame:
    """
    Return an empty DataFrame with a (symbol, date) MultiIndex skeleton so that
    downstream `.xs(level=...)` calls don't crash on cold / no-result backtests.
    """
    idx = pd.MultiIndex.from_arrays([[], []], names=["symbol", "date"])
    return pd.DataFrame(index=idx)


def _date_add(date_str: str, days: int) -> str:
    """Add N calendar days to a 'YYYY-MM-DD' string."""
    d = datetime.strptime(date_str[:10], "%Y-%m-%d")
    return (d + timedelta(days=days)).strftime("%Y-%m-%d")


def _date_diff(d1: str, d2: str) -> int:
    """Calendar-day diff between two date strings."""
    try:
        a = datetime.strptime(d1[:10], "%Y-%m-%d")
        b = datetime.strptime(d2[:10], "%Y-%m-%d")
        return (b - a).days
    except (ValueError, TypeError):
        return 0


# ═══════════════════════════════════════════════════════════════════════════════
# Screener Replay (Phase 6a.1)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Faithful port of Worker marketScreener.ts scoreMultiFactor() + bottom-up
# pipeline + dailyRecommendation.ts Hybrid Ranking (Architecture C).
#
# Mode A simplifications (documented exclusions):
#   - No news/PTT/Anue buzz (external, non-replayable)
#   - No F-Score / financials (quarterly cadence, Sprint 6b candidate)
#   - No ADX / liquidity-tier filter (optional add in 6a.1b if needed)
#   - No correlation dedup (implement in 6a.2 entry simulator instead)
#   - No 處置股 filter (external TWSE API, non-replayable)
#   - No industry RRG bonus (complex multi-day sector_flow calc; future 6a.1c)
#   - No DelistingMonitor (handled by point-in-time universe in data loader)
#
# For Hybrid Ranking in Mode A: ml_confidence is absent, so we set it to a
# flat 0.5 placeholder and signal_tier to 0.35 (HOLD-equivalent). This makes
# the combined_score reduce to alpha * screener_norm + const, so top-K by
# combined_score is essentially top-K by screener score — which matches
# "Architecture C acts as safety net" semantics when ML is silent.

@dataclass
class ScreenerParams:
    """Subset of trading:config.screener needed for Mode A replay."""
    min_price: float = 15.0
    max_price: float = 2000.0
    min_avg_volume: float = 300_000
    min_daily_turnover: float = 5_000_000
    max_per_industry: int = 5
    max_candidates: int = 25
    chip_score_tiers: list[float] = field(default_factory=lambda: [36, 28, 20, 12, 5])
    chip_intensity_thresholds: list[float] = field(
        default_factory=lambda: [0.20, 0.10, 0.05, 0, -0.05]
    )
    consec_buy_bonus_tiers: list[float] = field(default_factory=lambda: [4, 2])
    consec_buy_day_thresholds: list[int] = field(default_factory=lambda: [5, 3])
    rsi_score_tiers: list[float] = field(default_factory=lambda: [12, 8, 6, 8, 3])
    macd_negative_factor: float = 0.5
    keltner_multiplier: float = 1.5
    natr_threshold: float = 3.0
    excess_return_range: tuple[float, float] = (-0.03, 0.05)
    vol_ratio_range: tuple[float, float] = (0.7, 2.5)

    @classmethod
    def from_trading_config(cls, tc: dict) -> "ScreenerParams":
        """Build from trading:config dict (as returned by KV)."""
        sc = tc.get("screener", {})
        return cls(
            min_price=sc.get("minPrice", 15),
            max_price=sc.get("maxPrice", 2000),
            min_avg_volume=sc.get("minAvgVolume", 300_000),
            min_daily_turnover=sc.get("minDailyTurnover", 5_000_000),
            max_per_industry=sc.get("maxPerIndustry", 5),
            max_candidates=sc.get("maxCandidates", 25),
            chip_score_tiers=sc.get("chipScoreTiers", [36, 28, 20, 12, 5]),
            chip_intensity_thresholds=sc.get("chipIntensityThresholds", [0.20, 0.10, 0.05, 0, -0.05]),
            consec_buy_bonus_tiers=sc.get("consecBuyBonusTiers", [4, 2]),
            consec_buy_day_thresholds=sc.get("consecBuyDayThresholds", [5, 3]),
            rsi_score_tiers=sc.get("rsiScoreTiers", [12, 8, 6, 8, 3]),
            macd_negative_factor=sc.get("macdNegativeFactor", 0.5),
            keltner_multiplier=sc.get("keltnerMultiplier", 1.5),
            natr_threshold=sc.get("natrThreshold", 3.0),
            excess_return_range=tuple(sc.get("excessReturnRange", [-0.03, 0.05])),
            vol_ratio_range=tuple(sc.get("volRatioRange", [0.7, 2.5])),
        )


@dataclass
class RankingParams:
    """Subset of trading:config.ranking (Sprint 3 P0-4 Architecture C)."""
    enabled: bool = True
    top_k: int = 3
    alpha: float = 0.40        # screener weight
    beta: float = 0.40         # ml_confidence weight
    gamma: float = 0.20        # signal_tier weight
    screener_denominator: float = 60.0
    promote_min_conf: float = 0.60

    @classmethod
    def from_trading_config(cls, tc: dict) -> "RankingParams":
        rk = tc.get("ranking", {})
        return cls(
            enabled=rk.get("enabled", True),
            top_k=rk.get("topK", 3),
            alpha=rk.get("alpha", 0.40),
            beta=rk.get("beta", 0.40),
            gamma=rk.get("gamma", 0.20),
            screener_denominator=rk.get("screenerDenominator", 60.0),
            promote_min_conf=rk.get("promoteMinConf", 0.60),
        )


@dataclass
class Candidate:
    """Single candidate produced by screener replay for a specific date."""
    symbol: str
    date: str                  # decision date (= T, entry happens T+1)
    close: float
    industry: str
    base_score: float
    chip_score: float
    tech_score: float
    momentum_score: float
    combined_score: float      # Hybrid Ranking (Architecture C)
    reasons: list[str] = field(default_factory=list)
    has_buy_signal: int = 0    # 1 = top-K promoted, 0 = not


# ─────────────────────────────────────────────────────────────────────────────
# Scoring (pure function — all inputs are preloaded arrays)
# ─────────────────────────────────────────────────────────────────────────────

def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _normalize(value: float, lower: float, upper: float, max_score: float) -> float:
    """Linear map [lower, upper] → [0, max_score], clamped."""
    if upper <= lower:
        return 0.0
    if value <= lower:
        return 0.0
    if value >= upper:
        return max_score
    return (value - lower) / (upper - lower) * max_score


def score_multi_factor(
    prices: pd.DataFrame,        # trailing bars for one symbol, sorted by date ascending
    chip_history: pd.DataFrame,  # trailing chip rows for same symbol (or empty)
    market_return_5d: float,
    sc: ScreenerParams,
) -> tuple[float, float, float, float, list[str]]:
    """
    Direct port of marketScreener.ts scoreMultiFactor().

    Returns (base_score, chip_score, tech_score, momentum_score, reasons).

    Inputs:
      prices: DataFrame indexed by date with columns open/high/low/close/volume.
              Must have at least 3 rows; 20+ rows recommended for full scoring.
      chip_history: DataFrame with foreign_net, trust_net columns (last 5 days used).
                    Pass empty DataFrame if no chip data.
      market_return_5d: 5-day return of market benchmark (0050 ETF close).
      sc: ScreenerParams instance.
    """
    reasons: list[str] = []
    n = len(prices)
    if n < 3:
        return 0.0, 0.0, 0.0, 0.0, reasons

    latest_close = float(prices["close"].iloc[-1])
    closes = prices["close"].values
    volumes = prices["volume"].values

    # ── P0-1: Chip score (0-40) ─────────────────────────────────────────────
    chip_score = 0.0
    if not chip_history.empty:
        # Last 5 days of chip data
        recent = chip_history.tail(5).sort_index()
        net_buy_shares = 0
        consec_buy_days = 0
        counting_consec = True
        for i in range(len(recent) - 1, -1, -1):
            row = recent.iloc[i]
            day_net = (row.get("foreign_net") or 0) + (row.get("trust_net") or 0)
            net_buy_shares += day_net
            if counting_consec:
                if day_net > 0:
                    consec_buy_days += 1
                else:
                    counting_consec = False

        net_buy_amount = net_buy_shares * latest_close
        avg_daily_turnover = float(np.mean(volumes * closes)) if n > 0 else 0.0
        chip_intensity = (
            net_buy_amount / avg_daily_turnover if avg_daily_turnover > 0 else 0
        )

        tiers = sc.chip_score_tiers
        thresholds = sc.chip_intensity_thresholds
        if chip_intensity > thresholds[0]:
            chip_score = tiers[0]
        elif chip_intensity > thresholds[1]:
            chip_score = tiers[1]
        elif chip_intensity > thresholds[2]:
            chip_score = tiers[2]
        elif chip_intensity > thresholds[3]:
            chip_score = tiers[3]
        elif chip_intensity > thresholds[4]:
            chip_score = tiers[4]

        if chip_intensity > 0.05:
            reasons.append(f"法人佔成交{chip_intensity * 100:.1f}%")

        cb_bonus = sc.consec_buy_bonus_tiers
        cb_days = sc.consec_buy_day_thresholds
        if consec_buy_days >= cb_days[0]:
            chip_score += cb_bonus[0]
            reasons.append(f"連買{consec_buy_days}天")
        elif consec_buy_days >= cb_days[1]:
            chip_score += cb_bonus[1]

    chip_score = _clamp(chip_score, 0, 40)

    # ── P0-2: Technical score (0-30) ────────────────────────────────────────
    tech_score = 0.0
    rsi_value = 50.0

    # RSI 14
    if n >= 15:
        changes = np.diff(closes[-15:])
        gains = changes[changes > 0]
        losses = -changes[changes < 0]
        avg_gain = gains.sum() / 14 if len(gains) > 0 else 0
        avg_loss = losses.sum() / 14 if len(losses) > 0 else 0.001
        rsi = 100 - 100 / (1 + avg_gain / avg_loss)
        rsi_value = rsi
        tiers = sc.rsi_score_tiers
        if 55 <= rsi <= 75:
            tech_score += tiers[0]
            reasons.append(f"RSI {rsi:.0f}")
        elif 45 <= rsi < 55:
            tech_score += tiers[1]
        elif 40 <= rsi < 45:
            tech_score += tiers[2]
        elif rsi > 75:
            tech_score += tiers[3]
        elif 30 <= rsi < 40:
            tech_score += tiers[4]

    # MACD approximation
    if n >= 20:
        ma12 = closes[-12:].mean()
        ma26_window = min(26, n)
        ma26 = closes[-ma26_window:].mean()
        macd_approx = ma12 - ma26
        if macd_approx > 0:
            tech_score += 8
            reasons.append("MACD 多頭")
        elif macd_approx > -sc.macd_negative_factor * latest_close / 100:
            tech_score += 3

    # MA alignment
    if n >= 5 and latest_close > closes[-5:].mean():
        tech_score += 3
    if n >= 20:
        ma20 = closes[-20:].mean()
        if latest_close > ma20:
            tech_score += 4
            reasons.append("站上MA20")

    # ATR14 + NATR + Keltner
    if n >= 14:
        highs = prices["high"].values
        lows = prices["low"].values
        trs = []
        for i in range(max(1, n - 14), n):
            tr = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
            trs.append(tr)
        atr14 = float(np.mean(trs)) if trs else 0.0
        natr = (atr14 / latest_close) * 100 if latest_close > 0 else 0

        ma20_window = min(20, n)
        ma20 = closes[-ma20_window:].mean()
        if atr14 > 0 and latest_close > ma20 + sc.keltner_multiplier * atr14:
            tech_score += 3
            reasons.append("突破肯特納")

        if natr < sc.natr_threshold and latest_close > ma20:
            tech_score += 2

    tech_score = _clamp(tech_score, 0, 30)

    # ── Momentum score (0-20) ──────────────────────────────────────────────
    momentum_score = 0.0

    # 5-day excess return vs market
    if n >= 6:
        stock_return_5d = (closes[-1] - closes[-6]) / closes[-6]
        excess = stock_return_5d - market_return_5d
        lo, hi = sc.excess_return_range
        momentum_score += _normalize(excess, lo, hi, 7)
        if excess > 0.02:
            reasons.append(f"超額+{excess * 100:.1f}%")

    # Volume ratio: recent 3d vs 20d average
    if n >= 5:
        recent3 = volumes[-3:].mean()
        avg20 = volumes.mean()
        vol_ratio = recent3 / avg20 if avg20 > 0 else 1
        lo, hi = sc.vol_ratio_range
        momentum_score += _normalize(vol_ratio, lo, hi, 5)
        if vol_ratio > 1.5:
            reasons.append(f"量能{vol_ratio:.1f}倍")

    # P1-3: Price intent factor (FinLab linear factor)
    if n >= 15:
        intent_n = min(20, n - 1)
        start_close = closes[-1 - intent_n]
        ret_n = (closes[-1] - start_close) / start_close if start_close > 0 else 0
        sum_abs_ret = 0.0
        for i in range(n - intent_n, n):
            if closes[i - 1] > 0:
                sum_abs_ret += abs((closes[i] - closes[i - 1]) / closes[i - 1])
        price_intent = ret_n / sum_abs_ret if sum_abs_ret > 0 else 0
        if price_intent > 0.5:
            momentum_score += 5
            reasons.append(f"意圖{price_intent * 100:.0f}%")
        elif price_intent > 0.3:
            momentum_score += 3
        elif price_intent > 0.1:
            momentum_score += 1

    # RSI blunting: rsi > 75 with 3+ consecutive up days
    if rsi_value > 75 and n >= 6:
        changes = np.diff(closes[-6:])
        consec = 0
        for d in range(len(changes) - 1, -1, -1):
            if changes[d] > 0:
                consec += 1
            else:
                break
        if consec >= 3:
            momentum_score += 3
            reasons.append(f"RSI鈍化{consec}天")

    momentum_score = _clamp(momentum_score, 0, 20)

    base_score = chip_score + tech_score + momentum_score
    return base_score, chip_score, tech_score, momentum_score, reasons


# ─────────────────────────────────────────────────────────────────────────────
# Market benchmark (5d return of 0050 ETF)
# ─────────────────────────────────────────────────────────────────────────────

def _calc_market_return_5d(dataset: BacktestDataset, date: str) -> float:
    """
    5-day return of 0050 ETF (Yuanta Taiwan 50) as market benchmark.
    Falls back to dataset-wide median return if 0050 not available.
    """
    try:
        hist = dataset.get_price_history("0050", date, 6)
        if len(hist) >= 6:
            latest = float(hist["close"].iloc[-1])
            old = float(hist["close"].iloc[0])
            if old > 0:
                return (latest - old) / old
    except Exception:
        pass

    # Fallback: cross-section median return from 5 trading days ago to date
    try:
        all_today = dataset.prices.xs(date, level="date")
    except KeyError:
        return 0.0
    # Find date 5 trading days ago from dataset.trading_days
    if date not in dataset.trading_days:
        return 0.0
    idx = dataset.trading_days.index(date)
    if idx < 5:
        return 0.0
    old_date = dataset.trading_days[idx - 5]
    try:
        all_old = dataset.prices.xs(old_date, level="date")
    except KeyError:
        return 0.0
    common = all_today.index.intersection(all_old.index)
    if common.empty:
        return 0.0
    rets = (
        all_today.loc[common, "close"] - all_old.loc[common, "close"]
    ) / all_old.loc[common, "close"]
    rets = rets.replace([np.inf, -np.inf], np.nan).dropna()
    return float(rets.median()) if len(rets) > 0 else 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Daily screener replay entrypoint
# ─────────────────────────────────────────────────────────────────────────────

def replay_screener_for_date(
    dataset: BacktestDataset,
    date: str,
    screener: ScreenerParams,
    ranking: RankingParams,
    lookback_days: int = 22,
) -> list[Candidate]:
    """
    Replay the Worker bottom-up screener for one decision date T.
    Produces candidate list where `has_buy_signal = 1` rows are the top-K
    selected via Hybrid Ranking (Architecture C) and feed into the entry
    simulator on T+1.

    Pipeline (mirrors marketScreener.ts runBottomUpScreener):
      1. Point-in-time universe from dataset.get_universe_at(date)
      2. Hard filter: price/volume/turnover bounds
      3. score_multi_factor per survivor (reads 22-day trailing window)
      4. Same-industry cap (max_per_industry)
      5. Top-N truncation (max_candidates)
      6. Hybrid Ranking: compute combined_score, promote top_k to has_buy_signal=1
         (Mode A: ml_confidence=0.5 placeholder, signal_tier=0.35 HOLD-eq)

    Returns list of Candidate, sorted by combined_score descending.
    """
    universe_symbols = dataset.get_universe_at(date)
    if not universe_symbols:
        return []

    market_return_5d = _calc_market_return_5d(dataset, date)
    scored: list[Candidate] = []

    # Preload stocks sector lookup
    sector_map = dict(zip(dataset.stocks["symbol"], dataset.stocks["sector"].fillna("其他")))

    for symbol in universe_symbols:
        prices = dataset.get_price_history(symbol, date, lookback_days)
        if len(prices) < 3:
            continue

        latest_close = float(prices["close"].iloc[-1])
        latest_volume = float(prices["volume"].iloc[-1])

        # Hard filters
        if latest_close < screener.min_price or latest_close > screener.max_price:
            continue
        if latest_volume == 0:
            continue
        vol_slice = prices["volume"].tail(min(20, len(prices)))
        avg_vol_20 = float(vol_slice.mean())
        if avg_vol_20 < screener.min_avg_volume:
            continue
        avg_daily_turnover = avg_vol_20 * latest_close
        if avg_daily_turnover < screener.min_daily_turnover:
            continue

        # Chip history (last 5 days, as per TS logic)
        try:
            chip_hist = dataset.chips.xs(symbol, level="symbol")
            chip_hist = chip_hist.loc[chip_hist.index <= date].tail(5)
        except KeyError:
            chip_hist = pd.DataFrame()

        base, chip_s, tech_s, mom_s, reasons = score_multi_factor(
            prices, chip_hist, market_return_5d, screener
        )

        scored.append(Candidate(
            symbol=symbol,
            date=date,
            close=latest_close,
            industry=sector_map.get(symbol, "其他"),
            base_score=base,
            chip_score=chip_s,
            tech_score=tech_s,
            momentum_score=mom_s,
            combined_score=0.0,  # filled below
            reasons=reasons[:3],
        ))

    if not scored:
        return []

    # Sort by base_score before industry cap
    scored.sort(key=lambda c: c.base_score, reverse=True)

    # Step 5a+5b: industry cap
    industry_count: dict[str, int] = {}
    after_industry: list[Candidate] = []
    for c in scored:
        cnt = industry_count.get(c.industry, 0)
        if cnt >= screener.max_per_industry:
            continue
        industry_count[c.industry] = cnt + 1
        after_industry.append(c)

    # Step 5d: top-N truncation
    final_candidates = after_industry[: screener.max_candidates]

    # Hybrid Ranking (Architecture C): compute combined_score + promote top_k
    # Mode A placeholder: ml_confidence = 0.5, signal_tier = 0.35 (HOLD-equiv)
    ML_CONF_PLACEHOLDER = 0.5
    SIGNAL_TIER_PLACEHOLDER = 0.35

    for c in final_candidates:
        screener_norm = min(
            1.0, (c.chip_score + c.tech_score) / ranking.screener_denominator
        )
        c.combined_score = (
            ranking.alpha * screener_norm
            + ranking.beta * ML_CONF_PLACEHOLDER
            + ranking.gamma * SIGNAL_TIER_PLACEHOLDER
        )

    final_candidates.sort(key=lambda c: c.combined_score, reverse=True)

    # Promote top_k to has_buy_signal = 1
    if ranking.enabled:
        for c in final_candidates[: ranking.top_k]:
            c.has_buy_signal = 1

    return final_candidates


# ═══════════════════════════════════════════════════════════════════════════════
# Entry Simulator (Phase 6a.2)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Port of paper.ts setupMorningPendingBuys + executeLimitFillsIntraday.
#
# Fill semantics (Mode A):
#   - Decision date T (close) → candidates produced by replay_screener_for_date
#   - T+1 open: attempt limit fill at adjusted_entry price
#   - Fill succeeds iff T+1 low <= adjusted_entry (price reached the limit)
#   - Fill price = adjusted_entry + 1 tick slippage
#   - If no fill, candidate expires ROD (same-day cancel)
#
# Gap-aware proxy (Sprint 3 P0-2):
#   Paper.ts uses TAIFEX night-session changePct. We don't have historical night
#   session data, so Mode A uses 0050 ETF open-vs-prev-close as proxy.
#     gap_pct = (open_T+1 - close_T) / close_T  for 0050
#   This captures the same "overnight market expectation" signal.
#
# Position sizing (Sprint 3 P0-1):
#   - Kelly path: calc_kelly_pct + portfolio cap
#   - Risk-parity fallback: risk_pct / stop_pct formula
#
# Mode A deviations from paper.ts (documented):
#   - No TAIFEX night session (0050 gap proxy instead)
#   - No DebateVerdict (treat all as 'APPROVE', i.e. no downgrade path)
#   - No sector concentration check via D1 (use Candidate.industry + sector_count)
#   - No daily buy limit accumulator across runs (reset per backtest day)
#   - ml_stop_loss / ml_target1 synthesized from ATR * params.sltp.{slMultBase, tpMultBase}
#     (since Mode A has no ML predictions) — Kelly b = tpBase / slBase effectively

@dataclass
class PositionSizeParams:
    """Subset of trading:config.position for sizing."""
    risk_pct_per_trade: float = 0.015
    max_pct_of_portfolio: float = 0.25
    max_pct_of_cash: float = 0.30
    min_cash_to_trade: float = 10_000
    min_stop_pct: float = 0.03
    min_position_value: float = 30_000
    max_positions: int = 5
    daily_buy_limit: float = 200_000
    # Kelly sub-config
    kelly_enabled: bool = False
    kelly_half: bool = True
    kelly_conf_clip_lo: float = 0.50
    kelly_conf_clip_hi: float = 0.75
    kelly_max_pct: float = 0.15
    # Gap-aware (P0-2)
    gap_aware_min_holiday_days: int = 3
    gap_aware_trigger_pct: float = 0.01
    gap_aware_skip_pct: float = 0.05
    gap_aware_cap_pct: float = 0.05

    @classmethod
    def from_trading_config(cls, tc: dict) -> "PositionSizeParams":
        p = tc.get("position", {})
        k = p.get("kelly", {})
        return cls(
            risk_pct_per_trade=p.get("riskPctPerTrade", 0.015),
            max_pct_of_portfolio=p.get("maxPctOfPortfolio", 0.25),
            max_pct_of_cash=p.get("maxPctOfCash", 0.30),
            min_cash_to_trade=p.get("minCashToTrade", 10_000),
            min_stop_pct=p.get("minStopPct", 0.03),
            min_position_value=p.get("minPositionValue", 30_000),
            max_positions=p.get("maxPositions", 5),
            daily_buy_limit=p.get("dailyBuyLimit", 200_000),
            kelly_enabled=k.get("enabled", False),
            kelly_half=k.get("halfKelly", True),
            kelly_conf_clip_lo=k.get("confClipLo", 0.50),
            kelly_conf_clip_hi=k.get("confClipHi", 0.75),
            kelly_max_pct=k.get("maxKellyPct", 0.15),
        )


@dataclass
class SLTPParams:
    """Subset of trading:config.sltp for synthetic stop/target generation."""
    sl_mult_base: float = 1.6806
    tp_mult_base: float = 2.9632
    vol_threshold_low: float = 0.015
    vol_threshold_high: float = 0.03

    @classmethod
    def from_trading_config(cls, tc: dict) -> "SLTPParams":
        s = tc.get("sltp", {})
        return cls(
            sl_mult_base=s.get("slMultBase", 1.6806),
            tp_mult_base=s.get("tpMultBase", 2.9632),
            vol_threshold_low=s.get("volThresholdLow", 0.015),
            vol_threshold_high=s.get("volThresholdHigh", 0.03),
        )


@dataclass
class FeeParams:
    """Taiwan stock fee structure (trading:config.fees)."""
    commission: float = 0.001425
    tax: float = 0.003
    min_commission: float = 20

    @classmethod
    def from_trading_config(cls, tc: dict) -> "FeeParams":
        f = tc.get("fees", {})
        return cls(
            commission=f.get("commission", 0.001425),
            tax=f.get("tax", 0.003),
            min_commission=f.get("minCommission", 20),
        )


@dataclass
class AccountState:
    """Mutable portfolio state tracked across backtest days."""
    cash: float
    initial_capital: float
    positions: dict[str, "OpenPosition"] = field(default_factory=dict)
    daily_buy_total: float = 0.0
    daily_buy_date: str = ""   # date that daily_buy_total was last reset

    @property
    def total_portfolio(self) -> float:
        """cash + position market value. For sizing we use `cash + sum(cost)`
        as a conservative proxy (paper.ts does same). Uses entry_price as the
        'cost basis' since OpenPosition tracks entry_price (post-slippage fill)."""
        pos_value = sum(p.shares * p.entry_price for p in self.positions.values())
        return self.cash + pos_value

    def reset_daily(self, date: str) -> None:
        if self.daily_buy_date != date:
            self.daily_buy_total = 0.0
            self.daily_buy_date = date


@dataclass
class OpenPosition:
    """Single open position — consumed by exit cascade in 6a.3."""
    symbol: str
    industry: str
    entry_date: str
    entry_price: float           # post-slippage fill price
    shares: int
    initial_stop: float
    tp1_price: float
    tp2_price: float
    atr14: float
    sl_mult: float
    highest_since_entry: float
    tp1_hit: bool = False
    # For per-regime analytics (6a.4)
    entry_regime: Optional[str] = None


@dataclass
class EntryAttempt:
    """Diagnostic record of every candidate that reached the entry stage."""
    symbol: str
    decision_date: str
    entry_date: str              # T+1
    status: str                  # 'filled' | 'no_fill' | 'skipped_gap' | 'skipped_cash' | 'skipped_risk' | 'skipped_industry' | 'skipped_daily_limit' | 'skipped_min_value'
    adjusted_entry: float
    fill_price: Optional[float] = None
    shares: int = 0
    sizing_mode: str = ""        # 'kelly' | 'risk_parity' | ''
    reason: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# Pure helper functions
# ─────────────────────────────────────────────────────────────────────────────

def calc_kelly_pct(
    confidence: float,
    entry_price: float,
    stop_loss: float,
    target1: float,
    kelly_enabled: bool,
    kelly_half: bool,
    conf_clip_lo: float,
    conf_clip_hi: float,
    max_kelly_pct: float,
) -> Optional[float]:
    """
    Direct port of paper.ts calcKellyPct.
    Returns capped Kelly fraction (0-1) or None if disabled / invalid / negative edge.
    """
    if not kelly_enabled:
        return None
    if stop_loss <= 0 or target1 <= 0:
        return None
    if stop_loss >= entry_price or target1 <= entry_price:
        return None

    p = max(conf_clip_lo, min(conf_clip_hi, confidence))
    q = 1 - p
    win_r = (target1 - entry_price) / entry_price
    loss_r = (entry_price - stop_loss) / entry_price
    if win_r <= 0 or loss_r <= 0:
        return None
    b = win_r / loss_r

    full_kelly = (p * b - q) / b
    if full_kelly <= 0:
        return None

    kelly = full_kelly * 0.5 if kelly_half else full_kelly
    return min(kelly, max_kelly_pct)


def _tick_size(price: float) -> float:
    """Taiwan stock tick size by price level."""
    if price < 10:
        return 0.01
    if price < 50:
        return 0.05
    if price < 100:
        return 0.1
    if price < 500:
        return 0.5
    if price < 1000:
        return 1.0
    return 5.0


def apply_slippage(price: float, side: str, ticks: int = 1) -> float:
    """Tick-based slippage (mirrors backtest_service.py C4 fix)."""
    tick = _tick_size(price)
    slip = tick * ticks
    if side == "buy":
        return price + slip
    return max(price - slip, tick)


def calc_commission(tx_value: float, fees: FeeParams) -> float:
    """Taiwan buy-side commission with min floor."""
    return max(tx_value * fees.commission, fees.min_commission)


def _gap_pct_from_benchmark(
    dataset: BacktestDataset,
    decision_date: str,
    entry_date: str,
    benchmark: str = "0050",
) -> float:
    """
    Proxy for paper.ts TAIFEX night-session changePct.
    Computes overnight gap of 0050 ETF from close(T) to open(T+1).

    Returns gap in PERCENT (not ratio) to match paper.ts.nightDropPct units.
    """
    try:
        close_t = dataset.get_bar(benchmark, decision_date)
        open_t1 = dataset.get_bar(benchmark, entry_date)
    except Exception:
        return 0.0
    if not close_t or not open_t1:
        return 0.0
    prev_close = float(close_t.get("close") or 0)
    next_open = float(open_t1.get("open") or 0)
    if prev_close <= 0 or next_open <= 0:
        return 0.0
    return (next_open - prev_close) / prev_close * 100  # percent


def gap_aware_adjust_entry(
    ml_entry: float,
    ml_stop: float,
    decision_date: str,
    entry_date: str,
    night_drop_pct: float,
    pos: PositionSizeParams,
) -> tuple[float, float, bool, str]:
    """
    Port of paper.ts Sprint 3 P0-2 Gap-aware logic.
    Returns (adjusted_entry, adjusted_stop, skip_flag, note).

    Triggers when holiday_gap_days >= 3 AND night_drop_pct > +1%.
    If night_drop_pct > +5% → skip (gap too extreme).
    Otherwise chase up to 5% cap with 0.5% buffer.
    """
    holiday_gap_days = max(1, _date_diff(decision_date, entry_date))
    if holiday_gap_days < pos.gap_aware_min_holiday_days:
        return ml_entry, ml_stop, False, ""
    if night_drop_pct <= pos.gap_aware_trigger_pct * 100:
        return ml_entry, ml_stop, False, ""

    implied_gap = night_drop_pct / 100
    if implied_gap > pos.gap_aware_skip_pct:
        return ml_entry, ml_stop, True, (
            f"skip: holiday {holiday_gap_days}d + gap +{night_drop_pct:.1f}% too extreme"
        )

    chase_pct = min(implied_gap, pos.gap_aware_cap_pct)
    new_entry = round(ml_entry * (1 + chase_pct) * 0.995, 2)
    if new_entry <= ml_entry:
        return ml_entry, ml_stop, False, ""
    new_stop = round(ml_stop * (1 + chase_pct), 2) if ml_stop > 0 else ml_stop
    note = f"gap+{chase_pct * 100:.1f}% holiday {holiday_gap_days}d"
    return new_entry, new_stop, False, note


def _get_atr14(dataset: BacktestDataset, symbol: str, date: str) -> Optional[float]:
    """Pull pre-computed ATR14 from technical_indicators table."""
    ind = dataset.get_indicator(symbol, date)
    if ind and ind.get("atr14"):
        return float(ind["atr14"])
    return None


def _synth_stop_target(
    entry: float, atr14: float, sl_mult: float, tp_mult: float
) -> tuple[float, float, float]:
    """
    In Mode A there are no ML predictions, so stop/target are ATR-derived
    using params.sltp (Optuna search space). Returns (stop, tp1, tp2).
    """
    stop = entry - atr14 * sl_mult
    tp1 = entry + atr14 * tp_mult
    tp2 = entry + atr14 * tp_mult * 2
    return stop, tp1, tp2


# ─────────────────────────────────────────────────────────────────────────────
# Main entry simulation entrypoint
# ─────────────────────────────────────────────────────────────────────────────

def simulate_entries_for_date(
    dataset: BacktestDataset,
    decision_date: str,
    entry_date: str,
    candidates: list[Candidate],
    account: AccountState,
    pos: PositionSizeParams,
    sltp: SLTPParams,
    fees: FeeParams,
    ml_conf_placeholder: float = 0.60,
) -> list[EntryAttempt]:
    """
    Given screener output for date T, try to open positions on T+1.

    Mutates `account` in place (cash, positions, daily_buy_total).

    Returns list of EntryAttempt records (one per candidate with has_buy_signal=1).

    Pipeline:
      1. Filter candidates by has_buy_signal=1
      2. Compute gap proxy once from 0050 benchmark
      3. For each candidate:
         a. Synthesize ml_stop/ml_target from ATR × sltp params
         b. Gap-aware adjustment
         c. Kelly sizing (if enabled) else risk-parity
         d. Apply portfolio caps (max_positions, cash, daily limit, industry)
         e. Next-day fill simulation: T+1 low <= adjusted_entry?
         f. Mutate account on fill, record EntryAttempt
    """
    account.reset_daily(entry_date)

    attempts: list[EntryAttempt] = []
    buy_candidates = [c for c in candidates if c.has_buy_signal == 1]
    if not buy_candidates:
        return attempts

    # Gap proxy (shared across all candidates today)
    gap_pct = _gap_pct_from_benchmark(dataset, decision_date, entry_date)

    # Industry concentration tracker for this day
    industry_count: dict[str, int] = {}
    for p_open in account.positions.values():
        industry_count[p_open.industry] = industry_count.get(p_open.industry, 0) + 1

    for cand in buy_candidates:
        # Skip symbols already held — paper.ts merges into existing paper_positions
        # via UPDATE avg_cost, but for Mode A backtest we take the simpler path of
        # skipping dupes to avoid silent overwrite of OpenPosition dict (which would
        # cause a cash leak: old position's cost stays deducted, exit never fires).
        # Optuna relative comparisons are unaffected by losing DCA accumulation.
        if cand.symbol in account.positions:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_duplicate", adjusted_entry=cand.close,
                reason="symbol already held",
            ))
            continue

        # Budget / position count caps
        if len(account.positions) >= pos.max_positions:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_max_positions", adjusted_entry=cand.close,
                reason=f"positions {len(account.positions)} >= {pos.max_positions}",
            ))
            continue

        if account.cash < pos.min_cash_to_trade:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_cash", adjusted_entry=cand.close,
                reason=f"cash {account.cash:.0f} < min {pos.min_cash_to_trade}",
            ))
            continue

        if industry_count.get(cand.industry, 0) >= 2:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_industry", adjusted_entry=cand.close,
                reason=f"industry {cand.industry} already has 2 positions",
            ))
            continue

        # Get ATR14 for stop/target synthesis
        atr14 = _get_atr14(dataset, cand.symbol, decision_date)
        if atr14 is None or atr14 <= 0:
            # Fallback: 2% of price (matches paper.ts fallbackAtrPct default)
            atr14 = cand.close * 0.02

        # Synthesize stop/target from ATR × sltp params (Optuna-searchable)
        ml_entry = cand.close
        ml_stop, ml_tp1, _ = _synth_stop_target(
            ml_entry, atr14, sltp.sl_mult_base, sltp.tp_mult_base
        )

        # Gap-aware adjustment
        adjusted_entry, adjusted_stop, skip_gap, gap_note = gap_aware_adjust_entry(
            ml_entry, ml_stop, decision_date, entry_date, gap_pct, pos
        )
        if skip_gap:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_gap", adjusted_entry=adjusted_entry, reason=gap_note,
            ))
            continue

        # Kelly or risk-parity sizing
        kelly_pct = calc_kelly_pct(
            confidence=ml_conf_placeholder,
            entry_price=adjusted_entry,
            stop_loss=adjusted_stop,
            target1=ml_tp1,
            kelly_enabled=pos.kelly_enabled,
            kelly_half=pos.kelly_half,
            conf_clip_lo=pos.kelly_conf_clip_lo,
            conf_clip_hi=pos.kelly_conf_clip_hi,
            max_kelly_pct=pos.kelly_max_pct,
        )

        total_portfolio = account.total_portfolio
        daily_remaining = pos.daily_buy_limit - account.daily_buy_total
        stop_pct = max(
            pos.min_stop_pct,
            (adjusted_entry - adjusted_stop) / adjusted_entry if adjusted_entry > 0 else pos.min_stop_pct,
        )

        if kelly_pct is not None and kelly_pct > 0:
            kelly_budget = total_portfolio * kelly_pct
            budget = min(
                kelly_budget,
                total_portfolio * pos.max_pct_of_portfolio,
                account.cash * pos.max_pct_of_cash,
                daily_remaining,
            )
            sizing_mode = "kelly"
        else:
            risk_budget = total_portfolio * pos.risk_pct_per_trade / stop_pct
            budget = min(
                risk_budget,
                total_portfolio * pos.max_pct_of_portfolio,
                account.cash * pos.max_pct_of_cash,
                daily_remaining,
            )
            sizing_mode = "risk_parity"

        if budget <= 0:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_daily_limit", adjusted_entry=adjusted_entry,
                reason=f"budget={budget:.0f} daily_remaining={daily_remaining:.0f}",
            ))
            continue

        # Next-day fill simulation
        next_bar = dataset.get_bar(cand.symbol, entry_date)
        if not next_bar:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="no_fill", adjusted_entry=adjusted_entry,
                reason="no bar on T+1 (halted/delisted)",
            ))
            continue

        next_low = float(next_bar.get("low") or 0)
        next_open = float(next_bar.get("open") or 0)
        if next_low <= 0:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="no_fill", adjusted_entry=adjusted_entry,
                reason=f"invalid low {next_low}",
            ))
            continue

        if next_low > adjusted_entry:
            # Limit never reached
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="no_fill", adjusted_entry=adjusted_entry,
                reason=f"low {next_low} > limit {adjusted_entry}",
            ))
            continue

        # Fill: execution price = min(open, adjusted_entry) + 1 tick slippage
        # (open-or-limit, whichever is worse for buyer)
        exec_px = min(next_open, adjusted_entry) if next_open > 0 else adjusted_entry
        fill_price = apply_slippage(exec_px, "buy", 1)

        # Share sizing — lots first, then odd lot fallback
        full_lots = int(budget // (fill_price * 1000))
        if full_lots >= 1:
            shares = full_lots * 1000
        else:
            shares = int(budget // fill_price)

        if shares < 1:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_min_value", adjusted_entry=adjusted_entry,
                reason=f"shares<1 at budget {budget:.0f}",
            ))
            continue

        tx_value = fill_price * shares
        if tx_value < pos.min_position_value:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_min_value", adjusted_entry=adjusted_entry,
                reason=f"txValue {tx_value:.0f} < min {pos.min_position_value}",
            ))
            continue

        commission = calc_commission(tx_value, fees)
        total_cost = tx_value + commission

        if total_cost > account.cash:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_cash", adjusted_entry=adjusted_entry,
                reason=f"cost {total_cost:.0f} > cash {account.cash:.0f}",
            ))
            continue

        if account.daily_buy_total + total_cost > pos.daily_buy_limit:
            attempts.append(EntryAttempt(
                symbol=cand.symbol, decision_date=decision_date, entry_date=entry_date,
                status="skipped_daily_limit", adjusted_entry=adjusted_entry,
                reason=f"would exceed daily limit {pos.daily_buy_limit}",
            ))
            continue

        # Compute vol-adjusted SL multiplier (3-tier from sltp params)
        vol_pct = atr14 / fill_price
        if vol_pct < sltp.vol_threshold_low:
            eff_sl_mult = sltp.sl_mult_base * 0.75
        elif vol_pct < sltp.vol_threshold_high:
            eff_sl_mult = sltp.sl_mult_base
        else:
            eff_sl_mult = sltp.sl_mult_base * 1.25

        initial_stop = fill_price - atr14 * eff_sl_mult
        tp1_price = fill_price + atr14 * sltp.tp_mult_base
        tp2_price = fill_price + atr14 * sltp.tp_mult_base * 2

        # Mutate account
        account.cash -= total_cost
        account.daily_buy_total += total_cost
        account.positions[cand.symbol] = OpenPosition(
            symbol=cand.symbol,
            industry=cand.industry,
            entry_date=entry_date,
            entry_price=fill_price,
            shares=shares,
            initial_stop=initial_stop,
            tp1_price=tp1_price,
            tp2_price=tp2_price,
            atr14=atr14,
            sl_mult=eff_sl_mult,
            highest_since_entry=fill_price,
        )
        industry_count[cand.industry] = industry_count.get(cand.industry, 0) + 1

        attempts.append(EntryAttempt(
            symbol=cand.symbol,
            decision_date=decision_date,
            entry_date=entry_date,
            status="filled",
            adjusted_entry=adjusted_entry,
            fill_price=fill_price,
            shares=shares,
            sizing_mode=sizing_mode,
            reason=f"{sizing_mode} {gap_note}".strip(),
        ))

    return attempts


# ═══════════════════════════════════════════════════════════════════════════════
# Exit Cascade (Phase 6a.3)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Port of paper.ts checkExitConditions (7-layer cascade) + executor logic.
#
# Cascade order (mirrors paper.ts:327-434):
#   ❶ Hard stop: pnl_pct <= hardStopPct                          → full_sell
#   ❷ ATR initial stop: price <= initial_stop                    → full_sell
#   ❸ ML SELL signal (EOD only)                                  → Mode A skip
#   ❹ Chandelier trailing stop: price <= trailing_stop           → full_sell
#   ❺ TP1: price >= tp1 and not tp1_hit                          → partial_sell (50%)
#   ❻ TP2: price >= tp2 and tp1_hit                              → full_sell
#   ❼ Time stop (EOD only): days > timeStopDays + pnl > minProfit → full_sell
#
# Intra-bar ordering (OHLC ambiguity resolution):
#   Unknown within-bar sequence → conservative pessimistic order:
#     1. Open-gap check: if open triggers hard/initial stop → exit at open
#     2. Low check: if low <= stop → exit at max(stop, open) (stop-loss fill)
#     3. High check: if high >= tp1/tp2 → TP triggered (only if stop didn't hit)
#     4. Trailing update: highest = max(highest_prev, high)
#
# When stop and TP could both hit in the same bar, stop wins (worst case).
# This is the standard backtest convention and matches paper.ts polling order.
#
# Mode A deviations from paper.ts:
#   - Layer ❸ ML SELL: skipped (no ML predictions)
#   - No intraday polling: one decision per daily bar
#   - TP1 partial: sell 50% with 1000-share lot rounding; if shares < 2000
#     → full sell (can't partial a single lot)

@dataclass
class ExitParams:
    """Subset of trading:config.exit for exit cascade."""
    hard_stop_pct: float = -0.10
    fallback_init_stop_mult: float = 0.93
    fallback_tp1_mult: float = 1.03
    fallback_tp2_mult: float = 1.06
    tp1_sell_ratio: float = 0.50
    time_stop_days: int = 30
    time_stop_min_profit: float = 0.005
    trail_mult_default: float = 3.0
    trail_mult_at_3pct: float = 2.5
    trail_mult_at_8pct: float = 2.0
    fallback_atr_pct: float = 0.02
    trail_switch_3pct: float = 0.03   # from sltp.trailSwitch3pct
    trail_switch_8pct: float = 0.08   # from sltp.trailSwitch8pct

    @classmethod
    def from_trading_config(cls, tc: dict) -> "ExitParams":
        e = tc.get("exit", {})
        s = tc.get("sltp", {})
        return cls(
            hard_stop_pct=e.get("hardStopPct", -0.10),
            fallback_init_stop_mult=e.get("fallbackInitStopMult", 0.93),
            fallback_tp1_mult=e.get("fallbackTp1Mult", 1.03),
            fallback_tp2_mult=e.get("fallbackTp2Mult", 1.06),
            tp1_sell_ratio=e.get("tp1SellRatio", 0.50),
            time_stop_days=e.get("timeStopDays", 30),
            time_stop_min_profit=e.get("timeStopMinProfit", 0.005),
            trail_mult_default=e.get("trailMultDefault", 3.0),
            trail_mult_at_3pct=e.get("trailMultAt3pct", 2.5),
            trail_mult_at_8pct=e.get("trailMultAt8pct", 2.0),
            fallback_atr_pct=e.get("fallbackAtrPct", 0.02),
            trail_switch_3pct=s.get("trailSwitch3pct", 0.03),
            trail_switch_8pct=s.get("trailSwitch8pct", 0.08),
        )


@dataclass
class Trade:
    """Completed trade record (one per lot sold). Fed to metrics engine."""
    symbol: str
    industry: str
    entry_date: str
    exit_date: str
    entry_price: float       # post-slippage fill (from OpenPosition)
    exit_price: float        # post-slippage sell price
    shares: int
    profit_ratio: float      # net of fees
    profit_amount: float     # dollar P&L net of fees
    exit_reason: str
    days_held: int
    sizing_mode: str = ""    # 'kelly' | 'risk_parity'
    entry_regime: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Intra-bar exit resolution
# ─────────────────────────────────────────────────────────────────────────────

def _round_lots(shares: int, lot_size: int = 1000) -> int:
    """Round down to nearest lot for TP1 partial exits."""
    return (shares // lot_size) * lot_size


def _calc_sell_net(
    exit_price: float, shares: int, entry_price: float, fees: FeeParams
) -> tuple[float, float]:
    """
    Returns (profit_ratio, profit_amount) net of TW buy/sell fees.
    Matches paper.ts closeMessages + backtest_service per-lot P&L.
    """
    buy_cost = entry_price * shares * (1 + fees.commission)
    sell_gross = exit_price * shares
    sell_commission = max(sell_gross * fees.commission, fees.min_commission)
    sell_tax = sell_gross * fees.tax
    sell_net = sell_gross - sell_commission - sell_tax

    profit_amount = sell_net - buy_cost
    profit_ratio = profit_amount / buy_cost if buy_cost > 0 else 0.0
    return profit_ratio, profit_amount


def _update_trailing_stop(
    pos: OpenPosition,
    bar_high: float,
    pnl_pct: float,
    exit_p: ExitParams,
) -> None:
    """
    Mirrors paper.ts trailing-stop update block. Mutates `pos` in place.
    Only called when no exit triggered this bar.
    """
    pos.highest_since_entry = max(pos.highest_since_entry, bar_high)

    # Profit-lock: tighter trail as profit grows
    if pnl_pct > exit_p.trail_switch_8pct:
        trail_mult = exit_p.trail_mult_at_8pct
    elif pnl_pct > exit_p.trail_switch_3pct:
        trail_mult = exit_p.trail_mult_at_3pct
    else:
        trail_mult = exit_p.trail_mult_default

    effective_atr = pos.atr14 if pos.atr14 > 0 else pos.entry_price * exit_p.fallback_atr_pct
    new_trailing = pos.highest_since_entry - effective_atr * trail_mult

    # Floor: after TP1, stop at entry (breakeven); before TP1, at initial_stop
    floor_stop = pos.entry_price if pos.tp1_hit else pos.initial_stop
    final_trailing = max(new_trailing, floor_stop)

    # Ratchet: trailing stop only moves up
    pos.initial_stop = max(final_trailing, pos.initial_stop)


@dataclass
class ExitDecision:
    """
    Point-in-time exit decision (mirrors paper.ts ExitDecision interface).

    Used ONLY by check_exit_pointwise() for Sprint 6a.7 parity test with
    Worker /api/admin/test/exit-cascade endpoint. Not consumed by the
    production backtest loop — step_position_one_bar has its own bar-level
    logic. See memory/project_backtest_engine_design_rationale.md §4.
    """
    action: str              # 'full_sell' | 'partial_sell' | 'hold'
    reason: str
    reason_category: str     # matches _categorizeExitReason() in Worker index.ts
    sell_shares: Optional[int] = None
    new_trailing_stop: Optional[float] = None
    new_highest: Optional[float] = None
    move_stop_to_entry: bool = False


def _categorize_exit_reason(reason: str) -> str:
    """Mirror of Worker _categorizeExitReason() for parity comparisons."""
    if "硬上限" in reason or "HardStop" in reason:
        return "HardStop"
    if "ATR 初始止損" in reason or "InitStop" in reason:
        return "InitStop"
    if "Trailing Stop" in reason or "TrailStop" in reason:
        return "TrailStop"
    if "ML SELL" in reason:
        return "ML_SELL"
    if "TP2" in reason:
        return "TP2"
    if "TP1" in reason:
        return "TP1"
    if "時間止損" in reason or "TimeStop" in reason:
        return "TimeStop"
    if "trailing update" in reason:
        return "HoldTrailingUpdate"
    return "HoldNoTrigger"


def check_exit_pointwise(
    pos_dict: dict,
    current_price: float,
    atr14: float,
    has_ml_sell: bool,
    is_eod: bool,
    exit_p: ExitParams,
) -> ExitDecision:
    """
    Point-in-time exit check — direct port of paper.ts checkExitConditions().

    Takes a single current_price (not OHLC bar) and returns the decision
    paper.ts would make at that instant. Used by Sprint 6a.7 parity test
    to verify drift vs paper.ts Worker implementation.

    Args:
        pos_dict: dict with keys matching paper.ts pos param:
                  {shares, avg_cost, entry_price, initial_stop, trailing_stop,
                   highest_since_entry, tp1_price, tp2_price, tp1_hit (0/1),
                   original_shares, entry_date, stop_multiplier}
        current_price: single price (not OHLC)
        atr14: ATR14 value
        has_ml_sell: bool — mimics paper.ts hasMlSell arg
        is_eod: bool — layers 3 (ML SELL) + 7 (time stop) only fire EOD
        exit_p: ExitParams

    Returns:
        ExitDecision with action + reason + reason_category.

    ⚠️ This is PARALLEL to step_position_one_bar(). step_position_one_bar
    processes OHLC bars and has intra-bar priority ordering; this function
    processes single-price snapshots matching paper.ts semantics exactly.
    Production backtest uses step_position_one_bar. This helper exists
    SOLELY for cross-runtime parity verification.
    """
    entry_price = pos_dict.get("entry_price") or pos_dict.get("avg_cost") or 0
    if entry_price <= 0:
        return ExitDecision(action="hold", reason="invalid entry_price",
                            reason_category="HoldNoTrigger")

    pnl_pct = (current_price - entry_price) / entry_price
    tp1_hit = bool(pos_dict.get("tp1_hit") or 0)

    # ❶ Hard stop (port paper.ts:352-355)
    if pnl_pct <= exit_p.hard_stop_pct:
        reason = f"硬上限止損 {pnl_pct * 100:.1f}%"
        return ExitDecision(
            action="full_sell", reason=reason,
            reason_category=_categorize_exit_reason(reason),
        )

    # ❷ ATR initial stop (port paper.ts:357-361)
    init_stop = pos_dict.get("initial_stop")
    if init_stop is None:
        init_stop = entry_price * exit_p.fallback_init_stop_mult
    if current_price <= init_stop:
        reason = f"ATR 初始止損 @ {init_stop:.1f}（{pnl_pct * 100:.1f}%）"
        return ExitDecision(
            action="full_sell", reason=reason,
            reason_category=_categorize_exit_reason(reason),
        )

    # ❸ ML SELL (EOD only) (port paper.ts:363-366)
    if is_eod and has_ml_sell:
        return ExitDecision(
            action="full_sell", reason="ML SELL 訊號",
            reason_category="ML_SELL",
        )

    # ❹ Chandelier trailing stop (port paper.ts:368-372)
    trailing_stop = pos_dict.get("trailing_stop")
    if trailing_stop is None:
        trailing_stop = init_stop
    if current_price <= trailing_stop and trailing_stop > init_stop:
        reason = f"Trailing Stop @ {trailing_stop:.1f}（{pnl_pct * 100:.1f}%）"
        return ExitDecision(
            action="full_sell", reason=reason,
            reason_category=_categorize_exit_reason(reason),
        )

    # ❺ TP1 (port paper.ts:374-386)
    tp1 = pos_dict.get("tp1_price")
    if tp1 is None:
        tp1 = entry_price * exit_p.fallback_tp1_mult
    if current_price >= tp1 and not tp1_hit:
        original_shares = pos_dict.get("original_shares") or pos_dict.get("shares") or 0
        sell_shares = int(original_shares * exit_p.tp1_sell_ratio / 1000) * 1000
        shares = pos_dict.get("shares") or 0
        if 0 < sell_shares < shares:
            reason = f"TP1 達標 @ {current_price:.1f}（+{pnl_pct * 100:.1f}%）"
            return ExitDecision(
                action="partial_sell", reason=reason,
                reason_category="TP1",
                sell_shares=sell_shares, move_stop_to_entry=True,
            )
        reason = f"TP1 達標（單張全出）@ {current_price:.1f}（+{pnl_pct * 100:.1f}%）"
        return ExitDecision(
            action="full_sell", reason=reason, reason_category="TP1",
        )

    # ❻ TP2 (port paper.ts:388-392)
    tp2 = pos_dict.get("tp2_price")
    if tp2 is None:
        tp2 = entry_price * exit_p.fallback_tp2_mult
    if current_price >= tp2 and tp1_hit:
        reason = f"TP2 達標 @ {current_price:.1f}（+{pnl_pct * 100:.1f}%）"
        return ExitDecision(
            action="full_sell", reason=reason, reason_category="TP2",
        )

    # ❼ Time stop (EOD only) (port paper.ts:394-400)
    if is_eod and pos_dict.get("entry_date"):
        # Note: paper.ts uses Date.now() — parity test must supply entry_date
        # far enough in the past to match. We accept the days_since_entry via
        # an optional `_days_since_entry` field for deterministic testing.
        days_since_entry = pos_dict.get("_days_since_entry")
        if days_since_entry is None:
            try:
                d = datetime.strptime(pos_dict["entry_date"][:10], "%Y-%m-%d")
                days_since_entry = (datetime.now() - d).days
            except (ValueError, TypeError, KeyError):
                days_since_entry = 0
        if days_since_entry > exit_p.time_stop_days and pnl_pct > exit_p.time_stop_min_profit:
            reason = f"時間止損（{days_since_entry} 天，+{pnl_pct * 100:.1f}%）"
            return ExitDecision(
                action="full_sell", reason=reason, reason_category="TimeStop",
            )

    # Hold with trailing update (port paper.ts:402-432)
    highest_so_far = max(pos_dict.get("highest_since_entry") or entry_price, current_price)

    if pnl_pct > exit_p.trail_switch_8pct:
        trail_mult = exit_p.trail_mult_at_8pct
    elif pnl_pct > exit_p.trail_switch_3pct:
        trail_mult = exit_p.trail_mult_at_3pct
    else:
        trail_mult = exit_p.trail_mult_default

    effective_atr = atr14 if atr14 > 0 else current_price * exit_p.fallback_atr_pct
    new_trailing = highest_so_far - effective_atr * trail_mult

    floor_stop = entry_price if tp1_hit else init_stop
    final_trailing = max(new_trailing, floor_stop)

    prev_trailing = pos_dict.get("trailing_stop") or init_stop
    updated_trailing = max(final_trailing, prev_trailing)

    if updated_trailing != prev_trailing or highest_so_far != (pos_dict.get("highest_since_entry") or entry_price):
        return ExitDecision(
            action="hold", reason="trailing update",
            reason_category="HoldTrailingUpdate",
            new_trailing_stop=updated_trailing,
            new_highest=highest_so_far,
        )

    return ExitDecision(
        action="hold", reason="no trigger",
        reason_category="HoldNoTrigger",
    )


def step_position_one_bar(
    pos: OpenPosition,
    bar: dict,
    bar_date: str,
    exit_p: ExitParams,
    fees: FeeParams,
) -> tuple[list[Trade], bool]:
    """
    Apply one day's OHLC bar to an open position. Returns (trades, closed_flag).

    If trades is non-empty, one or more lots were sold. If closed_flag is True,
    the position should be removed from account.positions.

    Paper.ts checkExitConditions is called with isEOD=True at day's close,
    so we evaluate time-stop and the full cascade once per bar.

    Intra-bar priority (conservative):
      1. Gap-open check: is open already past hard/initial stop → fill at open
      2. Low check: stops triggered intraday → fill at stop
      3. High check: TPs reached → partial/full TP exit
      4. Close check: final eval for trailing + time stop
    """
    trades: list[Trade] = []

    open_px = float(bar.get("open") or 0)
    high = float(bar.get("high") or 0)
    low = float(bar.get("low") or 0)
    close = float(bar.get("close") or 0)

    if close <= 0 or open_px <= 0:
        return trades, False  # skip invalid bar, position survives

    entry = pos.entry_price

    # ─── Step 1: gap-open hard/initial stop check ──────────────────────────
    open_pnl = (open_px - entry) / entry
    if open_pnl <= exit_p.hard_stop_pct:
        # Gap-down past hard stop → fill at open
        sell_px = apply_slippage(open_px, "sell", 1)
        pr, pa = _calc_sell_net(sell_px, pos.shares, entry, fees)
        trades.append(Trade(
            symbol=pos.symbol, industry=pos.industry,
            entry_date=pos.entry_date, exit_date=bar_date,
            entry_price=entry, exit_price=sell_px, shares=pos.shares,
            profit_ratio=pr, profit_amount=pa,
            exit_reason=f"GapHardStop ({open_pnl * 100:.1f}%)",
            days_held=_date_diff(pos.entry_date, bar_date),
            entry_regime=pos.entry_regime,
        ))
        return trades, True

    if open_px <= pos.initial_stop:
        # Gap-down past initial stop → fill at open
        sell_px = apply_slippage(open_px, "sell", 1)
        pr, pa = _calc_sell_net(sell_px, pos.shares, entry, fees)
        trades.append(Trade(
            symbol=pos.symbol, industry=pos.industry,
            entry_date=pos.entry_date, exit_date=bar_date,
            entry_price=entry, exit_price=sell_px, shares=pos.shares,
            profit_ratio=pr, profit_amount=pa,
            exit_reason=f"GapStop @ {pos.initial_stop:.1f} ({open_pnl * 100:.1f}%)",
            days_held=_date_diff(pos.entry_date, bar_date),
            entry_regime=pos.entry_regime,
        ))
        return trades, True

    # ─── Step 2: intraday low hits stop? ───────────────────────────────────
    if low <= pos.initial_stop:
        # Stop triggered — fill at stop (slightly worse due to slippage)
        sell_px = apply_slippage(pos.initial_stop, "sell", 1)
        pnl = (sell_px - entry) / entry
        reason = (
            "HardStop" if pnl <= exit_p.hard_stop_pct
            else f"Trail/InitStop @ {pos.initial_stop:.1f}"
        )
        pr, pa = _calc_sell_net(sell_px, pos.shares, entry, fees)
        trades.append(Trade(
            symbol=pos.symbol, industry=pos.industry,
            entry_date=pos.entry_date, exit_date=bar_date,
            entry_price=entry, exit_price=sell_px, shares=pos.shares,
            profit_ratio=pr, profit_amount=pa,
            exit_reason=f"{reason} ({pnl * 100:.1f}%)",
            days_held=_date_diff(pos.entry_date, bar_date),
            entry_regime=pos.entry_regime,
        ))
        return trades, True

    # ─── Step 3: intraday high hits TP2 (full) ─────────────────────────────
    if pos.tp1_hit and high >= pos.tp2_price:
        sell_px = apply_slippage(pos.tp2_price, "sell", 1)
        pnl = (sell_px - entry) / entry
        pr, pa = _calc_sell_net(sell_px, pos.shares, entry, fees)
        trades.append(Trade(
            symbol=pos.symbol, industry=pos.industry,
            entry_date=pos.entry_date, exit_date=bar_date,
            entry_price=entry, exit_price=sell_px, shares=pos.shares,
            profit_ratio=pr, profit_amount=pa,
            exit_reason=f"TP2 @ {pos.tp2_price:.1f} (+{pnl * 100:.1f}%)",
            days_held=_date_diff(pos.entry_date, bar_date),
            entry_regime=pos.entry_regime,
        ))
        return trades, True

    # ─── Step 4: intraday high hits TP1 (partial) ──────────────────────────
    if not pos.tp1_hit and high >= pos.tp1_price:
        # Sell 50% with lot rounding
        sell_target = int(pos.shares * exit_p.tp1_sell_ratio)
        sell_shares = _round_lots(sell_target)
        if 0 < sell_shares < pos.shares:
            # Partial fill
            sell_px = apply_slippage(pos.tp1_price, "sell", 1)
            pnl = (sell_px - entry) / entry
            pr, pa = _calc_sell_net(sell_px, sell_shares, entry, fees)
            trades.append(Trade(
                symbol=pos.symbol, industry=pos.industry,
                entry_date=pos.entry_date, exit_date=bar_date,
                entry_price=entry, exit_price=sell_px, shares=sell_shares,
                profit_ratio=pr, profit_amount=pa,
                exit_reason=f"TP1 partial @ {pos.tp1_price:.1f} (+{pnl * 100:.1f}%)",
                days_held=_date_diff(pos.entry_date, bar_date),
                entry_regime=pos.entry_regime,
            ))
            pos.shares -= sell_shares
            pos.tp1_hit = True
            # Move stop to breakeven (entry price)
            pos.initial_stop = max(pos.initial_stop, entry)
            # Continue — remaining shares evaluated for trailing/time stop at close
        else:
            # Single lot — full exit
            sell_px = apply_slippage(pos.tp1_price, "sell", 1)
            pnl = (sell_px - entry) / entry
            pr, pa = _calc_sell_net(sell_px, pos.shares, entry, fees)
            trades.append(Trade(
                symbol=pos.symbol, industry=pos.industry,
                entry_date=pos.entry_date, exit_date=bar_date,
                entry_price=entry, exit_price=sell_px, shares=pos.shares,
                profit_ratio=pr, profit_amount=pa,
                exit_reason=f"TP1 full (single lot) @ {pos.tp1_price:.1f} (+{pnl * 100:.1f}%)",
                days_held=_date_diff(pos.entry_date, bar_date),
                entry_regime=pos.entry_regime,
            ))
            return trades, True

    # ─── Step 5: close-of-day trailing update + time stop (EOD layer) ──────
    close_pnl = (close - entry) / entry

    # Update trailing stop (ratchet)
    _update_trailing_stop(pos, high, close_pnl, exit_p)

    # Time stop: days_held > timeStopDays AND pnl > timeStopMinProfit
    days_held = _date_diff(pos.entry_date, bar_date)
    if days_held > exit_p.time_stop_days and close_pnl > exit_p.time_stop_min_profit:
        sell_px = apply_slippage(close, "sell", 1)
        pr, pa = _calc_sell_net(sell_px, pos.shares, entry, fees)
        trades.append(Trade(
            symbol=pos.symbol, industry=pos.industry,
            entry_date=pos.entry_date, exit_date=bar_date,
            entry_price=entry, exit_price=sell_px, shares=pos.shares,
            profit_ratio=pr, profit_amount=pa,
            exit_reason=f"TimeStop ({days_held}d, +{close_pnl * 100:.1f}%)",
            days_held=days_held,
            entry_regime=pos.entry_regime,
        ))
        return trades, True

    # Position survives — no exit this bar
    return trades, False


def step_all_positions(
    account: AccountState,
    dataset: BacktestDataset,
    bar_date: str,
    exit_p: ExitParams,
    fees: FeeParams,
) -> list[Trade]:
    """
    Apply one day's bars to every open position in `account`.
    Mutates account (removes closed positions, credits cash on fills).
    Returns list of Trade records realized today.
    """
    all_trades: list[Trade] = []
    symbols_to_close: list[str] = []

    for symbol, pos in list(account.positions.items()):
        bar = dataset.get_bar(symbol, bar_date)
        if not bar:
            # No bar today — could be halted, delisted, or weekend. Skip.
            # Alternative: if delisted_date == bar_date, force-close at last
            # known price. For Mode A we tolerate gaps in data.
            continue

        trades, closed = step_position_one_bar(pos, bar, bar_date, exit_p, fees)

        for t in trades:
            # Credit cash: sell_gross - commission - tax (already in profit_amount)
            # Simpler: cash += exit_price * shares - fees
            sell_gross = t.exit_price * t.shares
            sell_commission = max(sell_gross * fees.commission, fees.min_commission)
            sell_tax = sell_gross * fees.tax
            account.cash += sell_gross - sell_commission - sell_tax

        all_trades.extend(trades)

        if closed:
            symbols_to_close.append(symbol)

    for symbol in symbols_to_close:
        del account.positions[symbol]

    return all_trades


# ═══════════════════════════════════════════════════════════════════════════════
# Metrics Engine (Phase 6a.4)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Aggregates Trade list + equity curve into BacktestMetrics.
# Computes Sharpe / Sortino / Calmar / MaxDD / ProfitFactor / Expectancy / CAGR /
# WinRate / fill_rate + per-regime breakdown.
#
# Per-regime stratification (Mode A):
#   Paper.ts uses market_risk.risk_level (green/yellow/orange/red/black) as a
#   coarse proxy. Sprint 4-2 revisit will replace with real HMM regime.
#   For now we key trades by their entry date's risk_level and group metrics.
#
# REALISM WARNINGS:
#   BacktestMetrics.realism_warnings lists Mode A deviations from production.
#   BacktestMetrics.absolute_confidence is 'relative_only' for Mode A.
#   Anyone reading a Sharpe number MUST check these fields before acting on it.
#   See memory/project_backtest_engine_design_rationale.md section 3.

# Canonical list of Mode A deviations from paper.ts (used for realism_warnings)
MODE_A_DEVIATIONS: list[str] = [
    "#1 No news sentiment bonus (pessimistic)",
    "#2 No F-Score / financials (pessimistic)",
    "#3 No PTT/Anue buzz (pessimistic)",
    "#4 No industry RRG rotation bonus (pessimistic)",
    "#5 No 處置股 filter (optimistic)",
    "#6 No ADX / liquidity tier filter (optimistic)",
    "#7 ml_confidence=0.5 placeholder (slightly pessimistic Kelly)",
    "#8 signal_tier=0.35 HOLD placeholder (neutral)",
    "#9 No correlation dedup (optimistic — portfolio Sharpe inflated)",
    "#10 DebateVerdict treated as APPROVE (optimistic)",
    "#11 ml_stop/target synthesized from ATR × sltp (neutral — this is the search target)",
    "#12 Limit fill simplified to low<=limit (pessimistic — no polling)",
    "#13 Kelly confidence=0.60 hardcode (neutral with #7)",
    "#14 Layer 3 ML SELL signal skipped (optimistic)",
    "#15 No intraday tick-level trailing updates (optimistic — close-only)",
]


@dataclass
class BacktestMetrics:
    """
    Full metrics output from a replay_period() run.

    ⚠️ READ BEFORE ACTING: always check `absolute_confidence` and
    `realism_warnings` before interpreting Sharpe/MaxDD as production predictions.
    See memory/project_backtest_engine_design_rationale.md §3.
    """
    # Identification
    mode: str = "A"                              # 'A' or 'B'
    start_date: str = ""
    end_date: str = ""
    initial_capital: float = 0.0
    final_equity: float = 0.0

    # Core return metrics
    total_return: float = 0.0                    # (final / initial) - 1
    cagr: Optional[float] = None
    sharpe: Optional[float] = None
    sortino: Optional[float] = None
    calmar: Optional[float] = None
    max_drawdown: float = 0.0                    # positive fraction (0.15 = 15%)
    max_drawdown_date: str = ""

    # Trade statistics
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    gross_profit: float = 0.0                    # sum of winning profit_ratio
    gross_loss: float = 0.0                      # absolute sum of losing profit_ratio
    profit_factor: float = 0.0                   # gross_profit / gross_loss
    expectancy: float = 0.0                      # (avg_win × win_rate) - (avg_loss × loss_rate)
    avg_holding_days: float = 0.0

    # Entry funnel
    candidates_generated: int = 0                # sum of has_buy_signal=1 across days
    entry_attempts: int = 0                      # EntryAttempt count
    entries_filled: int = 0                      # status='filled' count
    fill_rate: float = 0.0                       # entries_filled / entry_attempts
    skip_reasons: dict[str, int] = field(default_factory=dict)  # status → count

    # Exit distribution
    exit_distribution: dict[str, int] = field(default_factory=dict)  # reason category → count

    # Per-regime breakdown (key = risk_level: green/yellow/orange/red/black)
    per_regime: dict[str, dict] = field(default_factory=dict)

    # Realism safeguards (Mode A critical)
    realism_warnings: list[str] = field(default_factory=list)
    absolute_confidence: str = "relative_only"   # 'relative_only' | 'moderate' | 'high'
    sanity_flags: list[str] = field(default_factory=list)

    # Raw data for downstream analysis
    equity_curve: list[tuple[str, float]] = field(default_factory=list)  # (date, equity)
    trades: list[Trade] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Metric helpers
# ─────────────────────────────────────────────────────────────────────────────

def _exit_category(reason: str) -> str:
    """Bucket exit reasons into coarse categories for distribution display."""
    if "HardStop" in reason or "GapHardStop" in reason:
        return "HardStop"
    if "GapStop" in reason or "Trail/InitStop" in reason:
        return "TrailStop"
    if "TP2" in reason:
        return "TP2"
    if "TP1" in reason:
        return "TP1"
    if "TimeStop" in reason:
        return "TimeStop"
    if "ML_SELL" in reason:
        return "ML_SELL"
    return "Other"


def _safe_stdev(values: list[float]) -> float:
    """Population stdev with guard against <2 samples."""
    if len(values) < 2:
        return 0.0
    return float(np.std(values, ddof=1))


def _compute_sharpe(returns: list[float], periods_per_year: int = 250) -> Optional[float]:
    """Annualized Sharpe from trade-level returns (assumes rf=0)."""
    if len(returns) < 2:
        return None
    mean_r = float(np.mean(returns))
    std_r = _safe_stdev(returns)
    if std_r <= 0:
        return None
    n = min(len(returns), periods_per_year)
    return (mean_r / std_r) * math.sqrt(n)


def _compute_sortino(returns: list[float], periods_per_year: int = 250) -> Optional[float]:
    """Annualized Sortino (downside deviation only)."""
    if len(returns) < 2:
        return None
    downside = [r for r in returns if r < 0]
    if len(downside) < 2:
        return None
    mean_r = float(np.mean(returns))
    ds_std = _safe_stdev(downside)
    if ds_std <= 0:
        return None
    n = min(len(returns), periods_per_year)
    return (mean_r / ds_std) * math.sqrt(n)


def _compute_max_drawdown(equity_curve: list[tuple[str, float]]) -> tuple[float, str]:
    """
    Returns (max_drawdown_fraction, date_of_trough).
    max_drawdown is positive (0.15 = 15% drawdown).
    """
    if not equity_curve:
        return 0.0, ""
    peak = equity_curve[0][1]
    max_dd = 0.0
    max_dd_date = equity_curve[0][0]
    for date, equity in equity_curve:
        if equity > peak:
            peak = equity
        if peak > 0:
            dd = (peak - equity) / peak
            if dd > max_dd:
                max_dd = dd
                max_dd_date = date
    return max_dd, max_dd_date


def _compute_cagr(initial: float, final: float, start: str, end: str) -> Optional[float]:
    """Compound annual growth rate."""
    if initial <= 0 or final <= 0:
        return None
    try:
        d1 = datetime.strptime(start[:10], "%Y-%m-%d")
        d2 = datetime.strptime(end[:10], "%Y-%m-%d")
        years = max((d2 - d1).days / 365.25, 0.1)
    except (ValueError, TypeError):
        return None
    return (final / initial) ** (1 / years) - 1


def _apply_sanity_flags(m: BacktestMetrics) -> None:
    """
    Realism guard: flag Optuna-dangerous results so callers can reject them.
    Modifies metrics.sanity_flags in place.
    """
    if m.sharpe is not None and m.sharpe > 3.0:
        m.sanity_flags.append(
            f"sharpe={m.sharpe:.2f} > 3.0 — likely overfit, reject for Optuna"
        )
    if m.total_trades < 30:
        m.sanity_flags.append(
            f"n_trades={m.total_trades} < 30 — bootstrap CI too wide, use with caution"
        )
    if 0 < m.max_drawdown < 0.02:
        m.sanity_flags.append(
            f"max_dd={m.max_drawdown:.3f} < 2% — unrealistically low, check data"
        )
    if m.fill_rate > 0 and m.fill_rate < 0.10:
        m.sanity_flags.append(
            f"fill_rate={m.fill_rate:.2f} < 10% — Mode A limit fills rejected most"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Main metrics computation
# ─────────────────────────────────────────────────────────────────────────────

def compute_metrics(
    trades: list[Trade],
    equity_curve: list[tuple[str, float]],
    entry_attempts: list[EntryAttempt],
    initial_capital: float,
    start_date: str,
    end_date: str,
    mode: str = "A",
    regime_by_date: Optional[dict[str, str]] = None,
) -> BacktestMetrics:
    """
    Aggregate backtest outputs into BacktestMetrics.

    Args:
        trades: list of realized Trade records from step_all_positions
        equity_curve: list of (date, total_equity) snapshots per day
        entry_attempts: EntryAttempt list from simulate_entries_for_date
        initial_capital: starting cash
        start_date / end_date: backtest timerange
        mode: 'A' (rule-based) or 'B' (walk-forward ML) — sets realism warnings
        regime_by_date: optional map date → risk_level for per-regime breakdown
    """
    m = BacktestMetrics(
        mode=mode,
        start_date=start_date,
        end_date=end_date,
        initial_capital=initial_capital,
        final_equity=equity_curve[-1][1] if equity_curve else initial_capital,
        equity_curve=equity_curve,
        trades=trades,
    )

    # Realism warnings (Mode A critical)
    if mode == "A":
        m.realism_warnings = list(MODE_A_DEVIATIONS)
        m.absolute_confidence = "relative_only"
    elif mode == "B":
        # Mode B fixes #7, 8, 11, 13, 14 — keep the rest
        fixed = {"#7", "#8", "#11", "#13", "#14"}
        m.realism_warnings = [
            w for w in MODE_A_DEVIATIONS
            if not any(w.startswith(f) for f in fixed)
        ]
        m.absolute_confidence = "moderate"

    # Total return & CAGR
    m.total_return = (m.final_equity / initial_capital) - 1 if initial_capital > 0 else 0.0
    m.cagr = _compute_cagr(initial_capital, m.final_equity, start_date, end_date)

    # Trade stats
    m.total_trades = len(trades)
    if trades:
        wins = [t for t in trades if t.profit_ratio > 0]
        losses = [t for t in trades if t.profit_ratio <= 0]
        m.wins = len(wins)
        m.losses = len(losses)
        m.win_rate = m.wins / m.total_trades

        m.gross_profit = sum(t.profit_ratio for t in wins)
        m.gross_loss = abs(sum(t.profit_ratio for t in losses))
        m.profit_factor = m.gross_profit / m.gross_loss if m.gross_loss > 0 else 0.0

        avg_win = m.gross_profit / m.wins if m.wins > 0 else 0
        avg_loss = m.gross_loss / m.losses if m.losses > 0 else 0
        m.expectancy = avg_win * m.win_rate - avg_loss * (1 - m.win_rate)

        m.avg_holding_days = float(np.mean([t.days_held for t in trades]))

        returns = [t.profit_ratio for t in trades]
        m.sharpe = _compute_sharpe(returns)
        m.sortino = _compute_sortino(returns)

    # Max drawdown
    m.max_drawdown, m.max_dd_date = _compute_max_drawdown(equity_curve)

    # Calmar
    if m.cagr is not None and m.max_drawdown > 0:
        m.calmar = m.cagr / m.max_drawdown

    # Entry funnel
    m.entry_attempts = len(entry_attempts)
    m.entries_filled = sum(1 for a in entry_attempts if a.status == "filled")
    m.fill_rate = m.entries_filled / m.entry_attempts if m.entry_attempts > 0 else 0.0
    m.candidates_generated = len([a for a in entry_attempts if a.status != "skipped_industry"])

    skip_counts: dict[str, int] = {}
    for a in entry_attempts:
        skip_counts[a.status] = skip_counts.get(a.status, 0) + 1
    m.skip_reasons = skip_counts

    # Exit distribution
    exit_counts: dict[str, int] = {}
    for t in trades:
        cat = _exit_category(t.exit_reason)
        exit_counts[cat] = exit_counts.get(cat, 0) + 1
    m.exit_distribution = exit_counts

    # Per-regime stratification (Mode A uses market_risk.risk_level proxy)
    if regime_by_date and trades:
        regime_trades: dict[str, list[Trade]] = {}
        for t in trades:
            r = regime_by_date.get(t.entry_date, "unknown")
            regime_trades.setdefault(r, []).append(t)

        for regime, r_trades in regime_trades.items():
            r_wins = [t for t in r_trades if t.profit_ratio > 0]
            r_returns = [t.profit_ratio for t in r_trades]
            m.per_regime[regime] = {
                "n_trades": len(r_trades),
                "win_rate": len(r_wins) / len(r_trades) if r_trades else 0,
                "avg_return": float(np.mean(r_returns)) if r_returns else 0,
                "sharpe": _compute_sharpe(r_returns),
                "total_pnl": sum(t.profit_amount for t in r_trades),
            }

    # Sanity flags (reject overfit Optuna trials)
    _apply_sanity_flags(m)

    return m


def build_regime_map(dataset: BacktestDataset) -> dict[str, str]:
    """
    Build date → risk_level map from dataset.market_risk.
    Used as Mode A regime proxy (Sprint 4-2 revisit will replace with HMM).
    """
    out: dict[str, str] = {}
    if dataset.market_risk.empty:
        return out
    for date, row in dataset.market_risk.iterrows():
        level = row.get("risk_level") or "unknown"
        out[str(date)] = str(level)
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# Bootstrap CI & Walk-forward Helpers (Phase 6a.5)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Two primitives that downstream Optuna callers must use to stay honest about
# small-sample noise and in-sample overfitting.
#
# bootstrap_metric(): resample trades with replacement → confidence interval.
#   Required because Mode A realism caveats mean single-point estimates are
#   meaningless. Always report (mean, ci_low, ci_high) tuples.
#
# walk_forward(): split timerange into rolling train/test windows.
#   Required because any Optuna search that trains and tests on the same range
#   is by definition overfit. The Optuna driver (Sprint 5) is expected to:
#     1. Call walk_forward(start, end, train_days, test_days) → list of windows
#     2. For each window: optimize params on train_range, evaluate on test_range
#     3. Report test_range metrics (not train_range) as the Optuna objective
#     4. Average test metrics across windows for final params selection

from typing import Callable


@dataclass
class BootstrapCI:
    """Confidence interval estimate from bootstrap resampling."""
    mean: float
    ci_low: float
    ci_high: float
    n_bootstrap: int
    confidence: float       # e.g. 0.90 = 90% CI
    sample_size: int        # len(trades) used as input


def bootstrap_metric(
    trades: list[Trade],
    metric_fn: Callable[[list[Trade]], Optional[float]],
    n_bootstrap: int = 1000,
    confidence: float = 0.90,
    seed: Optional[int] = None,
) -> Optional[BootstrapCI]:
    """
    Estimate confidence interval of a metric by resampling trades with replacement.

    Args:
        trades:       input trade list (sample_size = len(trades))
        metric_fn:    callable that takes list[Trade] and returns a scalar
                      (or None if undefined for that sample)
        n_bootstrap:  number of resamples (default 1000, paper.ts convention)
        confidence:   e.g. 0.90 → returns (5th, 95th) percentiles
        seed:         optional RNG seed for deterministic Optuna replays

    Returns:
        BootstrapCI, or None if fewer than 2 trades (CI undefined).

    Example:
        >>> ci = bootstrap_metric(
        ...     trades,
        ...     lambda ts: _compute_sharpe([t.profit_ratio for t in ts]),
        ...     n_bootstrap=1000,
        ... )
        >>> print(f"sharpe = {ci.mean:.2f} [{ci.ci_low:.2f}, {ci.ci_high:.2f}]")
    """
    n = len(trades)
    if n < 2:
        return None

    rng = np.random.default_rng(seed)
    samples: list[float] = []

    for _ in range(n_bootstrap):
        idx = rng.integers(0, n, size=n)
        resampled = [trades[i] for i in idx]
        val = metric_fn(resampled)
        if val is not None and not math.isnan(val) and not math.isinf(val):
            samples.append(float(val))

    if len(samples) < 2:
        return None

    alpha = 1 - confidence
    lo_pct = (alpha / 2) * 100
    hi_pct = (1 - alpha / 2) * 100
    return BootstrapCI(
        mean=float(np.mean(samples)),
        ci_low=float(np.percentile(samples, lo_pct)),
        ci_high=float(np.percentile(samples, hi_pct)),
        n_bootstrap=n_bootstrap,
        confidence=confidence,
        sample_size=n,
    )


# ── Convenience wrappers for common metrics ─────────────────────────────────

def bootstrap_sharpe(
    trades: list[Trade], n_bootstrap: int = 1000, seed: Optional[int] = None
) -> Optional[BootstrapCI]:
    """Bootstrap CI for annualized Sharpe ratio from trade returns."""
    return bootstrap_metric(
        trades,
        lambda ts: _compute_sharpe([t.profit_ratio for t in ts]),
        n_bootstrap=n_bootstrap,
        seed=seed,
    )


def bootstrap_profit_factor(
    trades: list[Trade], n_bootstrap: int = 1000, seed: Optional[int] = None
) -> Optional[BootstrapCI]:
    """Bootstrap CI for profit factor (gross_profit / gross_loss)."""
    def _pf(ts: list[Trade]) -> Optional[float]:
        wins = [t.profit_ratio for t in ts if t.profit_ratio > 0]
        losses = [abs(t.profit_ratio) for t in ts if t.profit_ratio <= 0]
        gp = sum(wins)
        gl = sum(losses)
        if gl <= 0:
            return None  # undefined
        return gp / gl
    return bootstrap_metric(trades, _pf, n_bootstrap=n_bootstrap, seed=seed)


def bootstrap_win_rate(
    trades: list[Trade], n_bootstrap: int = 1000, seed: Optional[int] = None
) -> Optional[BootstrapCI]:
    """Bootstrap CI for win rate."""
    return bootstrap_metric(
        trades,
        lambda ts: len([t for t in ts if t.profit_ratio > 0]) / len(ts) if ts else None,
        n_bootstrap=n_bootstrap,
        seed=seed,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Walk-forward window generation
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class WalkForwardWindow:
    """Single rolling window for walk-forward validation."""
    window_id: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str


def walk_forward_windows(
    trading_days: list[str],
    train_window_days: int = 60,
    test_window_days: int = 30,
    step_days: Optional[int] = None,
) -> list[WalkForwardWindow]:
    """
    Generate rolling train/test windows for walk-forward backtest.

    Windows are aligned to actual trading days (not calendar days), so for a
    60-day train window we take 60 *trading* days ≈ 12 calendar weeks.

    Args:
        trading_days:       sorted list of trading day strings (use dataset.trading_days)
        train_window_days:  number of trading days per training fold
        test_window_days:   number of trading days per OOS test fold
        step_days:          how many days to advance between windows
                            (default = test_window_days → non-overlapping test folds)

    Returns:
        list of WalkForwardWindow, empty if timerange is too short.

    Example (2-year data, default params):
      ~500 trading days, train=60, test=30, step=30
      → ~(500 - 60 - 30) / 30 + 1 ≈ 14 windows

    Usage (Sprint 5 Optuna driver):
        windows = walk_forward_windows(dataset.trading_days)
        oos_metrics = []
        for w in windows:
            best_params = optuna_search(dataset, w.train_start, w.train_end)
            m = replay_period(dataset, w.test_start, w.test_end, best_params)
            oos_metrics.append(m)
        # Final: average test Sharpe across all windows
    """
    if step_days is None:
        step_days = test_window_days

    n = len(trading_days)
    min_required = train_window_days + test_window_days
    if n < min_required:
        return []

    windows: list[WalkForwardWindow] = []
    window_id = 0
    i = 0
    while i + min_required <= n:
        train_start = trading_days[i]
        train_end = trading_days[i + train_window_days - 1]
        test_start = trading_days[i + train_window_days]
        test_end = trading_days[i + train_window_days + test_window_days - 1]

        windows.append(WalkForwardWindow(
            window_id=window_id,
            train_start=train_start,
            train_end=train_end,
            test_start=test_start,
            test_end=test_end,
        ))
        window_id += 1
        i += step_days

    return windows


# ═══════════════════════════════════════════════════════════════════════════════
# replay_period — Main Entrypoint (Phase 6a.6)
# ═══════════════════════════════════════════════════════════════════════════════
#
# The main loop that glues all primitives together.
#
# Daily sequence (mirrors paper.ts timing):
#   Day T open:     exit sweep on all existing positions using T's OHLC
#                   (catches overnight gap downs + intraday stop hits)
#   Day T open:     fill limit orders from T-1's screener candidates
#                   (morning setup → intraday fills)
#   Day T close:    mark-to-market equity snapshot for equity_curve
#   Day T close:    run screener for T+1 candidates
#
# Note the one-day offset between decision and entry:
#   Day T-1 close → screener picks candidates
#   Day T open    → limit orders attempt fill
#   This matches paper.ts setupMorningPendingBuys on day T reading daily_recommendations
#   written by runBottomUpScreener on T-1 evening.


def _mark_to_market(account: AccountState, dataset: BacktestDataset, date: str) -> float:
    """
    Compute total portfolio value = cash + unrealized position value at date's close.

    Missing bars (halted / data gaps) fall back to last known close → avg_cost
    (conservative: no unrealized markup for halted positions).
    """
    total = account.cash
    for symbol, pos in account.positions.items():
        bar = dataset.get_bar(symbol, date)
        close = float(bar.get("close") or 0) if bar else 0
        if close <= 0:
            # Halted / no data → mark at entry price (neutral)
            close = pos.entry_price
        total += close * pos.shares
    return total


def replay_period(
    dataset: BacktestDataset,
    start_date: str,
    end_date: str,
    params: dict,
    initial_capital: float = 1_000_000,
    mode: str = "A",
    verbose: bool = False,
) -> BacktestMetrics:
    """
    Full Mode A rule-based backtest replay over [start_date, end_date].

    Args:
        dataset:          preloaded BacktestDataset (call BacktestDataset.load_from_d1
                          yourself or use replay_period_loading wrapper)
        start_date:       'YYYY-MM-DD' inclusive start of replay
        end_date:         'YYYY-MM-DD' inclusive end of replay
        params:           trading:config shape dict (KV JSON or equivalent).
                          All sub-sections optional — missing sub-sections use
                          dataclass defaults matching production Worker KV defaults.
                          Expected keys: screener, ranking, position, sltp, exit, fees
        initial_capital:  starting cash (default 1M TWD)
        mode:             'A' for Mode A (rule-based) or 'B' for Mode B (walk-forward ML)
        verbose:          log per-day progress if True

    Returns:
        BacktestMetrics with realism_warnings + sanity_flags populated.
        Trade list + equity curve included for downstream bootstrap_metric.

    ⚠️ READ THIS BEFORE USING THE RESULT:
    Mode A Sharpe is unreliable as absolute production prediction (±0.3~0.8
    deviation from real Sharpe). Use only for RELATIVE comparisons between
    parameter sets. See BacktestMetrics.realism_warnings + sanity_flags +
    memory/project_backtest_engine_design_rationale.md section 3.
    """
    # ── Build typed params from dict (with defaults for missing sections) ──
    screener_p = ScreenerParams.from_trading_config(params)
    ranking_p = RankingParams.from_trading_config(params)
    pos_p = PositionSizeParams.from_trading_config(params)
    sltp_p = SLTPParams.from_trading_config(params)
    exit_p = ExitParams.from_trading_config(params)
    fees_p = FeeParams.from_trading_config(params)

    # ── Filter dataset trading days to requested range ─────────────────────
    replay_days = [
        d for d in dataset.trading_days if start_date <= d <= end_date
    ]
    if not replay_days:
        logger.warning(
            f"[BacktestEngine] No trading days in range {start_date}~{end_date}"
        )
        return BacktestMetrics(
            mode=mode,
            start_date=start_date,
            end_date=end_date,
            initial_capital=initial_capital,
            final_equity=initial_capital,
            realism_warnings=list(MODE_A_DEVIATIONS) if mode == "A" else [],
            absolute_confidence="relative_only" if mode == "A" else "moderate",
            sanity_flags=["No trading days in replay range"],
        )

    logger.info(
        f"[BacktestEngine] replay {replay_days[0]}~{replay_days[-1]} "
        f"({len(replay_days)} days) mode={mode}"
    )

    # ── Initialize state ───────────────────────────────────────────────────
    account = AccountState(
        cash=initial_capital,
        initial_capital=initial_capital,
    )

    all_trades: list[Trade] = []
    all_attempts: list[EntryAttempt] = []
    equity_curve: list[tuple[str, float]] = []

    # Candidates decided at the PREVIOUS trading day's close
    prev_decision_date: Optional[str] = None
    prev_candidates: list[Candidate] = []

    # ── Main daily loop ────────────────────────────────────────────────────
    for i, day in enumerate(replay_days):
        # Step 1: exit sweep on existing positions
        trades_today = step_all_positions(account, dataset, day, exit_p, fees_p)
        all_trades.extend(trades_today)

        # Step 2: attempt entries from prev day's candidates (T-1 → T fill)
        if prev_candidates and prev_decision_date is not None:
            attempts = simulate_entries_for_date(
                dataset=dataset,
                decision_date=prev_decision_date,
                entry_date=day,
                candidates=prev_candidates,
                account=account,
                pos=pos_p,
                sltp=sltp_p,
                fees=fees_p,
            )
            all_attempts.extend(attempts)

        # Step 3: mark-to-market equity snapshot at today's close
        equity = _mark_to_market(account, dataset, day)
        equity_curve.append((day, equity))

        # Step 4: run screener at today's close → tomorrow's candidates
        # (Skip on the last day since there's no T+1 to enter on)
        if i < len(replay_days) - 1:
            prev_candidates = replay_screener_for_date(
                dataset=dataset,
                date=day,
                screener=screener_p,
                ranking=ranking_p,
            )
            prev_decision_date = day

        if verbose and (i + 1) % 20 == 0:
            logger.info(
                f"[BacktestEngine]   day {i + 1}/{len(replay_days)} ({day}) "
                f"positions={len(account.positions)} cash={account.cash:.0f} "
                f"trades={len(all_trades)}"
            )

    # ── Close any still-open positions at final day's close (forced exit) ──
    if account.positions:
        final_day = replay_days[-1]
        logger.info(
            f"[BacktestEngine] Force-closing {len(account.positions)} "
            f"open positions at {final_day}"
        )
        for symbol in list(account.positions.keys()):
            pos = account.positions[symbol]
            bar = dataset.get_bar(symbol, final_day)
            if not bar:
                continue
            close = float(bar.get("close") or 0)
            if close <= 0:
                continue
            sell_px = apply_slippage(close, "sell", 1)
            pr, pa = _calc_sell_net(sell_px, pos.shares, pos.entry_price, fees_p)
            all_trades.append(Trade(
                symbol=pos.symbol,
                industry=pos.industry,
                entry_date=pos.entry_date,
                exit_date=final_day,
                entry_price=pos.entry_price,
                exit_price=sell_px,
                shares=pos.shares,
                profit_ratio=pr,
                profit_amount=pa,
                exit_reason=f"ForcedClose @ {sell_px:.1f} ({pr * 100:.1f}%)",
                days_held=_date_diff(pos.entry_date, final_day),
                entry_regime=pos.entry_regime,
            ))
            sell_gross = sell_px * pos.shares
            sell_commission = max(sell_gross * fees_p.commission, fees_p.min_commission)
            sell_tax = sell_gross * fees_p.tax
            account.cash += sell_gross - sell_commission - sell_tax
            del account.positions[symbol]

        # Update final equity snapshot post-force-close
        if equity_curve:
            equity_curve[-1] = (final_day, account.cash)

    # ── Compute final metrics ──────────────────────────────────────────────
    regime_map = build_regime_map(dataset)
    metrics = compute_metrics(
        trades=all_trades,
        equity_curve=equity_curve,
        entry_attempts=all_attempts,
        initial_capital=initial_capital,
        start_date=replay_days[0],
        end_date=replay_days[-1],
        mode=mode,
        regime_by_date=regime_map,
    )

    logger.info(
        f"[BacktestEngine] Done: trades={metrics.total_trades} "
        f"sharpe={metrics.sharpe} max_dd={metrics.max_drawdown:.3f} "
        f"fill_rate={metrics.fill_rate:.2f} sanity_flags={len(metrics.sanity_flags)}"
    )

    return metrics


def replay_period_loading(
    start_date: str,
    end_date: str,
    params: dict,
    initial_capital: float = 1_000_000,
    mode: str = "A",
    symbols: Optional[list[str]] = None,
    verbose: bool = False,
) -> BacktestMetrics:
    """
    Convenience wrapper: loads dataset from D1 then runs replay.

    Use this for one-shot runs (router endpoint, smoke test). For Optuna
    objective functions that run many trials on the same data, preload
    dataset once with BacktestDataset.load_from_d1() and call replay_period
    directly to avoid re-fetching D1 for every trial.
    """
    dataset = BacktestDataset.load_from_d1(
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
    )
    return replay_period(
        dataset=dataset,
        start_date=start_date,
        end_date=end_date,
        params=params,
        initial_capital=initial_capital,
        mode=mode,
        verbose=verbose,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# TODO (Phase 6a.7) — final integration
# ═══════════════════════════════════════════════════════════════════════════════

# 6a.7 Router wiring: ml-controller/routers/backtest.py /backtest/replay endpoint
# 6a.7 Smoke test: scripts/backtest_smoke_test.py (tiny universe + short range)
# 6a.7 Parity test: tests/test_cascade_parity.py + Worker /admin/test/exit-cascade
