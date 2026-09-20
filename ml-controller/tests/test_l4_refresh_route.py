from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from routers.l4_distribution import RefreshRequest, refresh_distribution


def test_B_requires_explicit_parent_and_never_promotes(monkeypatch):
    from services import trading_config_loader
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={}))
    with pytest.raises(HTTPException,match='l4_B_requires_explicit_exo_parent'):
        refresh_distribution(RefreshRequest(end_date='2026-09-21',cadence='manual',strategy_role='B'))
    with pytest.raises(HTTPException,match='requires_paired_paper_release'):
        refresh_distribution(RefreshRequest(end_date='2026-09-21',cadence='manual',promote=True))


def test_B_candidate_bootstrap_uses_explicit_role_in_durable_job(monkeypatch):
    from services import trading_config_loader, cloud_run_jobs_client
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={}))
    calls=[]
    class Job:
        def __init__(self,**kwargs):pass
        def run_job(self,**kwargs):
            calls.append(kwargs);return SimpleNamespace(execution_id='test')
    monkeypatch.setattr(cloud_run_jobs_client,'CloudRunJobsClient',Job)
    result=refresh_distribution(RefreshRequest(end_date='2026-09-21',cadence='manual',strategy_role='B',target_l3_artifact_id='frozen-exo-parent'))
    assert result['promoted'] is False
    assert calls==[{'env_overrides':{'L4_REFRESH_DATE':'2026-09-21','L4_REFRESH_CADENCE':'manual','L4_STRATEGY_ROLE':'B','L4_PARENT_ARTIFACT_ID':'frozen-exo-parent'}}]
