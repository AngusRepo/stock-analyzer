import pytest
from services.training_dual_cutoff import TrainingCutoff

SESSIONS=['2026-09-21','2026-09-22','2026-09-23','2026-09-24',
          '2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-05']

def test_plan_a_calendar_excludes_mid_autumn_and_teachers_day():
    cutoff=TrainingCutoff.from_calendar(SESSIONS,first_evaluation_signal='2026-10-02')
    assert cutoff == TrainingCutoff('2026-09-22','2026-10-01')
    assert cutoff.admits('2026-09-22','2026-10-01')
    assert not cutoff.admits('2026-09-23','2026-10-01')
    assert not cutoff.admits('2026-09-22','2026-10-02')

def test_receipt_cannot_backdate_training_or_hide_ancestor_leak():
    c=TrainingCutoff('2026-09-22','2026-10-01')
    args=dict(component='p_loss',signals=['2026-09-22'],known_dates=['2026-10-01'],
        feature_vintage={'sha256':'a'*64},ancestor_cutoff='2026-10-01',trained_at='2026-10-19T08:00:00Z')
    assert c.attest(**args)['trained_at']=='2026-10-19T08:00:00Z'
    for change in [dict(ancestor_cutoff='2026-10-02'),dict(trained_at='2026-09-22T08:00:00Z'),dict(feature_vintage=None)]:
        with pytest.raises(ValueError): c.attest(**{**args,**change})
