"""One frozen R2 comparison using the existing two-account native Paper engine."""
from copy import deepcopy
from datetime import datetime,timezone
from services.l4_distribution import digest as model_digest
from services.paired_nav_journal import digest,read_snapshot,freeze_snapshot

OWNER='l4_r2'


def input_arms(source,packet,risk):
    from services.l4_r2_allocation import inputs,allocation_policy
    from services.l4_dated_risk import is_dated_risk
    base=deepcopy(source['inputs']);policy=base['alpha_policy']['l4Distribution']
    day=packet['forecast']['signal_date'];evaluation=packet['evaluation_policy']
    if (source['formal_baseline_identity']!=packet['forecast']['l3_identity']
            or model_digest(allocation_policy(policy))!=evaluation['allocation_policy_checksum']
            or model_digest(source['trading_config']['fees'])!=evaluation['cost_policy_checksum']
            or policy['runtime']['signal_date']!=day or not is_dated_risk(risk)
            or risk.get('signal_date')!=day
            or risk['checksum']!=model_digest({k:v for k,v in risk.items() if k!='checksum'})):
        raise ValueError('l4_r2_pair_source_changed')
    eligible=set(packet['snapshot']['eligible_symbols'])
    excluded=sorted(r['symbol'] for r in base['recommendations'] if r['symbol'] not in eligible)
    base['recommendations']=[r for r in base['recommendations'] if r['symbol'] in eligible]
    # Preserve the archived strategy slate. Excluded ETFs are not replaced.
    base['return_history']=deepcopy(risk);base['opb_reward_ledger']=[]
    result={}
    for arm in ('baseline','candidate'):
        value=deepcopy(base);value['r2_shadow']={**deepcopy(packet),'comparison_arm':arm}
        p=value['alpha_policy']['l4Distribution'];p['scope']='private_research'
        symbols=[r['symbol'] for r in value['recommendations']]
        inputs(value['r2_shadow'],identity=p['runtime']['l3_identity'],day=day,
            baseline=p['artifact'],policy=p,symbols=symbols)
        result[arm]=value
    return result,excluded


def verify_input_arms(allocation,parent,*,query):
    content=parent['payload']['content']
    original=read_snapshot(query,content['r2_source_context_snapshot_id'])
    if (original['manifest']['snapshot_kind']!='allocation_context'
            or original['manifest']['signal_date']!=parent['manifest']['signal_date']
            or original['manifest']['payload_checksum']!=content['r2_source_context_checksum']):
        raise ValueError('l4_r2_pair_parent_changed')
    expected,excluded=input_arms(original['payload']['content'],content['r2_packet'],content['r2_risk'])
    if (content['r2_input_arms']!=expected or content['r2_excluded_slate_symbols']!=excluded
            or allocation['configuration']['r2_policy']!=content['r2_packet']['evaluation_policy']
            or allocation['candidate_checksum']!=content['r2_packet']['forecast']['model_checksum']
            or allocation['baseline_checksum']!=content['r2_packet']['forecast']['baseline_model_checksum']):
        raise ValueError('l4_r2_pair_inputs_changed')
    return expected


