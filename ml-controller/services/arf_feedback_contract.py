from __future__ import annotations

from typing import Any


def _is_updated(value: Any) -> bool:
    return isinstance(value, dict) and bool(value.get("updated"))


def validate_arf_feedback_results(items: list[dict], results: list[Any]) -> list[str]:
    """Validate that every planned online feedback update actually persisted."""

    errors: list[str] = []
    if len(results) != len(items):
        errors.append(f"result_count_mismatch planned={len(items)} actual={len(results)}")

    for index, item in enumerate(items):
        symbol = str(item.get("symbol") or item.get("stock_id") or index)
        result = results[index] if index < len(results) else None
        if not isinstance(result, dict):
            errors.append(f"{symbol}: invalid_result_type={type(result).__name__}")
            continue
        if result.get("error"):
            errors.append(f"{symbol}: {result.get('error')}")
            continue

        nested = result.get("results")
        if not isinstance(nested, dict):
            errors.append(f"{symbol}: missing_update_results")
            continue

        if not _is_updated(nested.get("arf")):
            errors.append(f"{symbol}: arf_not_updated")
        if item.get("model_name") and not _is_updated(nested.get("linucb")):
            errors.append(f"{symbol}: linucb_not_updated")
        if item.get("forecast_pct") and not _is_updated(nested.get("conformal")):
            errors.append(f"{symbol}: conformal_not_updated")

    return errors


def count_updated_arf(results: list[Any]) -> int:
    return sum(
        1
        for result in results
        if isinstance(result, dict)
        and isinstance(result.get("results"), dict)
        and _is_updated(result["results"].get("arf"))
    )
