"""Checksum-verified Worker client for archived screener evidence."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from typing import Any

from services.worker_config_client import worker_auth_headers, worker_url


RESOLVE_PATH = "/api/internal/evidence-artifacts/legacy-screener/resolve"
MAX_ARTIFACTS_PER_REQUEST = 2
MAX_ROWS_PER_REQUEST = 400


def _default_post(payload: dict[str, Any]) -> dict[str, Any]:
    import httpx

    response = httpx.post(
        worker_url() + RESOLVE_PATH,
        headers=worker_auth_headers(),
        json=payload,
        timeout=60.0,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"legacy_evidence_resolve_failed:http_{response.status_code}:{response.text[:300]}"
        )
    body = response.json()
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise RuntimeError("legacy_evidence_resolve_failed:invalid_response")
    return body


def resolve_legacy_screener_evidence(
    pointers: list[dict[str, Any]],
    *,
    post_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[int, dict[str, Any]]:
    """Resolve every requested row or fail the complete materialization."""

    if not pointers:
        return {}
    grouped: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    expected: dict[int, dict[str, Any]] = {}
    for pointer in pointers:
        row_id = int(pointer.get("row_id") or 0)
        identity = (
            str(pointer.get("artifact_id") or ""),
            str(pointer.get("r2_key") or ""),
            str(pointer.get("checksum") or "").lower(),
            str(pointer.get("source_run_id") or ""),
        )
        if row_id <= 0 or not all(identity) or row_id in expected:
            raise RuntimeError(f"legacy_evidence_pointer_invalid:{row_id}")
        expected[row_id] = pointer
        grouped[identity].append(pointer)

    requests: list[dict[str, Any]] = []
    for identity, rows in sorted(grouped.items()):
        row_ids = sorted(int(row["row_id"]) for row in rows)
        for offset in range(0, len(row_ids), MAX_ROWS_PER_REQUEST):
            requests.append({
                "artifact_id": identity[0],
                "r2_key": identity[1],
                "checksum": identity[2],
                "source_run_id": identity[3],
                "row_ids": row_ids[offset : offset + MAX_ROWS_PER_REQUEST],
            })

    request_batches: list[list[dict[str, Any]]] = []
    batch: list[dict[str, Any]] = []
    batch_rows = 0
    for request in requests:
        request_rows = len(request["row_ids"])
        if batch and (
            len(batch) >= MAX_ARTIFACTS_PER_REQUEST
            or batch_rows + request_rows > MAX_ROWS_PER_REQUEST
        ):
            request_batches.append(batch)
            batch = []
            batch_rows = 0
        batch.append(request)
        batch_rows += request_rows
    if batch:
        request_batches.append(batch)

    sender = post_fn or _default_post
    resolved: dict[int, dict[str, Any]] = {}
    for request_batch in request_batches:
        body = sender({"artifacts": request_batch})
        rows = body.get("rows") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            raise RuntimeError("legacy_evidence_resolve_failed:rows_missing")
        for row in rows:
            row_id = int((row or {}).get("row_id") or 0)
            pointer = expected.get(row_id)
            if pointer is None or row_id in resolved:
                raise RuntimeError(f"legacy_evidence_resolve_failed:unexpected_row:{row_id}")
            if (
                str(row.get("symbol") or "") != str(pointer.get("symbol") or "")
                or str(row.get("stage") or "") != "scoring"
                or str(row.get("source_run_id") or "") != str(pointer.get("source_run_id") or "")
                or str(row.get("artifact_id") or "") != str(pointer.get("artifact_id") or "")
                or str(row.get("r2_key") or "") != str(pointer.get("r2_key") or "")
                or str(row.get("checksum") or "").lower()
                != str(pointer.get("checksum") or "").lower()
                or not isinstance(row.get("evidence"), str)
            ):
                raise RuntimeError(f"legacy_evidence_resolve_failed:row_mismatch:{row_id}")
            resolved[row_id] = dict(row)

    missing = sorted(set(expected) - set(resolved))
    if missing:
        raise RuntimeError(f"legacy_evidence_resolve_failed:missing_rows:{missing[:10]}")
    return resolved
