from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.broker_execution_contract import effective_order_value_cap, reduce_leg_state  # noqa: E402


def test_sparse_authorized_order_uses_allocator_and_nav_cap_not_manual_fat_finger_cap() -> None:
    intent = {
        "riskContext": {
            "sizingAuthorization": {
                "owner": "sparse_allocator",
                "authorizedValue": 400_000,
                "portfolioValue": 2_000_000,
            },
        },
    }
    risk = {
        "order": {"maxSingleOrderValue": 300_000},
        "position": {"maxSingleNamePct": 0.25},
    }
    assert effective_order_value_cap(intent, risk) == 400_000

    intent["riskContext"]["sizingAuthorization"]["portfolioValue"] = 1_000_000
    assert effective_order_value_cap(intent, risk) == 250_000


def test_manual_order_keeps_absolute_fat_finger_cap() -> None:
    risk = {
        "order": {"maxSingleOrderValue": 300_000},
        "position": {"maxSingleNamePct": 0.25},
    }
    assert effective_order_value_cap({"riskContext": {}}, risk) == 300_000


def test_deal_before_order_callback_keeps_partial_fill() -> None:
    after_deal = reduce_leg_state(
        "SUBMITTING",
        "DEAL_CALLBACK",
        filled_shares=200,
        requested=1000,
    )
    assert after_deal == "PARTIALLY_FILLED"
    after_order = reduce_leg_state(after_deal, "ORDER_CALLBACK", callback_success=True)
    assert after_order == "PARTIALLY_FILLED"


def test_late_submit_unknown_cannot_downgrade_acknowledged_order() -> None:
    assert reduce_leg_state("ACKNOWLEDGED", "SUBMIT_UNKNOWN") == "ACKNOWLEDGED"


def test_full_fill_is_terminal_against_late_order_callback() -> None:
    filled = reduce_leg_state("UNKNOWN", "STATUS_RECONCILIATION", filled_shares=1000, requested=1000)
    assert filled == "FILLED"
    assert reduce_leg_state(filled, "ORDER_CALLBACK", callback_success=True) == "FILLED"
