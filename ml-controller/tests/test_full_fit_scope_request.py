import pytest
from routers.retrain_trigger import UniversalRetrainTriggerRequest


def test_explicit_full_fit_scope_is_preserved():
    req=UniversalRetrainTriggerRequest(candidate_type='oof_full_fit_release',run_date='2026-10-01',
        signal_date_max='2026-09-22',label_known_at_max='2026-10-01')
    assert req.model_dump()['signal_date_max']=='2026-09-22'


@pytest.mark.parametrize('change',[dict(signal_date_max=None),dict(label_known_at_max=None),
    dict(run_date='2026-10-08'),dict(candidate_type=None),dict(signal_date_max='2026-10-01')])
def test_bad_scope_rejected_before_dispatch(change):
    values=dict(candidate_type='oof_full_fit_release',run_date='2026-10-01',
                signal_date_max='2026-09-22',label_known_at_max='2026-10-01')
    with pytest.raises(ValueError):UniversalRetrainTriggerRequest(**{**values,**change})
