"""Small, immutable serving receipt independent of subsequent NAV research."""
from datetime import datetime, timezone
import json
from google.api_core.exceptions import NotFound
from services import premarket_pipeline as owner

def read(day, run_id, *, client=None):
    b = owner.bucket(client)
    try:
        result = json.loads(b.blob(owner.prefix(day,run_id)+'/serving-publication.json').download_as_bytes())
    except NotFound:
        return None
    l3 = owner.read_seal(day,run_id,client=client)
    if (result.get('checksum') != owner.digest({k:v for k,v in result.items() if k!='checksum'})
            or not l3 or result.get('l3_checksum') != l3['checksum']
            or result.get('run_id') != run_id or result.get('signal_date') != day):
        raise ValueError('premarket_publication_receipt_corrupt')
    return result

def record(state, *, client=None):
    from graphs.daily_pipeline_v2 import classify_pipeline_terminal_invariants, classify_pipeline_terminal_errors
    metrics = state.get('metrics') or {}
    published = metrics.get('l4_plan_publication')
    if published is None:
        # Legacy checkpoints did not capture the readback; keep their existing
        # completion checks. Never manufacture a receipt for an old publication.
        return None
    if classify_pipeline_terminal_invariants(metrics) or classify_pipeline_terminal_errors(state.get('errors'))['critical']:
        raise ValueError('premarket_publication_closure_incomplete')
    plan = state.get('l4_pending_plan') or {}
    allocation = state.get('paired_nav_collection') or {}
    context = state.get('premarket_context') or {}
    if (published.get('status') != 'stored' or published.get('plan_id') != plan.get('plan_id')
            or not plan.get('plan_id') or plan.get('execution_scope') != 'paper'
            or allocation.get('status') != 'allocation_context_frozen'
            or not allocation.get('snapshot_id') or not context.get('checksum')):
        raise ValueError('premarket_publication_source_unverified')
    day,run_id = state['run_date'],state['producer_run_id']
    b = owner.bucket(client); root = owner.prefix(day,run_id)
    if not b.blob(root+'/phases/node_write_d1.json.gz').exists():
        raise ValueError('premarket_publication_checkpoint_missing')
    l3 = owner.read_seal(day,run_id,client=client)
    if not l3 or plan['signal_date'] != day:
        raise ValueError('premarket_publication_l3_mismatch')
    keys = ('prediction_seed_symbols','prediction_symbols','predictions_written',
            'prediction_symbol_closure_passed','incomplete_active_model_symbols',
            'recommendation_seed_rows','recommendation_closed_rows','recommendation_row_closure_passed')
    body = dict(schema_version='premarket-serving-publication-v1',run_id=run_id,signal_date=day,
        trade_date=context['trade_date'],context_checksum=context['checksum'],l3_checksum=l3['checksum'],
        plan_id=plan['plan_id'],policy_identity=plan['policy_identity'],
        allocation_snapshot_id=allocation['snapshot_id'],target_count=len(plan['targets']),
        closure={k:metrics[k] for k in keys},research_status='separate_owner_pending',nav_maturity_credit=0)
    old = read(day,run_id,client=client)
    if old:
        if {k:old[k] for k in body} != body:
            raise ValueError('premarket_publication_identity_changed')
        return old
    body['recorded_at'] = datetime.now(timezone.utc).isoformat()
    sealed = {**body,'checksum':owner.digest(body)}
    owner.immutable(b.blob(root+'/serving-publication.json'),owner.json_bytes(sealed))
    verified = read(day,run_id,client=client)
    if verified != sealed:
        raise ValueError('premarket_publication_readback_failed')
    return verified
