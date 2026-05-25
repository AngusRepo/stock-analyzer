from datetime import datetime, timedelta, timezone

import main


TW_TZ = timezone(timedelta(hours=8))


def test_streaming_quote_merges_tick_and_bidask_cache():
    now = datetime(2026, 5, 25, 9, 5, 1, tzinfo=TW_TZ).isoformat()
    main.last_ticks.clear()
    main.last_bidasks.clear()
    main.last_ticks["2330"] = {
        "symbol": "2330",
        "price": 581.0,
        "open": 579.0,
        "high": 582.0,
        "low": 578.0,
        "volume": 2,
        "total_volume": 100,
        "bid": 580.5,
        "ask": 581.0,
        "timestamp": "2026-05-25T09:05:00+08:00",
        "updated_at": now,
    }
    main.last_bidasks["2330"] = {
        "symbol": "2330",
        "bid_prices": [580.0, 579.5, 579.0, 578.5, 578.0],
        "bid_volumes": [100, 90, 80, 70, 60],
        "ask_prices": [581.0, 581.5, 582.0, 582.5, 583.0],
        "ask_volumes": [120, 130, 140, 150, 160],
        "price": 580.5,
        "timestamp": "2026-05-25T09:05:01+08:00",
        "updated_at": now,
    }

    quote = main.get_streaming_quote("2330")

    assert quote is not None
    assert quote["source"] == "streaming_cache"
    assert quote["last"] == 581.0
    assert quote["bid"] == 580.0
    assert quote["ask"] == 581.0
    assert quote["bid_prices"][:2] == [580.0, 579.5]
    assert quote["ask_volumes"][0] == 120
    assert quote["updated_at"] == now
