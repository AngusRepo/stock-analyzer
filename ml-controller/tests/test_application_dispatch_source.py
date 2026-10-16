from types import SimpleNamespace
import pytest
from services.cloud_run_jobs_client import CloudRunJobsClient

@pytest.mark.parametrize('expected,actual', [('', 'a'*40),('a'*40,'b'*40)])
def test_missing_or_old_source_cannot_allocate_execution(monkeypatch,expected,actual):
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA',expected)
    calls=[]
    client=CloudRunJobsClient(project_id='test',region='test',job_name='screener-v2',require_source_alignment=True)
    client._client=SimpleNamespace(get_job=lambda **kw:SimpleNamespace(template=SimpleNamespace(template=SimpleNamespace(containers=[
        SimpleNamespace(env=[SimpleNamespace(name='STOCKVISION_SOURCE_SHA',value=actual)])]))),
        run_job=lambda **kw:calls.append(kw))
    with pytest.raises(ValueError):client.run_job(reject_if_running=False)
    assert calls==[]

def test_matching_source_uses_existing_dispatch_and_preserves_mode(monkeypatch):
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    client=CloudRunJobsClient(project_id='test',region='test',job_name='optuna-research-sweep',require_source_alignment=True)
    calls=[]
    def run_job(**kw):
        calls.append(kw);return SimpleNamespace(metadata=SimpleNamespace(name='projects/test/jobs/j/executions/one'))
    client._client=SimpleNamespace(get_job=lambda **kw:SimpleNamespace(template=SimpleNamespace(template=SimpleNamespace(containers=[
        SimpleNamespace(env=[SimpleNamespace(name='STOCKVISION_SOURCE_SHA',value='a'*40)])]))),run_job=run_job)
    result=client.run_job({'OPTUNA_JOB_MODE':'weekly_operations'},reject_if_running=False)
    assert result.execution_id=='one'
    assert calls[0]['request'].overrides.container_overrides[0].env[0].value=='weekly_operations'
