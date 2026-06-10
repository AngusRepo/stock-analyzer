from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.finlab_live_submit_service import run_finlab_live_submit  # noqa: E402


def _intent(**overrides: object) -> dict:
    intent = {
        "schemaVersion": "stockvision-order-intent-v1",
        "symbol": "4953",
        "side": "sell",
        "liveSubmitRequested": False,
        "requestedShares": 3209,
        "limitPrice": 142,
        "minPrice": 142,
        "maxPrice": 142,
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


def _ready_env(cert_path: Path) -> dict[str, str]:
    cert_path.write_text("dummy", encoding="utf-8")
    return {
        "FINLAB_LIVE_SUBMIT_ENABLED": "1",
        "SHIOAJI_API_KEY": "api-key",
        "SHIOAJI_SECRET_KEY": "secret-key",
        "SHIOAJI_CERT_PASSWORD": "cert-password",
        "SHIOAJI_CERT_PATH": str(cert_path),
        "SHIOAJI_CERT_PERSON_ID": "A123456789",
    }


def test_live_submit_disabled_blocks_before_account_factory() -> None:
    called = False

    def factory():
        nonlocal called
        called = True
        raise AssertionError("account factory must not be called when disabled")

    result = run_finlab_live_submit(
        intent=_intent(),
        allow_live_submit=True,
        env={"FINLAB_LIVE_SUBMIT_ENABLED": "0"},
        account_factory=factory,
    )

    assert result["status"] == "blocked"
    assert result["reason"] == "finlab_live_submit_disabled"
    assert result["live_submit_enabled"] is False
    assert called is False


def test_live_submit_requires_request_flag(tmp_path: Path) -> None:
    result = run_finlab_live_submit(
        intent=_intent(),
        allow_live_submit=False,
        env=_ready_env(tmp_path / "cert.pfx"),
        account_factory=lambda: object(),
    )

    assert result["status"] == "blocked"
    assert result["reason"] == "allow_live_submit_required"


def test_live_submit_splits_board_and_odd_lot_orders(tmp_path: Path) -> None:
    calls: list[dict] = []

    class FakeAccount:
        def create_order(self, **kwargs):
            calls.append(kwargs)
            return f"order-{len(calls)}"

        def logout(self):
            return None

    result = run_finlab_live_submit(
        intent=_intent(),
        allow_live_submit=True,
        env=_ready_env(tmp_path / "cert.pfx"),
        account_factory=FakeAccount,
    )

    assert result["status"] == "submitted"
    assert result["live_submit_enabled"] is True
    assert [call["quantity"] for call in calls] == [3, 209]
    assert [call["odd_lot"] for call in calls] == [False, True]
    assert all(call["stock_id"] == "4953" for call in calls)
    assert all(call["price"] == 142 for call in calls)
    assert [row["order_id"] for row in result["submitted_orders"]] == ["order-1", "order-2"]
