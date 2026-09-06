"""Canonical MACD, parity tested against Worker technicalSignalMath.ts."""
from __future__ import annotations

import math
from collections.abc import Sequence

TECHNICAL_SIGNAL_MATH_VERSION = 'macd-ema-first-seed-12-26-9-v1'


def ema_series(values: Sequence[float], period: int) -> list[float]:
    if len(values) == 0 or period <= 0:
        return []
    alpha = 2.0 / (period + 1)
    result = [float(values[0])]
    for value in values[1:]:
        result.append(float(value)*alpha + result[-1]*(1-alpha))
    return result


def macd_histogram_last(closes: Sequence[float]) -> float | None:
    if len(closes) < 35 or not all(math.isfinite(float(value)) for value in closes):
        return None
    fast, slow = ema_series(closes, 12), ema_series(closes, 26)
    line = [a-b for a,b in zip(fast,slow,strict=True)]
    signal = ema_series(line,9)
    return line[-1]-signal[-1]
