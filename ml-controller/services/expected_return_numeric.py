"""Shared finite arithmetic for formal and shadow EV, with one cost owner."""
import math
from typing import Any

from services.expected_return_cost_contract import normalize_expected_return_to_net


def finite(value: Any, field: str) -> float:
    if value is None or isinstance(value, bool) or isinstance(value, str) and not value.strip():
        raise ValueError('expected_return_numeric_missing:' + field)
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('expected_return_numeric_nonfinite:' + field)
    return result


def evaluate_linear_net(*, intercept: Any, coefficients: dict[str, Any], features: dict[str, Any],
                        artifact: dict[str, Any], clip: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    if not isinstance(coefficients, dict) or not coefficients:
        raise ValueError('expected_return_coefficients_missing')
    # Artifact JSON may reorder keys during transport. Canonical order plus
    # accurate summation makes formal/replay arithmetic bit-stable; this is
    # the same linear model, not a looser comparison or a different cost owner.
    terms = [finite(intercept, 'intercept')]
    for name in sorted(coefficients):
        terms.append(finite(coefficients[name], name + '.coefficient') * finite(features.get(name), name))
    try:
        raw = math.fsum(terms)
    except OverflowError as exc:
        raise ValueError('expected_return_numeric_nonfinite:raw_prediction') from exc
    value, cost = normalize_expected_return_to_net(finite(raw, 'raw_prediction'), artifact)
    cost['raw_linear_prediction'] = raw
    low = finite(clip['min'], 'clip.min') if clip.get('min') is not None else None
    high = finite(clip['max'], 'clip.max') if clip.get('max') is not None else None
    if low is not None and high is not None and low > high:
        raise ValueError('expected_return_clip_bounds_inverted')
    if low is not None:
        value = max(low, value)
    if high is not None:
        value = min(high, value)
    return value, cost
