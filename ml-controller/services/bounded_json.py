"""Valid, deterministic JSON compaction for bounded D1 evidence columns."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

DEFAULT_MAX_UTF8_BYTES = 50_000


class BoundedJsonContractError(ValueError):
    """Raised when a bounded payload cannot preserve its declared evidence contract."""


def _dump(value: Any, *, ensure_ascii: bool) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=ensure_ascii,
            separators=(",", ":"),
            default=str,
            allow_nan=False,
        )
    except ValueError as exc:
        raise BoundedJsonContractError("bounded_json_non_finite_number") from exc


def _compact(value: Any, *, sample_size: int, depth: int = 0) -> Any:
    if depth >= 8:
        return {"_truncated": True, "reason": "max_depth", "type": type(value).__name__}
    if isinstance(value, dict):
        items = list(value.items())
        max_items = max(12, sample_size * 25)
        selected = items[:max_items]
        result = {
            str(key): _compact(item, sample_size=sample_size, depth=depth + 1)
            for key, item in selected
        }
        if len(items) > len(selected):
            result["_truncated_keys"] = {
                "count": len(items) - len(selected),
                "total": len(items),
            }
        return result
    if isinstance(value, (list, tuple)):
        values = list(value)
        if len(values) <= sample_size * 2 + 2:
            return [_compact(item, sample_size=sample_size, depth=depth + 1) for item in values]
        head = values[:sample_size]
        tail = values[-min(sample_size, max(0, len(values) - len(head))):] if sample_size else []
        return {
            "_truncated_list": True,
            "count": len(values),
            "head": [_compact(item, sample_size=sample_size, depth=depth + 1) for item in head],
            "tail": [_compact(item, sample_size=sample_size, depth=depth + 1) for item in tail],
        }
    if isinstance(value, str):
        max_chars = max(128, sample_size * 256)
        if len(value) <= max_chars:
            return value
        return value[:max_chars] + f"…[truncated {len(value) - max_chars} chars]"
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)


def bounded_json_dumps(
    payload: Any,
    *,
    max_utf8_bytes: int = DEFAULT_MAX_UTF8_BYTES,
    ensure_ascii: bool = False,
    preserve_exact_keys: Iterable[str] = (),
) -> str:
    """Serialize bounded JSON without silently sampling declared evidence fields.

    preserve_exact_keys is for algorithmic evidence consumed by a later job.
    Non-critical fields may be compacted while these top-level fields remain
    JSON-equivalent. If the exact fields still do not fit, fail closed.
    """
    if max_utf8_bytes < 512:
        raise ValueError("max_utf8_bytes must be at least 512")

    exact_keys = tuple(dict.fromkeys(str(key) for key in preserve_exact_keys if str(key)))
    if exact_keys and not isinstance(payload, dict):
        raise BoundedJsonContractError("bounded_json_exact_keys_require_mapping")

    raw = _dump(payload, ensure_ascii=ensure_ascii)
    raw_bytes = raw.encode("utf-8")
    if len(raw_bytes) <= max_utf8_bytes:
        return raw

    identity = {
        "schema_version": "bounded-json-v2",
        "truncated": True,
        "original_utf8_bytes": len(raw_bytes),
        "original_sha256": hashlib.sha256(raw_bytes).hexdigest(),
    }

    if exact_keys:
        present_exact_keys = tuple(key for key in exact_keys if key in payload)
        for sample_size in (8, 4, 2, 1, 0):
            candidate_payload = {
                str(key): (
                    value
                    if str(key) in present_exact_keys
                    else _compact(value, sample_size=sample_size)
                )
                for key, value in payload.items()
            }
            candidate_payload["_bounded_json"] = {
                **identity,
                "exact_keys": list(present_exact_keys),
            }
            candidate = _dump(candidate_payload, ensure_ascii=ensure_ascii)
            if len(candidate.encode("utf-8")) <= max_utf8_bytes:
                return candidate
        raise BoundedJsonContractError(
            "bounded_json_exact_fields_exceed_limit:"
            + ",".join(present_exact_keys or exact_keys)
        )

    for sample_size in (8, 4, 2, 1, 0):
        candidate = _dump({
            **identity,
            "payload": _compact(payload, sample_size=sample_size),
        }, ensure_ascii=ensure_ascii)
        if len(candidate.encode("utf-8")) <= max_utf8_bytes:
            return candidate

    fallback = _dump(identity, ensure_ascii=ensure_ascii)
    if len(fallback.encode("utf-8")) > max_utf8_bytes:
        raise ValueError("bounded JSON metadata exceeds configured limit")
    return fallback


def assert_bounded_json_fields_complete(payload: Any, consumed_fields: Iterable[str]) -> None:
    """Reject truncated payloads unless every consumed field was preserved exactly."""
    fields = {str(field) for field in consumed_fields if str(field)}
    if not fields or not isinstance(payload, dict):
        return

    if payload.get("truncated") is True and "payload" in payload:
        raise BoundedJsonContractError("bounded_json_legacy_truncated_payload")

    metadata = payload.get("_bounded_json")
    if not isinstance(metadata, dict) or metadata.get("truncated") is not True:
        return
    exact_keys = {str(key) for key in metadata.get("exact_keys") or []}
    missing = sorted(fields - exact_keys)
    if missing:
        raise BoundedJsonContractError(
            "bounded_json_consumed_fields_not_exact:" + ",".join(missing)
        )
