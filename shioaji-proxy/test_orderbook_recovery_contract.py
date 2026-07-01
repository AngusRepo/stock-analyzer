from pathlib import Path


def test_orderbook_stale_recovery_contract() -> None:
    source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

    assert "def refresh_bidask_subscription" in source
    assert "api.quote.unsubscribe" in source
    assert "def reconnect_shioaji_quote_stream" in source
    assert "_quote_reconnect_lock" in source
    assert "orderbook_reconnect_age_ms" in source
    assert 'SHIOAJI_ORDERBOOK_MAX_AGE_MS", "15000"' in source
    assert "stale_bidasks" in source
    assert "fresh_bidasks" in source
    assert "max_bidask_age_ms" in source
    assert "def build_orderbook_payload" in source
    assert '@app.post("/orderbooks")' in source
    assert source.count("build_orderbook_payload(symbol)") >= 2
    assert "def _clean_symbols" in source
    assert "Subscription Already Exists" not in source
