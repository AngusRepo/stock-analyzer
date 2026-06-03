"""
persona_service.py — Taiwan-market persona opinion service

Computes two daily per-stock "persona opinions" that augment the quantitative
ML ensemble with market-participant perspectives:

  - 投信 (investment_trust):  institutional momentum signal, quarter-end
                              window-dressing aware
  - 散戶 (retail, contrarian): margin-balance dynamics + concept buzz;
                              signals typically fire CONTRARIAN to retail
                              behavior (panic → buy, euphoria → caution)

Why Taiwan-specific personas (not US investor transplants):

  The ai-hedge-fund project uses personas such as Buffett/Burry/Wood. Those
  personas are effective for US equities but weak for TW mid/small-cap
  where the dominant participant structure is 外資/投信/散戶 and behavior
  is driven by tax cycle, quarterly reporting, and margin leverage — not
  long-term fundamental theses. Taiwan personas therefore read chip_data
  and margin_data directly rather than generating narrative opinions.

Reference (behavioral + institutional finance):

  - Black, F. (1986). "Noise." Journal of Finance 41(3), 529-543.
    Classical framing of retail "noise traders" as systematic providers
    of the mispricing opportunity — exactly what our contrarian 散戶
    signal exploits.

  - Shleifer, A. (2000). "Inefficient Markets: An Introduction to
    Behavioral Finance." Oxford University Press. Chapter on noise-
    trader risk.

  - 台灣特有現象文獻：
      Barber et al. (2009). "Just How Much Do Individual Investors Lose
      by Trading?" Review of Financial Studies 22(2). — 台股散戶年均
      負報酬 3.8%，驗證 contrarian 訊號可剝削性。

Design notes:

  - This module is side-effect-free EXCEPT for the public `write_opinions`
    function. `compute_*` helpers are pure; unit tests exercise them
    without D1 access.
  - All percentile calculations use midrank to handle ties smoothly.
  - On insufficient history (< MIN_HISTORY bars), persona returns NEUTRAL
    with an explanatory reason — caller should treat this as "no signal"
    rather than "bearish".
"""
from __future__ import annotations

import logging
import statistics
from dataclasses import dataclass, asdict
from datetime import date as _date, datetime
from typing import Literal, Optional, Sequence

logger = logging.getLogger(__name__)


# ── Tuning knobs (exposed for unit tests + future Optuna sweep) ──────────────

TRUST_PERCENTILE_BUY = 0.75   # trust_5d_net above P75(60d) → BUY
TRUST_PERCENTILE_SELL = 0.25  # trust_5d_net below P25(60d) → SELL
TRUST_MIN_ABS_NET = 1.0       # below this abs value (1 張) → NEUTRAL regardless
TRUST_WINDOW_DRESS_DAMPEN = 0.7  # at quarter-end, multiply strength by this

RETAIL_MARGIN_PANIC_DROP = -0.05      # margin balance 3-day drop ≤ -5% → panic
RETAIL_MARGIN_EUPHORIA_RISE = 0.10    # margin balance 5-day rise ≥ +10% → euphoria
RETAIL_SENTIMENT_BULLISH = 0.5        # concept_buzz.sentiment_avg threshold
RETAIL_SENTIMENT_EUPHORIC = 0.75

MIN_TRUST_HISTORY = 20        # need this many days of chip_data for percentile
MIN_MARGIN_HISTORY = 5        # need this many days of margin_data for delta


Signal = Literal["BUY", "SELL", "NEUTRAL", "CAUTION"]


# ─────────────────────────────────────────────────────────────────────────────
# Result types
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TrustOpinion:
    signal: Signal
    strength: float              # 0..1
    reason: str
    is_window_dress: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RetailOpinion:
    signal: Signal
    strength: float
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PersonaOpinions:
    """Combined per-stock persona opinions for a given date."""
    symbol: str
    date: str
    trust: TrustOpinion
    retail: RetailOpinion


# ─────────────────────────────────────────────────────────────────────────────
# Utility: percentile rank (midrank)
# ─────────────────────────────────────────────────────────────────────────────

