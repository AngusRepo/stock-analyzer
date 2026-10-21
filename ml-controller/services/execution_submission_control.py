"""One-way, durable stop for new Live orders; existing broker lifecycles continue."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Callable, Protocol


class SubmissionControl(Protocol):
    def paused_receipt(self) -> dict[str, Any] | None: ...
    def pause(self, *, request_id: str, reason: str) -> dict[str, Any]: ...


class D1SubmissionControl:
    def __init__(self, *, query: Callable | None = None, execute: Callable | None = None):
        if (query is None) != (execute is None):
            raise ValueError("both_submission_control_transports_required")
        if query is None:
            from services.d1_domain_client import D1DataDomain, DomainD1Client

            client = DomainD1Client(D1DataDomain.EXECUTION, require_specific=True)
            query, execute = client.query, client.execute
        self._query, self._execute = query, execute

    def paused_receipt(self) -> dict[str, Any] | None:
        rows = self._query(
            "SELECT request_id,reason,paused_at FROM live_submission_pause WHERE singleton=1",
            [], 5.0,
        )
        if not rows:
            return None  # Existing Live admission checks still apply; this never enables Live.
        receipt = {**rows[0], "policy": "stop_new_live_orders_preserve_broker_lifecycle_v1"}
        receipt["sha256"] = hashlib.sha256(
            json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return receipt

    def pause(self, *, request_id: str, reason: str) -> dict[str, Any]:
        if not request_id.strip() or not reason.strip():
            raise ValueError("paper_return_request_id_and_reason_required")
        # Irreversible through this API. Replays retain the first persisted receipt.
        self._execute(
            "INSERT INTO live_submission_pause(singleton,request_id,reason,paused_at) "
            "VALUES(1,?,?,?) ON CONFLICT(singleton) DO NOTHING",
            [request_id, reason, datetime.now(timezone.utc).isoformat()], 5.0,
        )
        receipt = self.paused_receipt()
        if receipt is None:
            raise RuntimeError("paper_return_not_persisted")
        return receipt
