from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.finlab_execution_preview_service import run_finlab_execution_preview  # noqa: E402


def _intent() -> dict:
    return {
        "schemaVersion": "stockvision-order-intent-v1",
        "accountId": 1,
        "tradeDate": "2026-05-28",
        "symbol": "2330",
        "side": "buy",
        "maxBudget": 100000,
        "maxPrice": 100.5,
        "requestedShares": 995,
        "strategyType": "pullback",
        "timeInForce": "ROD",
        "liveSubmitRequested": False,
        "riskContext": {"marketRiskLevel": "low", "confidence": 0.74, "riskPct": 0.01},
        "executionConstraints": {"quoteSource": "shioaji", "quoteAgeMs": 800, "maxEntryChasePct": 0.003},
    }


def test_preview_blocks_broker_login_until_explicitly_allowed() -> None:
    result = run_finlab_execution_preview(intent=_intent(), allow_broker_login=False)

    assert result["status"] == "blocked"
    assert result["can_submit_real_order"] is False
    assert result["visible_reason"] == "broker_login_not_allowed"


def test_preview_rejects_intent_that_requests_live_submit() -> None:
    intent = _intent()
    intent["liveSubmitRequested"] = True

    result = run_finlab_execution_preview(intent=intent, allow_broker_login=True, preview_factory=lambda _: {"status": "pass"})

    assert result["status"] == "blocked"
    assert result["can_submit_real_order"] is False
    assert result["visible_reason"] == "stockvision_intent_requested_live_submit"


def test_preview_uses_injected_preview_without_order_submission() -> None:
    result = run_finlab_execution_preview(
        intent=_intent(),
        allow_broker_login=True,
        preview_factory=lambda intent: {
            "status": "pass",
            "reason": f"preview passed for {intent['symbol']}",
            "estimated_fee": 142,
        },
    )

    assert result["status"] == "pass"
    assert result["can_submit_real_order"] is False
    assert result["visible_reason"] == "preview passed for 2330"
    assert result["audit_event"]["event_type"] == "finlab_execution_preview"
    assert result["audit_event"]["detail"]["previewOnly"] is True