def freeze_pair(*,source_id,packet,risk,query,writer,now=None):
    """Freeze previews only; registration executes each arm against its own cash."""
    from services.paired_nav_collection import allocator_source_identity
    from services.paired_nav_execution_environment import configuration_environment
    from services.paired_native_session import STRATEGY_SESSION_POLICY
    from services.l4_distribution_runtime import run
    clock=now or datetime.now(timezone.utc);day=packet['forecast']['signal_date']
    original=read_snapshot(query,source_id);source=original['payload']['content']
    if (original['manifest']['snapshot_kind']!='allocation_context' or not original['manifest']['prospective']
            or original['manifest']['signal_date']!=day
            or source.get('allocator_source_identity')!=allocator_source_identity()):
        raise ValueError('l4_r2_pair_original_context_invalid')
    arms,excluded=input_arms(source,packet,risk)
    configuration={k:deepcopy(source[k]) for k in ('trading_config','risk_config','allocator_source_identity','formal_baseline_identity')}
    configuration.update(configuration_environment(original),r2_policy=packet['evaluation_policy'],
        native_session_policy=STRATEGY_SESSION_POLICY)
    pair_id=digest([OWNER,packet['forecast']['model_checksum'],packet['forecast']['baseline_model_checksum'],configuration])
    existing_id=digest(['allocation_pair',day,pair_id])
    if query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',[existing_id]):
        previous=read_snapshot(query,existing_id)['payload']['content']
        previous_parent=read_snapshot(query,previous['allocation_context_snapshot_id'])
        if (previous['configuration']!=configuration or previous_parent['payload']['content']['r2_packet']!=packet
                or previous_parent['payload']['content']['r2_risk']!=risk):
            raise ValueError('l4_r2_pair_retry_changed')
        verify_input_arms(previous,previous_parent,query=query)
        return dict(snapshot_id=existing_id,pair_id=pair_id,owner=OWNER)
    context={k:deepcopy(source[k]) for k in ('model_predictions','native_execution_environment','inputs','formal_baseline_identity')}
    context.update(r2_source_context_snapshot_id=source_id,r2_source_context_checksum=original['manifest']['payload_checksum'],
        r2_packet=packet,r2_risk=risk,r2_input_arms=arms,r2_excluded_slate_symbols=excluded)
    parent=freeze_snapshot(signal_date=day,source_run_id='l4-r2:'+pair_id,snapshot_kind='allocation_context',
        content=context,query=query,writer=writer,now=clock)
    previews={}
    for arm,value in arms.items():
        captures=[]
        rows=run(value['recommendations'],value['alpha_policy']['l4Distribution'],
            return_history=value['return_history'],reward_ledger=[],private_research=True,
            r2_shadow=value['r2_shadow'],evidence_sink=captures.append)
        if len(captures)!=1:raise ValueError('l4_r2_pair_capture_missing')
        previews[arm]=dict(recommendations=rows,capture=captures[0])
    plan=dict(pair_id=pair_id,owner=OWNER,candidate_checksum=packet['forecast']['model_checksum'],
        baseline_checksum=packet['forecast']['baseline_model_checksum'],configuration=configuration,
        configuration_checksum=digest(configuration),allocation_context_snapshot_id=parent['snapshot_id'],
        model_predictions_checksum=digest(context['model_predictions']),**previews,
        production_effect=False,promotion_allowed=False,nav_maturity_credit=0)
    result=freeze_snapshot(signal_date=day,source_run_id=pair_id,snapshot_kind='allocation_pair',
        content=plan,query=query,writer=writer,now=clock)
    return dict(snapshot_id=result['snapshot_id'],pair_id=pair_id,owner=OWNER)


def run(*,bucket,config,observation,shadow,day,query,writer):
    from services.l4_native_observation import read_reference
    from services.paired_native_runtime import register_candidate_execution_plans
    from services.paired_nav_journal import materialize_staged_receipts
    forecast=read_reference(bucket,shadow['reference'])
    snapshot=read_reference(bucket,observation['projection'])
    original=read_reference(bucket,snapshot['original_reference'])
    evaluation=read_reference(bucket,config['evaluation_policy'])
    packet=dict(forecast=forecast,snapshot=snapshot,evaluation_policy=evaluation)
    risk=read_reference(bucket,original['risk_reference'])
    # The formal context is independently sealed by the unchanged pipeline.
    rows=query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_context' "
        "AND signal_date=? AND prospective=1 AND source_run_id NOT LIKE 'l4-r2:%' ORDER BY frozen_at DESC",[day])
    source=None
    for row in rows:
        saved=read_snapshot(query,row['snapshot_id']);body=saved['payload']['content']
        if (body.get('inputs',{}).get('alpha_policy',{}).get('l4Distribution')
                and 'native_execution_environment' in body and 'formal_output' in body
                and not body.get('upstream_allocation_context_snapshot_id')):
            source=row['snapshot_id'];break
    if source is None:
        return dict(status='pending',reason='l4_r2_pair_awaiting_formal_context',promotion_allowed=False)
    # Finish yesterday's original journal before carrying private state forward.
    plan=freeze_pair(source_id=source,packet=packet,risk=risk,query=query,writer=writer)
    materialize_staged_receipts(business_date=day,query=query,writer=writer,pair_id=plan['pair_id'])
    registration=register_candidate_execution_plans(collection={'plans':[plan]},query=query,writer=writer)
    from services.paired_nav_chain import verify_journal_chain
    from services.l4_forward_refresh import publish
    daily=[]
    verified=verify_journal_chain(business_date=day,query=query,pair_id=plan['pair_id'],observe_prefix=daily.append)
    report=publish(bucket,'r2_paired_reports',dict(pair_id=plan['pair_id'],cutoff_date=day,
        verification=verified,daily=daily,promotion_allowed=False,
        evidence_scope='original_native_execution_receipts_and_independent_costed_journal'))
    return dict(status='registered',plan=plan,registration=registration,promotion_allowed=False,
        engine='original_native_paper_both_arms',independent_account_state=True,
        verified_paired_sessions=len(daily),journal_report=report)
