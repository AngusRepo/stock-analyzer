"""Observe original NAV inference in existing predictions, never grant adoption.

Receipt checksums detect incomplete/mixed writes; the original internal pipeline
and Learning D1 are the trust boundary, not caller-supplied JSON authorization.
This is execution observation only, with no NAV maturity or trading authority.
"""
from datetime import date, datetime, timezone
import json

from services.paired_nav_journal import digest, _timestamp

SCHEMA = 'active8-nav-inference-execution-v1'


def _output(value):
    # L4 may append its own result after L3 ran; it must not change L3's output.
    return {key: item for key, item in value.items() if key != 'l4_alpha_ev'}


def attach_execution_receipt(*, predictions, manifest, pool_models, run_id, run_date):
    from services.active8_nav_inference import restore_frozen_nav_inference
    context = manifest.get('active8_nav_inference')
    if context is None:
        return None
    artifact = manifest['active8_ensemble']
    restore_frozen_nav_inference(context, artifact=artifact, pool_models=pool_models)
    if not isinstance(run_id, str) or not run_id.strip() or date.fromisoformat(run_date).isoformat() != run_date:
        raise ValueError('active8_nav_execution_run_identity_missing')
    outputs = []
    for symbol, prediction in sorted(predictions.items()):
        ev = prediction.get('ensemble_v2') or {}
        if (not symbol or prediction.get('error') or ev.get('adoption_basis') != 'committed_paired_nav'
                or ev.get('artifact_checksum') != artifact['payload_checksum']
                or ev.get('nav_inference_context_checksum') != context['context_checksum']
                or ev.get('lineage_status') != 'complete' or not ev.get('signal')):
            raise ValueError('active8_nav_execution_output_identity_mismatch')
        outputs.append([symbol, digest(_output(ev))])
    if not outputs:
        raise ValueError('active8_nav_execution_empty_outputs')
    body = {'schema_version': SCHEMA, 'scope': 'inference_only_not_nav_maturity',
        'run_id': run_id, 'run_date': run_date, 'artifact_checksum': artifact['payload_checksum'],
        'publication_receipt_checksum': digest(context['publication_receipt']),
        'context_checksum': context['context_checksum'], 'context_captured_at': context['captured_at'],
        'symbol_count': len(outputs), 'outputs_checksum': digest(outputs)}
    receipt = {**body, 'execution_checksum': digest(body)}
    for symbol, prediction in predictions.items():
        prediction['nav_inference_execution'] = {'symbol': symbol, 'receipt': receipt}
    return receipt


def _db_time(value):
    return datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)


def pending_execution_receipt(predictions):
    nav_rows = {s: p for s, p in predictions.items()
                if (p.get('ensemble_v2') or {}).get('adoption_basis') == 'committed_paired_nav'}
    if not nav_rows:
        if any(p.get('nav_inference_execution') is not None for p in predictions.values()):
            raise ValueError('active8_nav_execution_marker_missing')
        return None
    receipt = next(iter(nav_rows.values())).get('nav_inference_execution', {}).get('receipt')
    if not isinstance(receipt, dict) or len(nav_rows) != len(predictions):
        raise ValueError('active8_nav_execution_receipt_missing_or_mixed')
    outputs = []
    for symbol, prediction in sorted(nav_rows.items()):
        evidence = prediction.get('nav_inference_execution') or {}
        if evidence.get('receipt') != receipt or evidence.get('symbol') != symbol:
            raise ValueError('active8_nav_execution_receipt_missing_or_mixed')
        outputs.append([symbol, digest(_output(prediction['ensemble_v2']))])
    if (receipt.get('symbol_count') != len(outputs) or receipt.get('outputs_checksum') != digest(outputs)
            or receipt.get('execution_checksum') != digest({k: v for k, v in receipt.items() if k != 'execution_checksum'})):
        raise ValueError('active8_nav_execution_output_changed_before_write')
    return receipt


