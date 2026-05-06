import asyncio

from routers import sector_flow


def test_twse_chips_proxy_returns_worker_bulk_contract(monkeypatch):
    async def fake_chips(_client, date):
        assert date == "2026-04-30"
        return [{
            "symbol": "2330",
            "foreign_buy": 100,
            "foreign_sell": 40,
            "foreign_net": 60,
            "trust_buy": 10,
            "trust_sell": 3,
            "trust_net": 7,
            "dealer_buy": 5,
            "dealer_sell": 2,
            "dealer_net": 3,
        }]

    async def fake_margin(_client, date):
        assert date == "2026-04-30"
        return [{
            "symbol": "2330",
            "margin_buy": 8,
            "margin_sell": 4,
            "margin_balance": 1000,
            "short_buy": 2,
            "short_sell": 1,
            "short_balance": 50,
        }]

    monkeypatch.setattr(sector_flow, "fetch_twse_chips", fake_chips)
    monkeypatch.setattr(sector_flow, "fetch_twse_margin", fake_margin)

    result = asyncio.run(sector_flow.proxy_twse_chips(sector_flow.TpexProxyRequest(date="2026-04-30")))

    assert result["date"] == "2026-04-30"
    assert result["chips"][0]["symbol"] == "2330"
    assert result["chips"][0]["foreign_net"] == 60
    assert result["margins"][0]["margin_balance"] == 1000
