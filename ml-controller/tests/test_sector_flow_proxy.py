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


def test_tpex_retries_incomplete_body_and_returns_actual_prices(monkeypatch):
    import httpx
    calls=[]
    class Client:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def get(self,url,**kwargs):
            calls.append(url)
            if len(calls)==1:raise httpx.RemoteProtocolError('incomplete chunked read')
            return httpx.Response(200,request=httpx.Request('GET',url),json={
                'date':'20261002','tables':[{'data':[['6217','stock','100','+1','99','101','98','99.5','1000']]}]})
    async def no_sleep(_):pass
    monkeypatch.setattr(sector_flow.httpx,'AsyncClient',Client)
    monkeypatch.setattr(sector_flow.asyncio,'sleep',no_sleep)
    result=asyncio.run(sector_flow.proxy_tpex_prices(sector_flow.TpexProxyRequest(date='2026-10-02')))
    assert len(calls)==2 and result['prices'][0]['symbol']=='6217'
    assert result['report_date']=='20261002'


def test_tpex_persistent_failure_is_bounded_and_returns_unavailable(monkeypatch):
    import httpx,pytest
    calls=[]
    class Client:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def get(self,url,**kwargs):
            calls.append(url);raise httpx.RemoteProtocolError('incomplete chunked read')
    async def no_sleep(_):pass
    monkeypatch.setattr(sector_flow.httpx,'AsyncClient',Client)
    monkeypatch.setattr(sector_flow.asyncio,'sleep',no_sleep)
    with pytest.raises(sector_flow.HTTPException) as caught:
        asyncio.run(sector_flow.proxy_tpex_prices(sector_flow.TpexProxyRequest(date='2026-10-02')))
    assert caught.value.status_code==503 and len(calls)==3
