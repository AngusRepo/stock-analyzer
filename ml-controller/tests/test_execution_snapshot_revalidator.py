from pathlib import Path
import sys
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.execution_snapshot_revalidator import revalidate_authoritative_snapshots  # noqa: E402


class Response:
    status_code = 200

    def __init__(self, lot_type: str, *, age_ms: int = 100, bid: float = 142.5, ask: float = 143.0) -> None:
        self.lot_type = lot_type
        self.age_ms = age_ms
        self.bid = bid
        self.ask = ask

    def json(self):
        return {
            "status": "ok",
            "data": {
                "4953": {
                    "lot_type": self.lot_type,
                    "quote_age_ms": self.age_ms,
                    "bid_prices": [self.bid],
                    "ask_prices": [self.ask],
                    "bid_volumes": [10],
                    "ask_volumes": [10],
                    "source_time": datetime.now(timezone.utc).isoformat(),
                    "received_at": datetime.now(timezone.utc).isoformat(),
                    "session_epoch": 7,
                }
            },
        }


def _packet(side: str = "sell") -> dict:
    return {
        "intent": {
            "symbol": "4953",
            "side": side,
            "limitPrice": 142 if side == "sell" else 143,
            "requestedShares": 1200,
            "orderLegs": [
                {"lotType": "board_lot", "shares": 1000},
                {"lotType": "odd_lot", "shares": 200},
            ],
        }
    }


def _env() -> dict[str, str]:
    return {
        "SHIOAJI_PROXY_URL": "https://hub.invalid",
        "PROXY_SERVICE_TOKEN": "test-token",
        "LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS": "500",
    }


def test_revalidation_requires_fresh_marketability_for_each_lot() -> None:
    calls: list[str] = []

    def post(url, headers, json, timeout):
        calls.append(json["lot_type"])
        return Response(json["lot_type"])

    result = revalidate_authoritative_snapshots(_packet(), env=_env(), post_fn=post)
    assert result["errors"] == []
    assert calls == ["board_lot", "odd_lot"]


def test_stale_odd_lot_book_blocks_entire_intent() -> None:
    def post(url, headers, json, timeout):
        age = 900 if json["lot_type"] == "odd_lot" else 100
        return Response(json["lot_type"], age_ms=age)

    result = revalidate_authoritative_snapshots(_packet(), env=_env(), post_fn=post)
    assert result["errors"] == ["authoritative_hub_book_stale:odd_lot"]


def test_buy_ask_above_limit_blocks_submit() -> None:
    def post(url, headers, json, timeout):
        return Response(json["lot_type"], bid=143, ask=143.5)

    result = revalidate_authoritative_snapshots(_packet("buy"), env=_env(), post_fn=post)
    assert "authoritative_hub_ask_above_limit:board_lot" in result["errors"]
    assert "authoritative_hub_ask_above_limit:odd_lot" in result["errors"]
