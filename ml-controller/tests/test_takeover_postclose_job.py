from datetime import datetime,timezone
from pathlib import Path
import pytest
import postclose_research_job_main as job
from services import premarket_postclose


def test_gcp_job_resolves_taipei_date_and_dispatches_without_worker(monkeypatch):
    calls=[]
    def dispatch(day,**kwargs):
        calls.append((day,kwargs))
        return dict(trade_date=day,status='dispatched',results=[{'status':'dispatched'}])
    monkeypatch.setattr(premarket_postclose,'dispatch_day',dispatch)
    now=datetime(2026,10,20,6,20,tzinfo=timezone.utc)
    result=job.run(jobs_client='local-jobs',storage_client='local-storage',now=now)
    assert result['status']=='dispatched' and calls==[('2026-10-20',dict(
        jobs_client='local-jobs',client='local-storage',now=now))]
    worker=Path(__file__).resolve().parents[2]/'worker/src/lib/cronWorkerDomainTasks.ts'
    assert "runWithLog('postclose-research-dispatch'" not in worker.read_text(encoding='utf8')


@pytest.mark.parametrize('status',['error','reconciliation_required'])
def test_failed_or_ambiguous_job_is_not_reported_successful(monkeypatch,status):
    monkeypatch.setattr(premarket_postclose,'dispatch_day',lambda *a,**k:dict(status=status))
    with pytest.raises(RuntimeError,match='dispatch_not_complete'):
        job.run(trade_date='2026-10-20',jobs_client='local-jobs')


def test_job_requires_explicit_target_and_source_alignment(monkeypatch):
    monkeypatch.delenv('DATASET_SNAPSHOT_JOB_NAME',raising=False)
    monkeypatch.delenv('PIPELINE_DATASET_SNAPSHOT_JOB_NAME',raising=False)
    with pytest.raises(ValueError,match='target_job_missing'):
        job.run(trade_date='2026-10-20')
