from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_execution_adapter import (  # noqa: E402
    build_finlab_execution_preview_policy,
    normalize_finlab_execution_preview,
    validate_finlab_execution_preview_contract,
)


def test_finlab_execution_policy_is_preview_first_and_never_live_submit():
    policy = build_finlab_execution_preview_policy()

    assert policy["schema_version"] == "finlab-execution-preview-v1"
    assert policy["mode"] == "preview_first"
    assert policy["allowed_statuses"] == ["pass", "blocked", "warning", "error"]
    assert policy["live_submit_enabled"] is False
    assert policy["requires_explicit_real_order_approval"] is True
    assert policy["adapter_surfaces"] == [
        "OrderExecutor.preview",
        "PortfolioSyncManager.preview",
    ]


def test_blocked_preview_keeps_reason_visible_and_blocks_submit():
    preview = normalize_finlab_execution_preview(
        {
            "status": "blocked",
            "reason": "T+2 settlement cash insufficient",
            "detail": {"cash_shortfall": 120000},
        },
        symbol="2330",
        side="buy",
    )

    payload = preview.to_dict()
    assert payload["status"] == "blocked"
    assert payload["submit_decision"] == "do_not_submit"
    assert payload["can_submit_real_order"] is False
    assert payload["visible_reason"] == "T+2 settlement cash insufficient"
    assert payload["blocked_reasons"] == ["T+2 settlement cash insufficient"]
    assert payload["audit_event"]["status"] == "blocked"
    assert payload["audit_event"]["detail"]["previewOnly"] is True
    assert payload["audit_event"]["detail"]["cash_shortfall"] == 120000


def test_pass_preview_still_waits_for_stockvision_handoff():
    preview = normalize_finlab_execution_preview(
        {
            "status": "pass",
            "reason": "broker preview passed",
            "estimated_fee": 142,
        },
        symbol="2454",
        side="buy",
    )

    payload = preview.to_dict()
    assert payload["status"] == "pass"
    assert payload["submit_decision"] == "manual_or_separate_confirm_required"
    assert payload["can_submit_real_order"] is False
    assert payload["visible_reason"] == "broker preview passed"
    assert payload["audit_event"]["status"] == "pass"


def test_unknown_preview_status_fails_closed():
    preview = normalize_finlab_execution_preview(
        {
            "ok": None,
            "message": "unexpected response shape",
        },
        symbol="3034",
        side="sell",
    )

    payload = preview.to_dict()
    assert payload["status"] == "error"
    assert payload["submit_decision"] == "do_not_submit"
    assert payload["can_submit_real_order"] is False
    assert payload["visible_reason"] == "finlab_preview_status_unknown"
    assert payload["blocked_reasons"] == ["finlab_preview_status_unknown"]


def test_submit_attempts_are_contract_violations():
    errors = validate_finlab_execution_preview_contract(
        {
            "status": "pass",
            "submitted": True,
            "order_id": "finlab-live-order-1",
        }
    )

    assert errors == [
        "finlab_execution_preview_must_not_submit_live_order",
        "finlab_execution_preview_must_not_return_live_order_id",
    ]