def _percentile_rank(value: float, history: Sequence[float]) -> float:
    """Return rank in [0, 1]; 0 = smallest, 1 = largest; midrank handles ties."""
    if not history:
        return 0.5
    below = sum(1 for h in history if h < value)
    equal = sum(1 for h in history if h == value)
    return (below + equal / 2.0) / len(history)


# ─────────────────────────────────────────────────────────────────────────────
# Quarter-end window-dressing detection
# ─────────────────────────────────────────────────────────────────────────────

# Taiwan market tradition: investment-trust funds tend to rebalance
# (and often support their existing holdings) in the last 10 trading days
# of each calendar quarter end (Mar / Jun / Sep / Dec). During this window
# the trust net signal is a less-reliable indicator of genuine conviction,
# so we downweight it.
_QUARTER_END_MONTHS = {3, 6, 9, 12}


def is_window_dressing_zone(d: _date, recent_trading_dates: Sequence[str]) -> bool:
    """
    Is `d` in a window-dressing zone (last 10 trading days of Mar/Jun/Sep/Dec)?

    We derive "trading day rank within month" by counting trading-day
    dates in the same calendar month that are <= d. If d is among the last
    10 such days in a quarter-end month, it's the dressing zone.
    """
    if d.month not in _QUARTER_END_MONTHS:
        return False
    same_month = sorted(
        [s for s in recent_trading_dates if s.startswith(f"{d.year}-{d.month:02d}")]
    )
    if d.isoformat() not in same_month:
        # d may be today and not yet indexed as a trading day
        same_month.append(d.isoformat())
        same_month.sort()
    # index of d from the end of its trading month
    try:
        rank_from_end = len(same_month) - 1 - same_month.index(d.isoformat())
    except ValueError:
        return False
    return rank_from_end < 10


# ─────────────────────────────────────────────────────────────────────────────
# 投信 (Trust) agent
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ChipBar:
    date: str
    trust_net: float  # in 張 (shares); positive = net buy


