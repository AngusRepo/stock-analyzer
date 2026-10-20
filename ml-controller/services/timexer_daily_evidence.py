"""Daily TimeXer evidence from the frozen serving context, never today's registry."""
from collections import Counter
import asyncio
import hashlib
import json
import logging
import math


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def build(state):
    context = state.get('pipeline_modal_serving_context') or {}
    manifest = context.get('serving_manifest') or {}
    rows = [r for r in manifest.get('models', []) if isinstance(r, dict) and r.get('model') == 'TimeXer']
    if len(rows) > 1:
        raise ValueError('timexer_daily_duplicate_manifest_entry')
    model = rows[0] if rows else None
    predictions = state.get('l3_predictions') or state.get('predictions') or {}
    symbols = sorted(set(str(r.get('symbol') or r.get('stock_id')) for r in
        (state.get('l3_payloads') or state.get('payloads') or []) if r.get('symbol') or r.get('stock_id')))
    if not symbols:
        symbols = sorted(predictions)
    reasons, availability = Counter(), []
    for symbol in symbols:
        prediction = predictions.get(symbol) or {}
        output = prediction.get('timexer') or {}
        eligibility = ((prediction.get('l3_model_eligibility') or {}).get('sequence_models') or {}).get('TimeXer') or {}
        rank = (prediction.get('rank_scores') or {}).get('TimeXer')
        rank_observed = type(rank) in (int, float) and math.isfinite(rank)
        available = output.get('available') is True
        reason = None if available else (output.get('reason') or
            (eligibility.get('reason') if eligibility.get('eligible') is False else None) or
            ('prediction_missing' if symbol not in predictions else 'availability_not_reported'))
        if reason:
            reasons[str(reason)] += 1
        availability.append({'symbol': symbol, 'available': available, 'rank_observed': rank_observed,
            'eligible': eligibility.get('eligible'), 'reason': reason})
    body = {
        'schema_version': 'timexer-daily-evidence-v1', 'signal_date': state.get('run_date'),
        'run_id': state.get('producer_run_id'), 'context_captured_at': context.get('created_at'),
        'manifest_digest': context.get('serving_manifest_digest'),
        'modal_bundle_checksum': state.get('modal_bundle_checksum'),
        'context_status': 'observed' if model else 'not_in_frozen_roster' if manifest else 'serving_context_missing',
        'model': {k: model.get(k) for k in ('model', 'version', 'status', 'effective_status', 'health', 'recipe')} if model else None,
        'candidate_count': len(symbols), 'available_count': sum(r['available'] for r in availability),
        'rank_observed_count': sum(r['rank_observed'] for r in availability),
        'missing_count': sum(not r['available'] for r in availability),
        'missing_reasons': dict(sorted(reasons.items())), 'per_symbol': availability,
        'production_effect': False,
    }
    return {**body, 'checksum': digest(body)}


def record_outcome(*, day, run_id, status, error_type=None, client=None):
    """Record terminal pipeline failures even when L3 never reached its seal.

    Missing model detail remains explicitly unobserved; a failed pipeline does
    not imply TimeXer is DEGRADED. This does not read the live model registry.
    """
    from services import premarket_pipeline as premarket
    if status not in ('success','error'):raise ValueError('timexer_outcome_not_terminal')
    sealed=premarket.read_seal(day,run_id,client=client)
    evidence=(sealed or {}).get('timexer_daily_evidence')
    if evidence is not None and (evidence.get('checksum')!=digest({k:v for k,v in evidence.items() if k!='checksum'})
            or evidence.get('signal_date')!=day or evidence.get('run_id')!=run_id):
        raise ValueError('timexer_outcome_source_mismatch')
    if evidence is None:
        evidence=build({'run_date':day,'producer_run_id':run_id})
    body=dict(schema_version='timexer-run-outcome-v1',signal_date=day,run_id=run_id,pipeline_status=status,
        observation_status='sealed_l3' if sealed and sealed.get('timexer_daily_evidence') else 'l3_evidence_not_recorded',
        error_type=error_type if status=='error' else None,model_evidence=evidence,
        source_receipt_checksum=premarket.digest(sealed) if sealed else None,production_effect=False)
    packet={**body,'checksum':digest(body)}
    path=premarket.prefix(day,run_id)+'/timexer-outcomes/'+packet['checksum']+'.json'
    blob=premarket.bucket(client).blob(path);raw=premarket.json_bytes(packet)
    premarket.immutable(blob,raw)
    if blob.download_as_bytes()!=raw:raise ValueError('timexer_outcome_readback_failed')
    return dict(path=path,checksum=packet['checksum'],observation_status=body['observation_status'],pipeline_status=status)


async def attach_outcome(callback, *, recorder=None):
    """Attach the same immutable evidence to job and verified recovery callbacks."""
    if (callback.get('task') != 'pipeline' or callback.get('status') not in ('success', 'error')
            or not callback.get('run_date') or not callback.get('run_id')):
        return callback
    result = dict(callback)
    result.pop('timexer_evidence_receipt', None)
    result.pop('timexer_recorder_error', None)
    try:
        result['timexer_evidence_receipt'] = await asyncio.to_thread(
            recorder or record_outcome, day=callback['run_date'], run_id=callback['run_id'],
            status=callback['status'],
            error_type=str(callback.get('error') or 'pipeline_failed').split(':', 1)[0]
            if callback['status'] == 'error' else None)
    except Exception as exc:
        # Evidence failure cannot undo a published plan or hide a verified job failure.
        logging.getLogger(__name__).exception('TimeXer outcome receipt failed')
        result['timexer_recorder_error'] = type(exc).__name__
        result['summary'] = (str(callback.get('summary') or '') + ' timexer_recorder=failed').strip()
    return result
