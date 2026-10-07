from routers import regime
from services import hmm_market_inputs

def test_regime_uses_dedicated_source_without_pipeline_serving_context(monkeypatch):
    calls=[]
    def load(day):
        calls.append(day)
        return {"requested_run_date":day,"history":{day:{"risk_score":0}}}
    monkeypatch.setattr(regime,"load_hmm_market_env",load)
    monkeypatch.setattr(regime,"_enrich_market_env_with_finlab_macro_context",lambda env,day:env)
    result=regime._fetch_market_env_via_payload_builder("2026-10-06")
    assert calls==["2026-10-06"] and result["history"]["2026-10-06"]["risk_score"]==0
    assert "hmm_input_checksum" in result

def test_live_default_uses_last_qualified_session_with_current_asof(monkeypatch):
    monkeypatch.setattr(regime,"latest_hmm_input_date",lambda today:"2026-10-06")
    monkeypatch.setattr(regime,"load_hmm_market_env",lambda day:{"requested_run_date":day,"history":{day:{"risk_score":0}}})
    monkeypatch.setattr(regime,"_enrich_market_env_with_finlab_macro_context",lambda env,day:env)
    env=regime._fetch_market_env_via_payload_builder()
    assert env['requested_run_date']=='2026-10-06'
    assert env['inference_as_of']>='2026-10-06T00:00:00'
