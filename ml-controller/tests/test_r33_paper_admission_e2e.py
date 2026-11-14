"""A2 x A1: the real R33 paper admission (not a stub) through restore -> attach -> execution receipt -> D1 readback."""
from services import active8_nav_execution as execution
from services import recommendation_service as writer
from services.active8_nav_inference import SCHEMA, restore_frozen_nav_inference
from services.ensemble_v2 import attach_ensemble_v2, ensemble_artifact_id
from services.paired_nav_journal import digest
from test_r33_l4_equal7 import DAY
from test_r33_paper_mode import _admission
from test_r33_paper_nav_receipt import d1  # noqa: F401  (fixture)
from test_r33_serving_chain import COST, POOL_MODELS, _chain


def _receipt(admission, ensemble):
    return {'schema_version': 'active8-ensemble-atomic-promotion-evidence-v1', 'paper_admission': admission,
            'ensemble_artifact_id': ensemble_artifact_id(ensemble), 'ensemble_payload_checksum': ensemble['payload_checksum'],
            'base_artifact_set_checksum': ensemble['base_artifact_set_checksum'],
            'selected_models': sorted(ensemble['selected_models']), 'validation': ensemble['validation'],
            'evaluation_business_date': admission['business_date']}


def _context(receipt, ensemble):
    body = {'schema_version': SCHEMA, 'scope': 'frozen_compute_only', 'captured_at': '2026-11-10T12:00:00Z',
            'artifact_checksum': ensemble['payload_checksum'], 'publication_receipt': receipt, 'review_records': []}
    return {**body, 'context_checksum': digest(body)}


def test_real_r33_admission_closes_the_paper_receipt_chain(monkeypatch, d1):  # noqa: F811
    admission, ensemble = _admission(monkeypatch)
    # execution_artifacts validates the receipt with the wall clock; pin it after the fixture's approval.
    import services.active8_paper_admission as paper_admission

    class _Clock(paper_admission.datetime):
        @classmethod
        def now(cls, tz=None):
            return paper_admission.datetime(2026, 11, 10, 12, tzinfo=paper_admission.timezone.utc).astimezone(tz)

    monkeypatch.setattr(paper_admission, 'datetime', _Clock)
    context = _context(_receipt(admission, ensemble), ensemble)
    grant = restore_frozen_nav_inference(context, artifact=ensemble, pool_models=POOL_MODELS)
    predictions, _snapshot = _chain(stale={'P6': 'last_bar=2026-11-07'})
    for prediction in predictions.values():
        prediction['feature_version'] = 'r33-fixture'
        attach_ensemble_v2(prediction, ensemble, POOL_MODELS, round_trip_cost=COST, nav_authority=grant)
    receipt = execution.attach_execution_receipt(predictions=predictions, manifest={
        'active8_ensemble': ensemble, 'active8_nav_inference': context}, pool_models=POOL_MODELS,
        run_id='r33-paper-run', run_date=DAY)
    observations = []
    stock_ids = {s: i + 1 for i, s in enumerate(sorted(predictions))}
    writer.write_predictions_to_d1(predictions, stock_ids, DAY, execution_sink=observations.append)
    _conn, query = d1
    assert observations[0]['readback_verified'] is True
    assert execution.read_execution(query=query, receipt=receipt) == observations[0]


def test_a_tampered_r33_admission_does_not_restore(monkeypatch):
    import pytest
    admission, ensemble = _admission(monkeypatch)
    tampered = {**admission, 'business_date': '2026-11-09'}
    with pytest.raises(ValueError):
        restore_frozen_nav_inference(_context(_receipt(tampered, ensemble), ensemble), artifact=ensemble,
                                     pool_models=POOL_MODELS)