def verify_execution_rows(rows, receipt):
    if (receipt.get('schema_version') != SCHEMA or receipt.get('scope') != 'inference_only_not_nav_maturity'
            or digest({k: v for k, v in receipt.items() if k != 'execution_checksum'}) != receipt.get('execution_checksum')
            or type(receipt.get('symbol_count')) is not int or receipt['symbol_count'] <= 0
            or len(rows) != receipt['symbol_count']):
        raise ValueError('active8_nav_execution_incomplete_or_invalid')
    outputs, stocks, symbols, stamps = [], set(), set(), []
    captured = _timestamp(receipt['context_captured_at'])
    for row in rows:
        payload = json.loads(row['forecast_data'])
        evidence = payload.get('nav_inference_execution') or {}
        symbol = evidence.get('symbol')
        ev = payload.get('ensemble_v2') or {}
        stamp = _db_time(row['generated_at'])
        # D1 datetime() records seconds while original context may have fractions.
        if (evidence.get('receipt') != receipt or not symbol or symbol in symbols
                or row['stock_id'] in stocks or row['prediction_date'] != receipt['run_date']
                or row['model_name'] != 'ensemble'
                or ev.get('artifact_checksum') != receipt['artifact_checksum']
                or ev.get('adoption_basis') != 'committed_paired_nav'
                or ev.get('nav_inference_context_checksum') != receipt['context_checksum']
                or stamp < captured.replace(microsecond=0)
                or stamp > _db_time(row['observed_at'])):
            raise ValueError('active8_nav_execution_row_mismatch')
        symbols.add(symbol)
        stocks.add(row['stock_id'])
        stamps.append(stamp)
        outputs.append([symbol, digest(_output(ev))])
    if digest(sorted(outputs)) != receipt['outputs_checksum']:
        raise ValueError('active8_nav_execution_output_readback_mismatch')
    return {'status': 'observed', 'executed': True, 'readback_verified': True,
        'observation_scope': 'persisted_inference_only', 'run_id': receipt['run_id'],
        'run_date': receipt['run_date'], 'execution_checksum': receipt['execution_checksum'],
        'publication_receipt_checksum': receipt['publication_receipt_checksum'],
        'artifact_checksum': receipt['artifact_checksum'], 'symbol_count': len(rows),
        'persisted_at': max(stamps).isoformat(), 'nav_maturity_credit': 0}


def read_execution(*, query, receipt):
    rows = _read_rows(query, """prediction_date=?
          AND json_extract(forecast_data, '$.nav_inference_execution.receipt.execution_checksum')=?""",
        [receipt['run_date'], receipt['execution_checksum']])
    return verify_execution_rows(rows, receipt)


def _read_rows(query, where, params):
    # Exhaust the exact event; 80 is transport page size, never an evidence cap.
    rows, cursor = [], 0
    while True:
        page = query("SELECT id, stock_id, model_name, prediction_date, generated_at, forecast_data, "
            "datetime('now') AS observed_at FROM predictions WHERE model_name='ensemble' "
            f"AND id>? AND ({where}) ORDER BY id LIMIT 80", [cursor, *params])
        if not page:
            return rows
        ids = [row['id'] for row in page]
        if ids != sorted(set(ids)) or ids[0] <= cursor:
            raise ValueError('active8_nav_execution_read_cursor_invalid')
        cursor = ids[-1]
        rows.extend(page)


def observe_published_execution(*, query, grant, business_date):
    from services.active8_nav_adoption import is_serving_grant
    if not is_serving_grant(grant):
        raise ValueError('active8_nav_execution_original_publication_required')
    publication_checksum = digest(json.loads(grant.receipt_json))
    artifact_checksum = json.loads(grant.payload_json)['payload_checksum']
    rows = _read_rows(query, """prediction_date>=? AND prediction_date<=?
          AND json_extract(forecast_data, '$.nav_inference_execution.receipt.publication_receipt_checksum')=?
          AND json_extract(forecast_data, '$.nav_inference_execution.receipt.artifact_checksum')=?""",
        [grant.published_at[:10], business_date, publication_checksum, artifact_checksum])
    if not rows:
        return {'status': 'not_observed', 'executed': None,
            'observation_scope': 'persisted_inference_only', 'nav_maturity_credit': 0}
    groups = {}
    for row in rows:
        receipt = json.loads(row['forecast_data'])['nav_inference_execution']['receipt']
        groups.setdefault(receipt['execution_checksum'], []).append(row)
    # Inspect the latest observed event, including incomplete events; no fallback
    # to an older green event. Obsolete partial rows cannot veto a newer full run.
    group = max(groups.values(), key=lambda items: max((r['generated_at'], r['id']) for r in items))
    receipt = json.loads(group[0]['forecast_data'])['nav_inference_execution']['receipt']
    if _timestamp(receipt['context_captured_at']) < _timestamp(grant.published_at):
        raise ValueError('active8_nav_execution_precedes_publication')
    return verify_execution_rows(group, receipt)
