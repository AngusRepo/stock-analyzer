"""R17: durable Live submission control (Wei D-7 / D-8).

Append-only, hash-chained rows in execution D1 ``live_submission_control_v1``:
- pause: one click, no approval. Stops every new Live order, buy and sell.
  Submitted broker orders keep reconciling; positions are left to Wei.
- resume: a separate command. It must carry Wei's approval scope, the approval
  expiry and the R4-gate receipt sha, each equal to the value deployed with
  Wei's go (env/Secret), and the approval must not have expired.
Live is open only while the newest row is a still-valid resume. An empty,
broken or unreadable chain, or any env/approval drift, reads as paused.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Mapping


GENESIS_SHA256 = "0" * 64
POLICY = "stop_new_live_orders_preserve_broker_lifecycle_v1"
COLUMNS = (
    "sequence", "action", "request_id", "actor", "reason", "approval_scope",
    "approval_expires_at", "gate_receipt_sha256", "created_at", "previous_sha256",
)
# Public receipt fields: the chain position, never the approval values.
RECEIPT_FIELDS = ("sequence", "action", "request_id", "actor", "created_at", "previous_sha256")
PAUSED = "live_submission_paused"
OPEN = "live_submission_open"
_SHA256 = re.compile(r"[0-9a-f]{64}")


class SubmissionControlConflict(ValueError):
    """The command is not valid for the current control state or approval."""


def row_sha256(row: Mapping[str, Any]) -> str:
    body = {key: row.get(key) for key in COLUMNS}
    return hashlib.sha256(
        json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _text(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if not text or len(text) > limit:
        raise SubmissionControlConflict("live_submission_control_field_invalid")
    return text


class D1SubmissionControl:
    def __init__(
        self,
        *,
        query: Callable | None = None,
        execute: Callable | None = None,
        env: Mapping[str, str] | None = None,
        now: Callable[[], datetime] | None = None,
    ):
        if (query is None) != (execute is None):
            raise ValueError("both_submission_control_transports_required")
        if query is None:
            from services.d1_domain_client import D1DataDomain, DomainD1Client

            client = DomainD1Client(D1DataDomain.EXECUTION, require_specific=True)
            query, execute = client.query, client.execute
        if env is None:
            import os

            env = os.environ
        self._query, self._execute, self._env = query, execute, env
        self._now = now or (lambda: datetime.now(timezone.utc))

    # ---- reads -------------------------------------------------------------
    def _chain(self) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self._query(
            "SELECT sequence,action,request_id,actor,reason,approval_scope,approval_expires_at,"
            "gate_receipt_sha256,created_at,previous_sha256,row_sha256 "
            "FROM live_submission_control_v1 ORDER BY sequence", [], 5.0)]
        if not rows:
            raise RuntimeError("live_submission_control_empty")
        previous = GENESIS_SHA256
        for index, row in enumerate(rows, start=1):
            if (int(row["sequence"]) != index or row["previous_sha256"] != previous
                    or row["row_sha256"] != row_sha256(row)):
                raise RuntimeError("live_submission_control_chain_invalid")
            previous = row["row_sha256"]
        if rows[0]["action"] != "pause":
            raise RuntimeError("live_submission_control_seed_invalid")
        return rows

    def _approval(self) -> dict[str, str]:
        return {
            "approval_scope": str(self._env.get("LIVE_TRADING_APPROVAL_SCOPE") or "").strip(),
            "approval_expires_at": str(self._env.get("LIVE_TRADING_APPROVAL_EXPIRES_AT") or "").strip(),
            "gate_receipt_sha256": str(self._env.get("LIVE_GATE_RECEIPT_SHA256") or "").strip().lower(),
        }

    def _resume_invalid_reason(self, row: Mapping[str, Any]) -> str | None:
        """None when the resume row still authorizes Live; otherwise why it does not."""
        approval = self._approval()
        if not all(approval.values()):
            return "live_approval_env_missing"
        if not _SHA256.fullmatch(approval["gate_receipt_sha256"]):
            return "live_approval_env_invalid"
        if any(row.get(key) != value for key, value in approval.items()):
            return "live_approval_changed_since_resume"
        expires = _parse_time(row.get("approval_expires_at"))
        if expires is None or self._now() >= expires:
            return "live_approval_expired"
        return None

    def state(self) -> dict[str, Any]:
        """Fail-closed readback; never raises."""
        try:
            rows = self._chain()
        except Exception as exc:
            text = str(exc)
            reason = text if text.startswith("live_submission_control_") else "live_submission_control_unavailable"
            return {"status": PAUSED, "reason": reason, "receipt": None, "durable_pause": False, "policy": POLICY}
        latest = rows[-1]
        receipt = self._receipt(latest)
        if latest["action"] == "pause":
            return {"status": PAUSED, "reason": "paused", "receipt": receipt, "durable_pause": True, "policy": POLICY}
        # A resume that no longer authorizes Live reads as paused, but it is not a
        # durable pause: restoring the env would reopen Live, so the UI keeps the
        # one-click pause available until a pause row is written.
        invalid = self._resume_invalid_reason(latest)
        if invalid:
            return {"status": PAUSED, "reason": invalid, "receipt": receipt, "durable_pause": False, "policy": POLICY}
        return {"status": OPEN, "reason": None, "receipt": receipt, "durable_pause": False, "policy": POLICY}

    def closed_reason(self) -> str | None:
        """None only when new Live orders may be submitted."""
        state = self.state()
        return None if state["status"] == OPEN else f"live_submission_paused:{state['reason']}"

    # ---- writes ------------------------------------------------------------
    def _append(self, rows: list[dict[str, Any]], fields: dict[str, Any]) -> None:
        row = {
            "sequence": len(rows) + 1,
            "previous_sha256": rows[-1]["row_sha256"],
            "created_at": self._now().astimezone(timezone.utc).isoformat(),
            "approval_scope": None, "approval_expires_at": None, "gate_receipt_sha256": None,
            **fields,
        }
        row["row_sha256"] = row_sha256(row)
        self._execute(
            "INSERT INTO live_submission_control_v1 (sequence,action,request_id,actor,reason,approval_scope,"
            "approval_expires_at,gate_receipt_sha256,created_at,previous_sha256,row_sha256) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [row[key] for key in (*COLUMNS, "row_sha256")], 5.0,
        )

    @staticmethod
    def _replay(rows: list[dict[str, Any]], request_id: str, action: str) -> dict[str, Any] | None:
        for row in rows:
            if row["request_id"] == request_id:
                if row["action"] != action:
                    raise SubmissionControlConflict("live_submission_request_id_reused")
                if row is not rows[-1] and any(later["action"] != action for later in rows[row["sequence"]:]):
                    # A later command reversed this one; replaying it must not
                    # report a state the chain no longer holds.
                    raise SubmissionControlConflict("live_submission_request_superseded")
                return row
        return None

    @staticmethod
    def _receipt(row: Mapping[str, Any]) -> dict[str, Any]:
        """The chain position only: approval scope, expiry and gate receipt values never leave."""
        return {**{key: row.get(key) for key in RECEIPT_FIELDS}, "sha256": row["row_sha256"]}

    def pause(self, *, request_id: str, actor: str, reason: str) -> dict[str, Any]:
        request_id, actor, reason = _text(request_id, 128), _text(actor, 160), _text(reason, 500)
        for _ in range(2):
            rows = self._chain()
            row = self._replay(rows, request_id, "pause")
            if row is None and rows[-1]["action"] == "pause":
                row = rows[-1]  # Already paused: keep one receipt, add no row.
            if row is None:
                try:
                    self._append(rows, {"action": "pause", "request_id": request_id,
                                        "actor": actor, "reason": reason})
                except Exception:
                    continue  # A concurrent write moved the chain; re-read and retry once.
                row = self._replay(self._chain(), request_id, "pause")
            if row is not None:
                return {"status": PAUSED, "receipt": self._receipt(row), "policy": POLICY,
                        "existing_orders_and_positions": "preserved", "reconciliation": "continues"}
        raise RuntimeError("paper_return_not_persisted")

    def resume(self, *, request_id: str, actor: str, reason: str, approval_scope: str,
               approval_expires_at: str, gate_receipt_sha256: str) -> dict[str, Any]:
        request_id, actor, reason = _text(request_id, 128), _text(actor, 160), _text(reason, 500)
        requested = {
            "approval_scope": str(approval_scope or "").strip(),
            "approval_expires_at": str(approval_expires_at or "").strip(),
            "gate_receipt_sha256": str(gate_receipt_sha256 or "").strip().lower(),
        }
        if not _SHA256.fullmatch(requested["gate_receipt_sha256"]):
            raise SubmissionControlConflict("live_resume_gate_receipt_invalid")
        approval = self._approval()
        if not all(approval.values()):
            raise SubmissionControlConflict("live_approval_env_missing")
        if not _SHA256.fullmatch(approval["gate_receipt_sha256"]):
            raise SubmissionControlConflict("live_approval_env_invalid")
        if requested != approval:
            raise SubmissionControlConflict("live_resume_approval_mismatch")
        expires = _parse_time(requested["approval_expires_at"])
        if expires is None or self._now() >= expires:
            raise SubmissionControlConflict("live_approval_expired")
        rows = self._chain()
        row = self._replay(rows, request_id, "resume")
        if row is None:
            if rows[-1]["action"] != "pause":
                raise SubmissionControlConflict("live_submission_not_paused")
            self._append(rows, {"action": "resume", "request_id": request_id, "actor": actor,
                                "reason": reason, **requested})
            row = self._replay(self._chain(), request_id, "resume")
            if row is None:
                raise RuntimeError("live_resume_not_persisted")
        return {**self.state(), "resume_receipt": self._receipt(row)}
