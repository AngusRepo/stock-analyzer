"""
test_persona_service.py — unit tests for 投信/散戶 persona agents.

Tests are pure (no D1 access); they drive the compute_* functions with
synthesized chip/margin/sentiment inputs and assert on the resulting
TrustOpinion / RetailOpinion.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.persona_service import (  # noqa: E402
    ChipBar, MarginBar,
    TrustOpinion, RetailOpinion,
    compute_trust_opinion,
    compute_retail_opinion,
    compute_persona_score,
    is_window_dressing_zone,
    MIN_TRUST_HISTORY,
    MIN_MARGIN_HISTORY,
    TRUST_WINDOW_DRESS_DAMPEN,
)


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _chip_history(values: list[float], start: str = "2026-03-01") -> list[ChipBar]:
    """Build ChipBar list; dates are sequential business days starting `start`."""
    from datetime import datetime, timedelta
    d0 = datetime.fromisoformat(start)
    out = []
    for i, v in enumerate(values):
        out.append(ChipBar(date=(d0 + timedelta(days=i)).date().isoformat(),
                           trust_net=float(v)))
    return out


def _margin_history(values: list[float], start: str = "2026-03-01") -> list[MarginBar]:
    from datetime import datetime, timedelta
    d0 = datetime.fromisoformat(start)
    out = []
    for i, v in enumerate(values):
        out.append(MarginBar(date=(d0 + timedelta(days=i)).date().isoformat(),
                             margin_balance=float(v)))
    return out


# ═══════════════════════════════════════════════════════════════════════════
# Trust agent
# ═══════════════════════════════════════════════════════════════════════════

class TestTrustAgent:
    def test_insufficient_history_returns_neutral(self):
        op = compute_trust_opinion(_chip_history([100.0] * 5), date(2026, 4, 1))
        assert op.signal == "NEUTRAL"
        assert op.strength == 0.0
        assert "insufficient" in op.reason

    def test_strong_recent_buying_triggers_buy(self):
        # 25 days of flat (0), then last 5 days strong buying
        hist = _chip_history([0.0] * 25 + [500.0, 600.0, 550.0, 700.0, 800.0])
        op = compute_trust_opinion(hist, date(2026, 4, 1))
        assert op.signal == "BUY"
        assert op.strength > 0.5

    def test_strong_recent_selling_triggers_sell(self):
        hist = _chip_history([0.0] * 25 + [-500.0, -600.0, -550.0, -700.0, -800.0])
        op = compute_trust_opinion(hist, date(2026, 4, 1))
        assert op.signal == "SELL"
        assert op.strength > 0.5

    def test_midrange_returns_neutral(self):
        # Gentle noise, no extreme
        values = [10.0, -5.0, 15.0, -10.0, 5.0] * 6  # 30 days cycling
        op = compute_trust_opinion(_chip_history(values), date(2026, 4, 1))
        assert op.signal == "NEUTRAL"

    def test_below_abs_threshold_neutral(self):
        # History shows variation but today's 5d sum is tiny
        hist = _chip_history([100.0] * 20 + [-100.0] * 5 + [0.0, 0.0, 0.1, 0.1, 0.1])
        op = compute_trust_opinion(hist, date(2026, 4, 1))
        assert op.signal == "NEUTRAL"
        assert "below threshold" in op.reason

    def test_window_dress_dampens_strength(self):
        """Quarter-end (last 10 trading days of Mar) should apply 0.7x dampen."""
        from datetime import datetime, timedelta
        d0 = datetime(2026, 3, 1)
        values = [0.0] * 25 + [800.0, 900.0, 850.0, 1000.0, 1100.0]
        bars = []
        for i, v in enumerate(values):
            # Space them so last bar is near end of March
            bars.append(ChipBar(
                date=(d0 + timedelta(days=i)).date().isoformat(),
                trust_net=float(v),
            ))
        today_in_wd = date(2026, 3, 30)  # near end of March
        op = compute_trust_opinion(bars, today_in_wd)
        assert op.signal == "BUY"
        assert op.is_window_dress is True
        # Strength should be the un-dampened × 0.7
        op_no_wd = compute_trust_opinion(bars, date(2026, 2, 15))  # not quarter-end
        # Note both should compute same raw percentile, but window-dress dampens
        assert op.strength == pytest.approx(op_no_wd.strength * TRUST_WINDOW_DRESS_DAMPEN,
                                            abs=0.05)


class TestWindowDressDetection:
    def test_non_quarter_month_never_in_zone(self):
        # Build a list of April trading days
        april_dates = [f"2026-04-{d:02d}" for d in range(1, 29) if d not in (4, 5, 11, 12, 18, 19, 25, 26)]
        assert is_window_dressing_zone(date(2026, 4, 28), april_dates) is False

    def test_quarter_end_last_10_days_detected(self):
        march_dates = [f"2026-03-{d:02d}" for d in range(1, 32) if d not in (1, 7, 8, 14, 15, 21, 22, 28, 29)]
        # March 30 should be in last 10 trading days
        assert is_window_dressing_zone(date(2026, 3, 30), march_dates) is True

    def test_early_quarter_end_month_not_in_zone(self):
        march_dates = [f"2026-03-{d:02d}" for d in range(1, 32) if d not in (1, 7, 8, 14, 15, 21, 22, 28, 29)]
        # March 5 should NOT be in last 10 days
        assert is_window_dressing_zone(date(2026, 3, 5), march_dates) is False


# ═══════════════════════════════════════════════════════════════════════════
# Retail agent
# ═══════════════════════════════════════════════════════════════════════════

class TestRetailAgent:
    def test_insufficient_history_neutral(self):
        op = compute_retail_opinion(_margin_history([1000.0, 1000.0]), concept_sentiment=0.3)
        assert op.signal == "NEUTRAL"
        assert "insufficient" in op.reason

    def test_panic_drop_with_positive_sentiment_triggers_contrarian_buy(self):
        # margin 3-day drop: 1000 → 940 (=-6%) with bullish sentiment
        hist = _margin_history([1000.0, 1000.0, 1000.0, 1000.0, 940.0])
        op = compute_retail_opinion(hist, concept_sentiment=0.6)
        assert op.signal == "BUY"
        assert op.strength > 0
        assert "contrarian" in op.reason

    def test_panic_drop_with_unknown_sentiment_still_triggers_buy(self):
        # Without sentiment data, panic alone is enough
        hist = _margin_history([1000.0, 1000.0, 1000.0, 1000.0, 920.0])
        op = compute_retail_opinion(hist, concept_sentiment=None)
        assert op.signal == "BUY"

    def test_panic_drop_with_bearish_sentiment_stays_neutral(self):
        # Panic + bearish sentiment = not a contrarian setup (still in downtrend)
        hist = _margin_history([1000.0, 1000.0, 1000.0, 1000.0, 920.0])
        op = compute_retail_opinion(hist, concept_sentiment=-0.5)
        assert op.signal == "NEUTRAL"

    def test_euphoria_rise_with_high_sentiment_triggers_caution(self):
        # 5-day rise: 1000 → 1150 (+15%) with euphoric sentiment
        hist = _margin_history([1000.0, 1050.0, 1080.0, 1100.0, 1120.0, 1150.0])
        op = compute_retail_opinion(hist, concept_sentiment=0.8)
        assert op.signal == "CAUTION"
        assert "euphoric" in op.reason

    def test_euphoria_without_high_sentiment_stays_neutral(self):
        # Margin up but sentiment moderate → NEUTRAL (need both)
        hist = _margin_history([1000.0, 1050.0, 1080.0, 1100.0, 1120.0, 1150.0])
        op = compute_retail_opinion(hist, concept_sentiment=0.3)
        assert op.signal == "NEUTRAL"

    def test_stable_margin_returns_neutral(self):
        hist = _margin_history([1000.0, 1005.0, 998.0, 1002.0, 1001.0, 1003.0])
        op = compute_retail_opinion(hist, concept_sentiment=0.2)
        assert op.signal == "NEUTRAL"

    def test_zero_margin_balance_returns_neutral(self):
        hist = _margin_history([1000.0, 1000.0, 1000.0, 1000.0, 0.0])
        op = compute_retail_opinion(hist, concept_sentiment=0.5)
        assert op.signal == "NEUTRAL"
        assert "zero" in op.reason


# ═══════════════════════════════════════════════════════════════════════════
# Persona score aggregation
# ═══════════════════════════════════════════════════════════════════════════

class TestPersonaScore:
    def test_both_buy_sums_positive(self):
        trust = TrustOpinion("BUY", 0.8, "t")
        retail = RetailOpinion("BUY", 0.6, "r")
        score = compute_persona_score(trust, retail)
        # 10*0.8 + 5*0.6 = 8 + 3 = 11
        assert score == pytest.approx(11.0, abs=0.05)

    def test_trust_buy_retail_caution_partial_offset(self):
        trust = TrustOpinion("BUY", 1.0, "strong buy")
        retail = RetailOpinion("CAUTION", 1.0, "euphoric")
        score = compute_persona_score(trust, retail)
        # +10 - 5 = +5
        assert score == pytest.approx(5.0, abs=0.05)

    def test_both_sell_sums_negative(self):
        trust = TrustOpinion("SELL", 0.9, "t")
        retail = RetailOpinion("CAUTION", 0.8, "r")
        score = compute_persona_score(trust, retail)
        # -10*0.9 - 5*0.8 = -13
        assert score == pytest.approx(-13.0, abs=0.05)

    def test_both_neutral_zero(self):
        trust = TrustOpinion("NEUTRAL", 0.0, "n")
        retail = RetailOpinion("NEUTRAL", 0.0, "n")
        assert compute_persona_score(trust, retail) == 0.0

    def test_clipped_to_max(self):
        # Even extremes shouldn't exceed max_score
        trust = TrustOpinion("BUY", 1.0, "t")
        retail = RetailOpinion("BUY", 1.0, "r")
        score = compute_persona_score(trust, retail, max_score=10.0)
        assert score == 10.0

    def test_window_dress_already_reduced_strength_propagates(self):
        # is_window_dress isn't directly in scoring; strength carries the info
        trust = TrustOpinion("BUY", 0.49, "window-dressed", is_window_dress=True)
        retail = RetailOpinion("NEUTRAL", 0.0, "n")
        score = compute_persona_score(trust, retail)
        assert score == pytest.approx(4.9, abs=0.05)
