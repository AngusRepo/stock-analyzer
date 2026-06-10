from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.finlab_execution_preview_service import run_finlab_execution_preview  # noqa: E402


def _intent(**overrides: object) -> dict:
    intent = {
        "schemaVersion": "stockvision-order-intent-v1",
        "symbol": "4953",
        "side": "buy",
        "liveSubmitRequested": False,
        "requestedShares": 3209,
        "maxPrice": 141.5,
        "orderLegs": [
            {
                "lotType": "board_lot",
                "shares": 3000,
                "finlabQuantity": 3,
                "finlabQuantityUnit": "lots",
                "oddLot": False,
                "orderLot": "common",
            },
            {
                "lotType": "odd_lot",
                "shares": 209,
                "finlabQuantity": 209,
                "finlabQuantityUnit": "shares",
                "oddLot": True,
                "orderLot": "intraday_odd",
            },
        ],
    }
    intent.update(overrides)
    return intent


def test_preview_blocks_illegal_tw_tick_price() -> None:
    result = run_finlab_execution_preview(intent=_intent(maxPrice=141.6), allow_broker_login=False)

    assert result["status"] == "blocked"
    assert "stockvision_intent_invalid_tw_tick_price" in result["blocked_reasons"]


def test_preview_blocks_missing_order_legs() -> None:
    intent = _intent()
    intent.pop("orderLegs")

    result = run_finlab_execution_preview(intent=intent, allow_broker_login=False)

    assert result["status"] == "blocked"
    assert "stockvision_intent_missing_order_legs" in result["blocked_reasons"]


def test_preview_accepts_tick_and_leg_contract_before_broker_login_guard() -> None:
    result = run_finlab_execution_preview(intent=_intent(), allow_broker_login=False)

    assert result["status"] == "blocked"
    assert "broker_login_not_allowed" in result["blocked_reasons"]


def test_preview_accepts_sell_intent_tick_and_leg_contract_before_broker_login_guard() -> None:
    result = run_finlab_execution_preview(
        intent=_intent(side="sell", minPrice=142, limitPrice=142, maxPrice=142),
        allow_broker_login=False,
    )

    assert result["status"] == "blocked"
    assert "broker_login_not_allowed" in result["blocked_reasons"]


def test_preview_blocks_sell_intent_illegal_tw_tick_price() -> None:
    result = run_finlab_execution_preview(
        intent=_intent(side="sell", minPrice=141.6, limitPrice=141.6, maxPrice=141.6),
        allow_broker_login=False,
    )

    assert result["status"] == "blocked"
    assert "stockvision_intent_invalid_tw_tick_price" in result["blocked_reasons"]