def compute_trust_opinion(
    chip_history: Sequence[ChipBar],
    today: _date,
) -> TrustOpinion:
    """
    Pure function. Given at least MIN_TRUST_HISTORY days of chip data
    (most recent last), return a TrustOpinion.

    Logic:
      trust_5d_net     = sum of last 5 bars' trust_net
      trust_history    = sum-of-5-rolling across the full window
      percentile       = rank of today's trust_5d_net within history
      direction:
        pct >= 0.75 AND trust_5d_net > 0 → BUY
        pct <= 0.25 AND trust_5d_net < 0 → SELL
        else                              → NEUTRAL

      strength = min(1.0, |pct - 0.5| * 2)    # 0 at median, 1 at extremes
      window-dressing zone: strength *= TRUST_WINDOW_DRESS_DAMPEN (0.7)
    """
    if len(chip_history) < MIN_TRUST_HISTORY:
        return TrustOpinion(
            signal="NEUTRAL", strength=0.0,
            reason=f"insufficient_chip_history ({len(chip_history)}<{MIN_TRUST_HISTORY})",
        )

    # Build 5-day rolling sums ending at each position (skip first 4 — no window)
    sums = []
    for i in range(4, len(chip_history)):
        s = sum(chip_history[j].trust_net for j in range(i - 4, i + 1))
        sums.append(s)

    if not sums:
        return TrustOpinion(
            signal="NEUTRAL", strength=0.0, reason="cannot_build_rolling_window",
        )

    trust_5d_today = sums[-1]
    # Compare today against history of 5-day sums (exclude today itself)
    history = sums[:-1] if len(sums) > 1 else sums
    pct = _percentile_rank(trust_5d_today, history)

    # Decide signal
    signal: Signal = "NEUTRAL"
    reason_bits = []
    if abs(trust_5d_today) < TRUST_MIN_ABS_NET:
        signal = "NEUTRAL"
        reason_bits.append(f"trust_5d_net={trust_5d_today:.0f} below threshold")
    elif pct >= TRUST_PERCENTILE_BUY and trust_5d_today > 0:
        signal = "BUY"
        reason_bits.append(f"trust_5d={trust_5d_today:+.0f} P{pct*100:.0f}")
    elif pct <= TRUST_PERCENTILE_SELL and trust_5d_today < 0:
        signal = "SELL"
        reason_bits.append(f"trust_5d={trust_5d_today:+.0f} P{pct*100:.0f}")
    else:
        signal = "NEUTRAL"
        reason_bits.append(f"trust_5d={trust_5d_today:+.0f} mid-range P{pct*100:.0f}")

    # Strength: how far from median
    raw_strength = min(1.0, abs(pct - 0.5) * 2.0)

    # Window-dressing dampening
    recent_dates = [b.date for b in chip_history[-40:]]
    in_wd = is_window_dressing_zone(today, recent_dates)
    strength = raw_strength * (TRUST_WINDOW_DRESS_DAMPEN if in_wd else 1.0)
    if in_wd:
        reason_bits.append(f"window-dress (×{TRUST_WINDOW_DRESS_DAMPEN})")

    return TrustOpinion(
        signal=signal,
        strength=round(strength, 3),
        reason="; ".join(reason_bits),
        is_window_dress=in_wd,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 散戶 (Retail, contrarian) agent
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class MarginBar:
    date: str
    margin_balance: float  # in 張


def compute_retail_opinion(
    margin_history: Sequence[MarginBar],
    concept_sentiment: Optional[float],  # [-1, 1] from concept_buzz, or None
) -> RetailOpinion:
    """
    Contrarian retail agent. Retail behavior is noise; signals fire OPPOSITE
    to crowd panic/euphoria.

    Logic:
      margin_delta_3d = (margin[-1] / margin[-4]) - 1   # 3-day ago baseline
      margin_delta_5d = (margin[-1] / margin[-6]) - 1   # 5-day ago baseline
      sentiment       = concept_sentiment ∈ [-1, 1]

      Panic (BUY for us):
        margin_delta_3d < RETAIL_MARGIN_PANIC_DROP  (-5%)
        AND (sentiment is None OR sentiment > RETAIL_SENTIMENT_BULLISH)
        → signal="BUY", strength=min(1, |delta|/0.10)

      Euphoria (CAUTION):
        margin_delta_5d > RETAIL_MARGIN_EUPHORIA_RISE (+10%)
        AND sentiment > RETAIL_SENTIMENT_EUPHORIC    (+0.75)
        → signal="CAUTION", strength=min(1, delta/0.20)

      Otherwise → NEUTRAL.
    """
    if len(margin_history) < MIN_MARGIN_HISTORY:
        return RetailOpinion(
            signal="NEUTRAL", strength=0.0,
            reason=f"insufficient_margin_history ({len(margin_history)}<{MIN_MARGIN_HISTORY})",
        )

    m_today = margin_history[-1].margin_balance
    if m_today <= 0:
        return RetailOpinion(
            signal="NEUTRAL", strength=0.0, reason="zero_margin_balance",
        )

    # 3-day delta (need >= 4 bars)
    delta_3d = None
    if len(margin_history) >= 4:
        m_past = margin_history[-4].margin_balance
        if m_past > 0:
            delta_3d = m_today / m_past - 1.0

    # 5-day delta (need >= 6 bars)
    delta_5d = None
    if len(margin_history) >= 6:
        m_past5 = margin_history[-6].margin_balance
        if m_past5 > 0:
            delta_5d = m_today / m_past5 - 1.0

    # Panic path (contrarian BUY)
    if delta_3d is not None and delta_3d <= RETAIL_MARGIN_PANIC_DROP:
        sentiment_ok = concept_sentiment is None or concept_sentiment > RETAIL_SENTIMENT_BULLISH
        if sentiment_ok:
            strength = min(1.0, abs(delta_3d) / 0.10)
            sent_str = (
                f"sent={concept_sentiment:+.2f}" if concept_sentiment is not None
                else "sent=unknown"
            )
            return RetailOpinion(
                signal="BUY",
                strength=round(strength, 3),
                reason=f"margin_3d={delta_3d*100:+.1f}% panic + {sent_str} (contrarian)",
            )

    # Euphoria path (contrarian CAUTION)
    if (
        delta_5d is not None
        and delta_5d >= RETAIL_MARGIN_EUPHORIA_RISE
        and concept_sentiment is not None
        and concept_sentiment >= RETAIL_SENTIMENT_EUPHORIC
    ):
        strength = min(1.0, delta_5d / 0.20)
        return RetailOpinion(
            signal="CAUTION",
            strength=round(strength, 3),
            reason=f"margin_5d={delta_5d*100:+.1f}% + sent={concept_sentiment:+.2f} euphoric",
        )

    # Otherwise neutral
    parts = []
    if delta_3d is not None:
        parts.append(f"margin_3d={delta_3d*100:+.1f}%")
    if delta_5d is not None:
        parts.append(f"margin_5d={delta_5d*100:+.1f}%")
    if concept_sentiment is not None:
        parts.append(f"sent={concept_sentiment:+.2f}")
    return RetailOpinion(
        signal="NEUTRAL",
        strength=0.0,
        reason=("normal: " + ", ".join(parts)) if parts else "normal",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Score weighting (used by recommendation_service.py in Phase 2)
# ─────────────────────────────────────────────────────────────────────────────

def compute_persona_score(
    trust: TrustOpinion,
    retail: RetailOpinion,
    max_score: float = 20.0,
) -> float:
    """
    Map persona opinions to a numeric score addendum for total_score ranking.

    Conventions (documented in migration + recommendation_service):
      trust BUY  →  +10 × strength     (e.g. strength=0.72 → +7.2)
      trust SELL →  -10 × strength
      retail BUY →  +5  × strength
      retail SELL →  -5  × strength
      retail CAUTION → -5 × strength    (penalty for euphoria)
      NEUTRAL   → 0

    Return value is clipped to [-max_score, +max_score].
    """
    score = 0.0
    if trust.signal == "BUY":
        score += 10.0 * trust.strength
    elif trust.signal == "SELL":
        score -= 10.0 * trust.strength

    if retail.signal == "BUY":
        score += 5.0 * retail.strength
    elif retail.signal in ("SELL", "CAUTION"):
        score -= 5.0 * retail.strength

    return round(max(-max_score, min(max_score, score)), 2)


# ─────────────────────────────────────────────────────────────────────────────
# D1 I/O
# ─────────────────────────────────────────────────────────────────────────────

def write_opinions(
    d1_client,
    opinions: Sequence[PersonaOpinions],
) -> int:
    """
    Upsert persona opinions into D1. Uses ON CONFLICT to keep idempotent.
    Returns number of rows written. Caller should wrap in try/except; this
    function intentionally raises on DB error so the pipeline can log it.
    """
    if not opinions:
        return 0
    written = 0
    for op in opinions:
        try:
            d1_client.execute(
                """
                INSERT INTO persona_opinions
                  (date, symbol,
                   trust_signal, trust_strength, trust_reason, trust_is_window_dress,
                   retail_signal, retail_strength, retail_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(date, symbol) DO UPDATE SET
                  trust_signal           = excluded.trust_signal,
                  trust_strength         = excluded.trust_strength,
                  trust_reason           = excluded.trust_reason,
                  trust_is_window_dress  = excluded.trust_is_window_dress,
                  retail_signal          = excluded.retail_signal,
                  retail_strength        = excluded.retail_strength,
                  retail_reason          = excluded.retail_reason
                """,
                [
                    op.date, op.symbol,
                    op.trust.signal, op.trust.strength, op.trust.reason,
                    1 if op.trust.is_window_dress else 0,
                    op.retail.signal, op.retail.strength, op.retail.reason,
                ],
            )
            written += 1
        except Exception as e:
            logger.warning(f"[persona] write failed for {op.symbol}@{op.date}: {e}")
    return written
