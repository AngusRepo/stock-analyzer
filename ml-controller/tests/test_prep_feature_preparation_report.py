"""The inference batch build reports feature_preparation; a run consuming a sealed receipt does not."""
import asyncio
from types import SimpleNamespace

import pytest


class _Stop(Exception):
    pass


@pytest.mark.parametrize('sealed', [False, True])
def test_only_an_unsealed_inference_prep_reports_feature_preparation(monkeypatch, sealed):
    from routers import retrain_trigger as route
    from google.cloud import storage
    from services import capture_inventory, pipeline_progress, training_source_preflight
    monkeypatch.setattr(storage, 'Client', lambda: SimpleNamespace(bucket=lambda _: object()))
    receipt = {'global_capture': 1, 'long_source_capture': 1, 'auxiliary_capture': {'schema_version': 'a'},
               'market_cap_capture': 1, 'price_capture': {'sequence_manifest_checksum': 'c'}}
    monkeypatch.setattr(route, '_verified_prep_only_receipt', lambda *a, **kw: receipt if sealed else None)
    monkeypatch.setattr(training_source_preflight, '_sealed_manifest', lambda *a, **kw: {'manifest_checksum': 'c'})
    events = []

    async def report(phase, **_):
        events.append(phase)

    def inventory(*a, **kw):
        events.append('inventory')
        raise _Stop

    monkeypatch.setattr(pipeline_progress, 'report', report)
    monkeypatch.setattr(capture_inventory, 'inspect_capture_inventory', inventory)
    req = route.UniversalRetrainTriggerRequest(run_date='2026-10-12', prep_only=True, inference_only=True,
        train_model_groups=[], prep_output_gcs_prefix='universal/oof_forward_prep_v2/test', sequence_gcs_prefix='seq')
    result = asyncio.run(route.trigger_universal_retrain(req, request=None))
    if sealed:
        assert result['status'] == 'idempotent_ready' and events == []
    else:
        # Reported before any build work, so the batch card owns the whole build.
        assert events == ['feature_preparation', 'inventory']
        assert result['error'] == 'prep_source_inventory_unreadable'
