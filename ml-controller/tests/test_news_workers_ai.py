import asyncio
import json
import httpx
import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
from services import llm_debate_client as llm, workers_ai_debate_budget as budget
from routers import news

@pytest.mark.parametrize('model',[llm.MISTRAL_MODEL,llm.GPT_OSS_MODEL])
def test_news_reserves_shared_budget_and_records_separate_usage(monkeypatch,model):
    monkeypatch.setenv('CF_ACCOUNT_ID','a'*32)
    monkeypatch.setenv('CF_WORKERS_AI_API_TOKEN','fixture')
    requests,usage,reservations=[],[],[]
    async def reserve(**kwargs):reservations.append(kwargs);return {}
    async def sink(*args):usage.append(args)
    monkeypatch.setattr(budget,'reserve_call',reserve)
    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200,json={'choices':[{'message':{'content':'{"bias":"negative"}'},'finish_reason':'stop'}],
            'usage':{'prompt_tokens':10,'completion_tokens':20}})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await llm.call_llm('rules','raw news',role='news',model=model,max_tokens=2048,client=client,cost_sink=sink)
    text,source=asyncio.run(scenario())
    assert source=='cloudflare_workers_ai:'+model and json.loads(text)['bias']=='negative'
    assert len(reservations)==len(requests)==1
    assert requests[0]['messages'][1]['content']=='raw news'
    assert usage==[('llm_newsanalyst','cloudflare_workers_ai',model,10,20)]


def test_news_budget_denial_never_calls_provider(monkeypatch):
    monkeypatch.setenv('CF_ACCOUNT_ID','a'*32)
    monkeypatch.setenv('CF_WORKERS_AI_API_TOKEN','fixture')
    async def reserve(**kwargs):raise RuntimeError('workers_ai_debate_daily_safe_budget_exhausted')
    monkeypatch.setattr(budget,'reserve_call',reserve)
    def forbidden(request):raise AssertionError('budget denied')
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(forbidden)) as client:
            with pytest.raises(RuntimeError,match='daily_safe_budget_exhausted'):
                await llm.call_llm('s','u',role='news',client=client)
    asyncio.run(scenario())


def test_news_route_auth_bounds_and_safe_failure(monkeypatch):
    import main
    monkeypatch.setattr(main,'_CONTROLLER_TOKEN','fixture-secret')
    app=FastAPI();app.include_router(news.router,dependencies=[Depends(main.verify_token)])
    calls=[]
    async def infer(*args,**kwargs):calls.append(kwargs);return '{}','cloudflare_workers_ai:'+llm.MISTRAL_MODEL
    monkeypatch.setattr(news,'call_llm',infer)
    body={'system_prompt':'rules','user_prompt':'original news'}
    headers={'X-Controller-Token':'fixture-secret'}
    with TestClient(app) as client:
        assert client.post('/news/analyze',json=body).status_code==401
        assert not calls
        assert client.post('/news/analyze',json={**body,'model':'unknown'},headers=headers).status_code==422
        assert client.post('/news/analyze',json={**body,'user_prompt':'x'*48001},headers=headers).status_code==422
        assert client.post('/news/analyze',json=body,headers=headers).status_code==200
        assert calls==[{'temperature':.2,'max_tokens':2048,'role':'news','model':llm.MISTRAL_MODEL}]
        async def fail(*a,**k):raise RuntimeError('workers_ai_debate_daily_safe_budget_exhausted')
        monkeypatch.setattr(news,'call_llm',fail)
        r=client.post('/news/analyze',json=body,headers=headers)
        assert r.status_code==503 and r.json()['detail']=='workers_ai_debate_daily_safe_budget_exhausted'
