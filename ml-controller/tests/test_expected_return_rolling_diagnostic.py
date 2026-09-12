from copy import deepcopy
from datetime import date, timedelta

import pytest

from services.expected_return_rolling_diagnostic import build_rolling_diagnostics
from services.l4_alpha_ev_artifact_builder import build_l4_alpha_ev_artifact_from_rows
from test_l4_alpha_ev_artifact_builder import _row


def test_real_extended_validation_changes_but_base_candidate_does_not():
    rows = []
    for d in range(30):
        day = (date(2026, 7, 20) + timedelta(days=d)).isoformat()
        for i in range(40):
            row = _row(day, i, target=(i / 1000 if d < 24 else -i / 1000))
            row.update(snapshot_date=day, generation_mode='purged_oof', cohort_id='test')
            rows.append(row)
    before = deepcopy(rows)
    kwargs = dict(trained_until=rows[959]['snapshot_date'], generation_mode='purged_oof', cohort_id='test', artifact_generated_at='2026-09-08T00:00:00+00:00')
    base = build_l4_alpha_ev_artifact_from_rows(rows[:960], **kwargs)
    results = build_rolling_diagnostics(snapshot_rows=rows, l4_predictions=[], cohort_id='test',
        knowledge_cutoff_date='2026-09-08', extension_dates=sorted({r['snapshot_date'] for r in rows[960:]}),
        build_fusion_rows=lambda *args, **kw: [], query_fn=lambda *args: [])
    assert rows == before
    assert build_l4_alpha_ev_artifact_from_rows(rows[:960], **kwargs) == base
    rolling = results['l4_alpha_ev']['validation_packet']
    assert rolling['sample_audit']['date_count'] == 30
    assert base['validation_packet']['sample_audit']['date_count'] == 24
    assert rolling['oos_metrics']['date_mean_top_bottom_spread_lcb90'] != base['validation_packet']['oos_metrics']['date_mean_top_bottom_spread_lcb90']
    assert rolling['diagnostic_population']['evaluated_dates'][-1] == rows[-1]['snapshot_date']
    assert all(r['artifact']['promotion_state'] == 'shadow_only' for r in results.values())


def test_missing_extension_cannot_be_relabelled_as_daily():
    with pytest.raises(ValueError, match='forward_population_missing'):
        build_rolling_diagnostics(snapshot_rows=[{'snapshot_date': '2026-08-18'}], l4_predictions=[],
            cohort_id='test', knowledge_cutoff_date='2026-09-08', extension_dates=['2026-08-31'],
            build_fusion_rows=lambda *a, **kw: [], query_fn=lambda *a: [])


@pytest.mark.parametrize('defect', ['base_only', 'wrong_metric_dates'])
def test_archive_rejects_old_base_validation_before_any_write(defect):
    from services.active8_oof_cohort_materializer import archive_ev_shadow_evaluation_packets
    extension = {'manifest_checksum': 'b' * 64, 'base_cohort_id': 'test',
        'base_manifest_checksum': 'a' * 64, 'dates': ['2026-08-31'],
        'promotion_eligible': False, 'training_dispatched': False}
    packet = {'sample_audit': {'evidence_max_date': '2026-08-18'},
        'oos_metrics': {'evaluated_dates': ['2026-08-18']}}
    if defect == 'wrong_metric_dates':
        packet['diagnostic_population'] = {'schema_version': 'expected-return-rolling-population-v1',
            'promotion_eligible': False, 'extension_dates': extension['dates'],
            'available_dates': extension['dates'], 'usable_max_date': '2026-08-18',
            'evaluated_dates': extension['dates']}
    class NoWrites:
        def blob(self, path):
            pytest.fail('invalid population reached object storage')
    with pytest.raises(ValueError, match='shadow_population_'):
        archive_ev_shadow_evaluation_packets(bucket=NoWrites(), cohort_id='test', business_date='2026-09-08',
            base_manifest_checksum='a' * 64, extension_manifest=extension,
            l4_result={'artifact': {}, 'validation_packet': packet}, fusion_result={},
            forward_row_count=100, execute_fn=lambda *a: pytest.fail('invalid population reached D1'))
