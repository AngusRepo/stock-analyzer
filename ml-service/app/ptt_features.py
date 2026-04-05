"""
ptt_features.py — P2#23 PTT Sentiment Features for ML

4 new features from PTT buzz data:
  1. mention_count: number of PTT mentions in last 3 days
  2. sentiment_ratio: positive/(positive+negative) mentions
  3. volume_change_on_mention: volume spike when PTT buzz > threshold
  4. buzz_to_price_lag: correlation between buzz and next-day price change

These features are added to the feature matrix and validated by IC audit.
Auto-removed if IC < 0.02 (via weak_features filtering in P1#9).
"""
import numpy as np
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def compute_ptt_features(
    dates: list[str],
    ptt_data: list[dict],
    volumes: list[float],
    closes: list[float],
) -> Optional[dict[str, list[float]]]:
    """
    Compute 4 PTT sentiment features aligned with price dates.

    Args:
        dates: list of YYYY-MM-DD strings (price dates)
        ptt_data: list of {date, mention_count, positive, negative, neutral}
        volumes: daily trading volumes
        closes: daily close prices

    Returns:
        dict with 4 feature arrays, or None if insufficient data
    """
    if not ptt_data or len(dates) < 10:
        return None

    # Build date→ptt lookup
    ptt_map: dict[str, dict] = {}
    for p in ptt_data:
        ptt_map[p["date"]] = p

    n = len(dates)
    mention_count = np.zeros(n)
    sentiment_ratio = np.full(n, 0.5)  # neutral default
    vol_change_on_mention = np.zeros(n)
    buzz_to_price_lag = np.zeros(n)

    for i, date in enumerate(dates):
        # 3-day rolling mention count
        mentions_3d = 0
        pos_3d = 0
        neg_3d = 0
        for j in range(max(0, i - 2), i + 1):
            if j < len(dates):
                p = ptt_map.get(dates[j], {})
                mentions_3d += p.get("mention_count", 0)
                pos_3d += p.get("positive", 0)
                neg_3d += p.get("negative", 0)

        mention_count[i] = mentions_3d

        total_sentiment = pos_3d + neg_3d
        if total_sentiment > 0:
            sentiment_ratio[i] = pos_3d / total_sentiment

        # Volume change on mention: if mentions > 5, compare volume to 10d avg
        if mentions_3d > 5 and i >= 10:
            avg_vol = np.mean(volumes[max(0, i - 10):i])
            if avg_vol > 0:
                vol_change_on_mention[i] = (volumes[i] - avg_vol) / avg_vol

        # Buzz-to-price lag: yesterday's mention → today's return
        if i > 0 and closes[i - 1] > 0:
            prev_ptt = ptt_map.get(dates[i - 1], {})
            prev_mentions = prev_ptt.get("mention_count", 0)
            today_return = (closes[i] - closes[i - 1]) / closes[i - 1]
            buzz_to_price_lag[i] = prev_mentions * today_return  # interaction term

    return {
        "ptt_mention_count": mention_count.tolist(),
        "ptt_sentiment_ratio": sentiment_ratio.tolist(),
        "ptt_vol_change_on_mention": vol_change_on_mention.tolist(),
        "ptt_buzz_to_price_lag": buzz_to_price_lag.tolist(),
    }


# Feature names for registration in FEATURE_COLS
PTT_FEATURE_NAMES = [
    "ptt_mention_count",
    "ptt_sentiment_ratio",
    "ptt_vol_change_on_mention",
    "ptt_buzz_to_price_lag",
]
