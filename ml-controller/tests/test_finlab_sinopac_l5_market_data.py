from datetime import datetime, timezone
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.finlab_sinopac_l5_market_data import (
    normalize_l5_quote,
    run_finlab_l5_market_data,
)


def test_normalize_l5_quote_preserves_depth_and_quality_metrics() -> None:
    quote = normalize_l5_quote(
        "2330",
        {
            "provider": "finlab_sinopac",
            "price": 100,
            "bid_prices": [99.9, 99.8, 99.7, 99.6, 99.5],
            "ask_prices": [100.1, 100.2, 100.3, 100.4, 100.5],
            "bid_volumes": [12, 10, 8, 6, 4],
            "ask_volumes": [8, 7, 6, 5, 4],
            "source_time": "2026-05-28T01:00:09Z",
        },
        now=datetime(2026, 5, 28, 1, 0, 10, tzinfo=timezone.utc),
    )

    assert quote["symbol"] == "2330"
    assert quote["best_bid"] == 99.9
    assert quote["best_ask"] == 100.1
    assert quote["spread_pct"] == 0.002
    assert quote["l5_depth_levels"] == 5
    assert quote["quote_age_ms"] == 1000
    assert quote["order_book_imbalance"] > 0
    assert quote["live_submit_enabled"] is False


def test_l5_market_data_blocks_broker_login_unless_explicitly_allowed() -> None:
    result = run_finlab_l5_market_data(
        symbols=["2330"],
        allow_broker_login=False,
        env={
            "SHIOAJI_API_KEY": "key",
            "SHIOAJI_SECRET_KEY": "secret",
            "SHIOAJI_CERT_PASSWORD": "pass",
            "SHIOAJI_CERT_PATH": __file__,
            "SHIOAJI_CERT_PERSON_ID": "A123456789",
        },
    )

    assert result["status"] == "blocked"
    assert result["can_submit_real_order"] is False
    assert result["blocked_reasons"] == ["broker_login_not_allowed"]


def test_l5_market_data_uses_injected_account_without_order_methods() -> None:
    class FakeAccount:
        def __init__(self) -> None:
            self.logged_out = False

        def get_l5_quotes(self, symbols: list[str]) -> dict:
            return {
                "2330": {
                    "price": 100,
                    "bid_prices": [99.9, 99.8, 99.7, 99.6, 99.5],
                    "ask_prices": [100.1, 100.2, 100.3, 100.4, 100.5],
                    "bid_volumes": [12, 10, 8, 6, 4],
                    "ask_volumes": [8, 7, 6, 5, 4],
                }
            }

        def logout(self) -> None:
            self.logged_out = True

    result = run_finlab_l5_market_data(
        symbols=["2330"],
        allow_broker_login=True,
        env={
            "SHIOAJI_API_KEY": "key",
            "SHIOAJI_SECRET_KEY": "secret",
            "SHIOAJI_CERT_PASSWORD": "pass",
            "SHIOAJI_CERT_PATH": __file__,
            "SHIOAJI_CERT_PERSON_ID": "A123456789",
        },
        account_factory=FakeAccount,
        now=datetime(2026, 5, 28, 1, 0, 10, tzinfo=timezone.utc),
    )

    assert result["status"] == "pass"
    assert result["can_submit_real_order"] is False
    assert result["live_submit_enabled"] is False
    assert result["quotes"]["2330"]["l5_depth_levels"] == 5


def test_l5_market_data_route_exposes_production_like_market_data_contract() -> None:
    source = (ROOT / "routers" / "finlab.py").read_text(encoding="utf-8")

    assert '@router.post("/execution/l5-market-data")' in source
    assert "run_finlab_l5_market_data" in source
    assert 'payload["production_like_market_data"] = True' in source
    assert 'payload["live_submit_enabled"] = False' in source
    assert 'payload["can_submit_real_order"] = False' in source
