from __future__ import annotations

import gzip
import hashlib
import json
from typing import Any


STATE_SCHEMA_V1 = "pipeline-async-state-v1"
STATE_SCHEMA_V2 = "pipeline-async-state-v2"
PAYLOAD_IDENTITY_SCHEMA = "pipeline-payload-identity-v1"


def _ordered_symbols(payloads: list[dict[str, Any]]) -> list[str]:
    symbols = [
        str(row.get("symbol") or row.get("stock_id") or "").strip()
        for row in payloads
        if isinstance(row, dict)
    ]
    if not payloads or len(symbols) != len(payloads) or any(not symbol for symbol in symbols):
        raise ValueError("pipeline_payload_identity_symbols_invalid")
    if len(set(symbols)) != len(symbols):
        raise ValueError("pipeline_payload_identity_symbols_duplicate")
    return symbols


def build_pipeline_payload_identity(payloads: list[dict[str, Any]]) -> dict[str, Any]:
    symbols = _ordered_symbols(payloads)
    encoded = json.dumps(
        symbols,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "schema_version": PAYLOAD_IDENTITY_SCHEMA,
        "count": len(payloads),
        "ordered_symbols_sha256": hashlib.sha256(encoded).hexdigest(),
    }


def validate_pipeline_payload_identity(state: dict[str, Any]) -> list[dict[str, Any]]:
    payloads = state.get("payloads") if isinstance(state.get("payloads"), list) else []
    if not payloads or any(not isinstance(row, dict) for row in payloads):
        raise ValueError("pipeline_payload_identity_payloads_incomplete")

    contract = state.get("pipeline_payload_identity")
    if isinstance(contract, dict):
        expected = build_pipeline_payload_identity(payloads)
        if contract != expected:
            raise ValueError("pipeline_payload_identity_contract_mismatch")
        return payloads

    # Backward compatibility for immutable v1 artifacts. New writers must use
    # the compact identity contract and must not serialize the payload twice.
    legacy = state.get("l3_payloads") if isinstance(state.get("l3_payloads"), list) else []
    if not legacy or len(legacy) != len(payloads):
        raise ValueError("pipeline_payload_identity_legacy_incomplete")
    if _ordered_symbols(legacy) != _ordered_symbols(payloads):
        raise ValueError("pipeline_payload_identity_legacy_mismatch")
    return payloads


def encode_pipeline_state_envelope(payload: dict[str, Any]) -> bytes:
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return gzip.compress(raw, compresslevel=6, mtime=0)


def decode_pipeline_state_envelope(raw: bytes) -> dict[str, Any]:
    decoded = gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw
    payload = json.loads(decoded.lstrip(b"\xef\xbb\xbf"))
    if payload.get("schema_version") not in {STATE_SCHEMA_V1, STATE_SCHEMA_V2}:
        raise ValueError("pipeline_async_state_schema_invalid")
    state = payload.get("state")
    if not isinstance(state, dict):
        raise ValueError("pipeline_async_state_missing")
    validate_pipeline_payload_identity(state)
    return payload
