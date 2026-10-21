import pytest
import l4_shadow_job_main as job
from services import l4_shadow_sources


@pytest.mark.parametrize('status,accounts',[
    ('awaiting_registry',[]),('ok',[{'status':'awaiting_daily_inputs'}]),
    ('failed',[{'status':'failed'}]),('ok',[]),
])
def test_job_does_not_turn_missing_registry_inputs_or_frames_green(monkeypatch,status,accounts):
    monkeypatch.setattr(l4_shadow_sources,'run_tick',lambda **kw:dict(status=status,accounts=accounts))
    with pytest.raises(RuntimeError,match='shadow_tick_incomplete'):
        job.run(operation='tick',session_date='2026-10-20')


def test_job_preserves_native_tick_result(monkeypatch):
    result=dict(status='ok',accounts=[{'status':'collecting'}],production_effect=False,outer_acceptance_credit=0)
    monkeypatch.setattr(l4_shadow_sources,'run_tick',lambda **kw:result)
    assert job.run(operation='tick',session_date='2026-10-20') is result
