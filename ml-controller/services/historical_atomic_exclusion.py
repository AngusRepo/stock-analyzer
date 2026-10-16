"""Truthful historical exclusion; never a prospective NAV success or credit."""
from copy import deepcopy
from datetime import datetime,timezone,timedelta
import os
from services.paired_nav_journal import digest

ERRORS=frozenset((
    'paired_nav:atomic_collection:historical_not_prospective',
    'paired_nav:atomic_daily:requires_allocation_and_native_execution',
    'paired_nav:atomic_candidate_setup:paired_nav_atomic_no_executable_plans',
))

def valid(collection):
    try:
        receipt=collection['historical_exclusion'];body={k:v for k,v in receipt.items() if k!='receipt_checksum'}
        old=receipt['original_collection'];manifest=receipt['manifest']
        restored={k:v for k,v in collection.items() if k!='historical_exclusion'};restored['status']=old['status']
        from services.paired_nav_pipeline import pipeline_shadow_errors
        frozen=datetime.fromisoformat(manifest['frozen_at'].replace('Z','+00:00'))
        return (receipt['schema_version']=='historical-atomic-exclusion-v1' and digest(body)==receipt['receipt_checksum']
            and collection['status']=='historical_not_prospective' and restored==old
            and 'historical_exclusion' not in old and set(pipeline_shadow_errors(old))==ERRORS
            and receipt['excluded_domain']=='atomic_native_comparison' and manifest['prospective']==0
            and manifest['snapshot_kind']=='allocation_context' and manifest['signal_date']=='2026-10-15'
            and manifest['source_run_id']==receipt['canonical_run_id']
            and manifest['snapshot_id']==collection['snapshot_id']
            and manifest['signal_date']==receipt['signal_date'] and receipt['trade_date']=='2026-10-16'
            and frozen.tzinfo is not None and frozen>=datetime.fromisoformat('2026-10-16T09:00:00+08:00')
            and receipt['nav_maturity_credit']==0 and receipt['promotion_allowed'] is False
            and receipt['prospective_credit'] is False and receipt['can_write_order'] is False
            and receipt['cold_receipt']['payload_checksum']==manifest['payload_checksum']
            and receipt['cold_receipt']['snapshot_id']==manifest['snapshot_id'])
    except (KeyError,TypeError,ValueError,RecursionError):return False

def reconcile(state,*,query,now=None):
    """Only the exact authorized Paper day and immutable historical manifest."""
    from services.paired_nav_pipeline import pipeline_shadow_errors
    collection=state.get('paired_nav_collection')
    if isinstance(collection,dict) and collection.get('historical_exclusion'):
        if not valid(collection):raise ValueError('paired_nav_invalid_historical_exclusion')
        return collection
    if set(pipeline_shadow_errors(collection))!=ERRORS:return collection
    now=now or datetime.now(timezone.utc);tw=now.astimezone(timezone(timedelta(hours=8)))
    context=state.get('premarket_context') or {}
    if (os.environ.get('PIPELINE_DAILY_PLAN_OWNER')!='premarket_once_v1' or state.get('run_date')!='2026-10-15'
            or context.get('trade_date')!='2026-10-16' or tw.date().isoformat()!='2026-10-16'):
        return collection
    if ((state.get('trading_config') or {}).get('l4Distribution') or {}).get('scope')!='paper':return collection
    manifests=query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',[collection['snapshot_id']])
    cold=query('SELECT * FROM paired_nav_cold_objects_v1 WHERE snapshot_id=?',[collection['snapshot_id']])
    if len(manifests)!=1 or len(cold)!=1:raise ValueError('paired_nav_historical_manifest_missing')
    manifest=manifests[0]
    if (manifest['source_run_id']!=state.get('producer_run_id') or manifest['signal_date']!=state['run_date']
            or datetime.fromisoformat(manifest['frozen_at'].replace('Z','+00:00'))>now):
        raise ValueError('paired_nav_historical_manifest_identity_changed')
    body=dict(schema_version='historical-atomic-exclusion-v1',excluded_domain='atomic_native_comparison',
        signal_date=state['run_date'],trade_date=context['trade_date'],canonical_run_id=state['producer_run_id'],
        manifest=deepcopy(manifest),cold_receipt=deepcopy(cold[0]),original_collection=deepcopy(collection),
        nav_maturity_credit=0,promotion_allowed=False,prospective_credit=False,can_write_order=False)
    result={**collection,'status':'historical_not_prospective','historical_exclusion':{**body,'receipt_checksum':digest(body)}}
    if not valid(result):raise ValueError('paired_nav_invalid_historical_exclusion')
    return result
