"""FG-15: /retrain/universal rejections carry reason codes, never exception text (CodeQL py/stack-trace-exposure)."""
import asyncio
import json
import logging
from types import SimpleNamespace

import pytest

SECRET = 'gs://private-bucket/universal/x token=abc'


def _route(monkeypatch):
    from routers import retrain_trigger as route
    from google.cloud import storage
    monkeypatch.setattr(storage, 'Client', lambda: SimpleNamespace(bucket=lambda _: object()))
    return route


def _run(route, caplog, **change):
    req = route.UniversalRetrainTriggerRequest(**{'run_date': '2026-10-12', 'prep_only': True, 'train_model_groups': [],
        'prep_output_gcs_prefix': 'universal/oof_forward_prep_v2/test', 'sequence_gcs_prefix': 'seq', **change})
    with caplog.at_level(logging.WARNING, logger=route.logger.name):
        result = asyncio.run(route.trigger_universal_retrain(req, request=None))
    assert 'detail' not in result and SECRET not in json.dumps(result)
    assert SECRET in caplog.text and result.get('run_id', '') in caplog.text
    return result


def _raise(exc):
    def raise_(*a, **kw):
        raise exc
    return raise_


@pytest.mark.parametrize('exc,code', [
    (ValueError(f'prep_only_sealed_checksum_mismatch:{SECRET}'), 'prep_only_sealed_checksum_mismatch'),
    (ValueError(f'prep_only_sealed_receipt_invalid_but_longer {SECRET}'), 'prep_only_sealed_receipt_unreadable'),
    (json.JSONDecodeError(SECRET, 'x', 0), 'prep_only_sealed_receipt_unreadable'),
])
def test_receipt_rejection_keeps_a_listed_code_and_logs_the_text(monkeypatch, caplog, exc, code):
    route = _route(monkeypatch)
    monkeypatch.setattr(route, '_verified_prep_only_receipt', _raise(exc))
    result = _run(route, caplog)
    assert result['error'] == code and result['run_id'].startswith('universal-')


def test_inventory_exception_text_stays_in_the_log(monkeypatch, caplog):
    route = _route(monkeypatch)
    from services import capture_inventory
    monkeypatch.setattr(route, '_verified_prep_only_receipt', lambda *a, **kw: None)
    monkeypatch.setattr(capture_inventory, 'inspect_capture_inventory', _raise(RuntimeError(SECRET)))
    result = _run(route, caplog)
    assert result == {'status': 'rejected', 'error': 'prep_source_inventory_unreadable', 'run_id': result['run_id']}


def test_pit_variant_spec_errors_other_than_unknown_version_get_a_fixed_code(monkeypatch, caplog):
    route = _route(monkeypatch)
    from services import pit_daily_sources
    monkeypatch.setattr(pit_daily_sources, 'variant_specs', _raise(ValueError(SECRET)))
    result = _run(route, caplog, pit_variant_versions=['v'], inference_only=True)
    assert result == {'status': 'rejected', 'error': 'pit_variant_specs_invalid', 'run_id': result['run_id']}
    assert result['run_id'].startswith('universal-')
