"""Verify a sealed search and its selected configuration from immutable rows."""
from datetime import date
import math
from services.research_trial_ledger import checksum, search_inventory, verified_rows
from services.data_snooping_validation import run_data_snooping_test


def verify_search_binding(*, candidate_id, configuration, binding, query=None, runtime_evaluation=None, alpha=.20):
    def fail(reason):
        return {'status':'FAIL','reason':reason,'promotion_authority':False}
    if not isinstance(binding,dict):return fail('immutable_search_binding_missing')
    run_key=binding.get('run_key');selected=binding.get('selected_trial_id')
    receipt_id=binding.get('validation_receipt_id')
    if not all(isinstance(v,str) and v for v in (run_key,selected,receipt_id)):
        return fail('immutable_search_binding_invalid')
    try:
        if query is None:
            from services.d1_domain_client import DomainD1Client, D1DataDomain
            query=DomainD1Client(D1DataDomain.RESEARCH,require_specific=True).query
        inventory=search_inventory(run_key,query=query)
        if inventory['coverage']!='sealed_complete':return fail('search_ledger_not_complete')
        records=verified_rows('run',query=query,run_key=binding.get('validation_run_key',run_key))
        matches=[r for r in records if r['receipt_id']==receipt_id]
        if len(matches)!=1:return fail('search_validation_receipt_missing')
        attestation=matches[0]['content']
        if (attestation.get('schema_version')!='research-search-validation-v1'
                or attestation.get('search_run_key')!=run_key
                or attestation.get('candidate_id')!=candidate_id
                or attestation.get('selected_trial_id')!=selected
                or attestation.get('configuration_checksum')!=checksum(configuration)):
            return fail('search_selected_configuration_mismatch')
        if not isinstance(runtime_evaluation,dict):return fail('current_replay_context_missing')
        from dataclasses import asdict
        from services.backtest_engine import FeeParams
        from services.research_validation import execution_component
        if (attestation.get('execution')!=execution_component()
                or attestation.get('cost')!=asdict(FeeParams.from_trading_config(configuration))):
            return fail('search_execution_or_cost_drift')
        dates=attestation.get('dates');benchmark=attestation.get('benchmark_daily_returns')
        snapshot=attestation.get('data_snapshot');cost=attestation.get('cost')
        if (not isinstance(dates,list) or not 20<=len(dates)<=1500
                or not all(isinstance(d,str) for d in dates) or dates!=sorted(set(dates))
                or not all(date.fromisoformat(d).isoformat()==d for d in dates)
                or not isinstance(snapshot,dict) or not snapshot.get('snapshot_id')
                or not isinstance(snapshot.get('snapshot_checksum'),str)
                or len(snapshot['snapshot_checksum'])!=64
                or any(c not in '0123456789abcdef' for c in snapshot['snapshot_checksum'])
                or not isinstance(cost,dict) or not cost):
            return fail('search_evaluation_context_unverified')
        def panel_valid(values):
            return (isinstance(values,list) and len(values)==len(dates)
                and all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) for v in values))
        if not panel_valid(benchmark):return fail('search_benchmark_panel_invalid')
        if (runtime_evaluation.get('snapshot')!=snapshot or runtime_evaluation.get('dates')!=dates
                or runtime_evaluation.get('benchmark_daily_returns')!=benchmark):
            return fail('search_current_replay_scope_mismatch')
        if not 1<=len(inventory['trials'])<=500:return fail('search_trial_scope_invalid')
        matrix={'__verified_benchmark__':benchmark};selected_found=False
        all_trials=verified_rows('trial',query=query,run_key=run_key)
        for trial_id in {r['logical_id'] for r in all_trials}:
            semantic={checksum({k:r['content'].get(k) for k in ('state','evaluation_scope','configuration_checksum',
                'data_snapshot','cost','validation_dates','validation_daily_returns','execution','gaps')})
                for r in all_trials if r['logical_id']==trial_id}
            if len(semantic)!=1:return fail('search_trial_observation_conflict')
        for trial in inventory['trials']:
            trial_id=trial['logical_id'];content=trial['content']
            if (trial_id=='__verified_benchmark__' or content.get('state')!='complete'
                    or content.get('evaluation_scope')!='validation' or content.get('gaps')
                    or content.get('execution')!=attestation['execution']
                    or content.get('validation_dates')!=dates
                    or content.get('data_snapshot')!=snapshot or content.get('cost')!=cost
                    or not panel_valid(content.get('validation_daily_returns'))):
                return fail('search_trial_panel_incomplete_or_misaligned')
            matrix[trial_id]=content['validation_daily_returns']
            if trial_id==selected:
                selected_found=True
                if (content.get('configuration_checksum')!=checksum(configuration)
                        or content['validation_daily_returns']!=runtime_evaluation.get('candidate_daily_returns')):
                    return fail('search_selected_configuration_mismatch')
        if not selected_found:return fail('search_selected_trial_missing')
        panel_checksum=checksum({'dates':dates,'returns':matrix})
        if attestation.get('panel_checksum')!=panel_checksum:return fail('search_panel_checksum_mismatch')
        result=run_data_snooping_test(matrix,method='hansen_spa',benchmark='__verified_benchmark__',
            search_candidate_ids=[r['logical_id'] for r in inventory['trials']],n_bootstrap=1000,seed=42,alpha=alpha)
        if result.get('promotion_eligible') is not True:return fail('verified_search_spa_failed')
        # A family rejection proves some member has an edge. Bind only its actual
        # tested winner; weaker family members cannot borrow this verdict.
        if result.get('best_candidate')!=selected:return fail('selected_trial_is_not_verified_spa_winner')
        return {'status':'PASS','reason':'sealed_search_selected_configuration_verified',
            'run_key':run_key,'selected_trial_id':selected,'validation_receipt_id':receipt_id,
            'trial_receipt_ids':[r['receipt_id'] for r in inventory['trials']],
            'panel_checksum':panel_checksum,'statistical_evidence':result,'promotion_authority':False}
    except Exception:
        return fail('immutable_search_verification_failed')
