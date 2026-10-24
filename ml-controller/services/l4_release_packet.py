"""Prepare a reviewable local cutover packet. Never writes cloud configuration."""
from copy import deepcopy
from services.l4_allocation_contract import inherited_sparse_controls
from services.l4_distribution import digest,validate_bundle
from services.l4_distribution_lifecycle import prepare_paper_release
from services.l4_distribution_runtime import distribution_policy_identity,validate_opb_policy
from services.l4_opb_selection import POLICY_SCHEMA,is_v2,validate_constraints


def prepare_packet(*,current_config,candidate,acceptance,source_evidence,l3_identity,constraints,signal_date,current_l3_identity=None,current_plan_id=None,nav_candidate=False):
    if acceptance.get('source_evidence_checksum')!=digest(source_evidence):
        raise ValueError('l4_release_source_evidence_checksum_mismatch')
    allowed_scope = ('native_engineering_paper_execution' if acceptance.get('acceptance_mode')=='paper_experiment'
                     else 'paired_native_paper_execution')
    if source_evidence.get('scope')!=allowed_scope or source_evidence.get('complete') is not True:
        raise ValueError('l4_release_real_account_evidence_required')
    if candidate.get('l3_identity')!=l3_identity:
        raise ValueError('l4_release_current_l3_mismatch')
    # Require an incumbent readback separate from the target candidate.
    identity_keys=('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')
    if (not isinstance(current_l3_identity,dict)
            or any(not isinstance(current_l3_identity.get(key),str) or not current_l3_identity[key].strip()
                   for key in identity_keys)):
        raise ValueError('l4_release_verified_current_l3_required')
    upgrading=current_config.get('l4Distribution') is not None
    if upgrading:
        prior=current_config['l4Distribution']['artifact']['l3_identity']
        if current_l3_identity!=prior or not isinstance(current_plan_id,str) or len(current_plan_id)!=64:
            raise ValueError('l4_upgrade_verified_current_l3_and_plan_required')
    elif current_l3_identity!=l3_identity and not nav_candidate:
        raise ValueError('l4_initial_cutover_cannot_change_l3')
    v2=is_v2(current_config.get('l4Distribution'))
    if v2:
        # Risk owns count/fees; a model release never changes allocator params.
        inherited=deepcopy(current_config['l4Distribution']['constraints'])
        if validate_constraints(constraints)!=inherited:
            raise ValueError('l4_release_native_sparse_controls_not_aligned')
    else:
        if constraints.get('max_positions')!=current_config['position']['maxPositions']:
            raise ValueError('l4_release_unapproved_position_count_change')
        if any(constraints.get(k)!=current_config['fees'][source] for k,source in [('buy_cost','commission')]):
            raise ValueError('l4_release_cost_mismatch')
        if abs(constraints['sell_cost']-current_config['fees']['commission']-current_config['fees']['tax'])>1e-12:
            raise ValueError('l4_release_cost_mismatch')
        inherited=inherited_sparse_controls(current_config)
        if any(key not in constraints or constraints[key]!=value for key,value in inherited.items()):
            raise ValueError('l4_release_native_sparse_controls_not_aligned')
    if not current_config.get('ranking',{}).get('enabled',True):
        raise ValueError('l4_release_allocator_disabled')
    if acceptance.get('acceptance_mode','comparative_promotion') == 'comparative_promotion':
        if source_evidence.get('paired_comparison_checksum') != digest(acceptance.get('paired_account_comparison')):
            raise ValueError('l4_release_paired_evidence_binding_missing')
    release=prepare_paper_release(candidate,acceptance,signal_date=signal_date)
    validate_bundle(release,l3_identity=l3_identity,signal_date=signal_date)
    opb=deepcopy(source_evidence.get('opb_policy'))
    if not isinstance(opb,dict) or opb.get('enabled') is not True:
        raise ValueError('l4_release_evaluated_opb_policy_required')
    shape={'policy_schema':POLICY_SCHEMA} if v2 else {}
    identity=distribution_policy_identity({**shape,'artifact':release,'constraints':constraints,'opb':opb},l3_identity)
    validate_opb_policy({**shape,'constraints':constraints,'opb':opb},identity,signal_date)
    config=deepcopy(current_config)
    config['l4Distribution']={**shape,'scope':'paper','artifact':release,'constraints':deepcopy(constraints),'opb':opb}
    from services.l4_mlp_median import SCHEMA as MEDIAN_SCHEMA
    from services.l4_tabpack_median import SCHEMA as TABPACK_MEDIAN_SCHEMA
    from services.paper_strategy_mode import MLP_MODE, MODE, TABPACK_MEDIAN_MODE, validate_model_mode
    if release['model'].get('residual_tabpack',{}).get('schema_version')==TABPACK_MEDIAN_SCHEMA:
        config['l4Distribution'].update(operating_mode=TABPACK_MEDIAN_MODE,strategy_role='B')
        validate_model_mode(config['l4Distribution'])
    elif release['model'].get('residual_mlp',{}).get('schema_version')==MEDIAN_SCHEMA:
        config['l4Distribution'].update(operating_mode=MLP_MODE,strategy_role='B')
        validate_model_mode(config['l4Distribution'])
    elif (current_config.get('l4Distribution') or {}).get('operating_mode') is not None:
        config['l4Distribution'].update(operating_mode=MODE,strategy_role='B')
        validate_model_mode(config['l4Distribution'])
    for field in ('l4AlphaEv','allocatorEvFusion'):
        config.pop(field,None)
    return {'schema_version':'l4-local-cutover-packet-v1','signal_date':signal_date,
        'inherited_sparse_controls':inherited,'previous_config_checksum':digest(current_config),'next_config_checksum':digest(config),
        'expected_l3_identity':current_l3_identity,'next_l3_identity':l3_identity,
        'l3_publication_qualification':('unchanged_incumbent' if current_l3_identity==l3_identity
            else 'native_nav_required' if nav_candidate else 'model_validation_required'),
        'l3_nav_gate_waived':False,
        'pending_release_checks':(['native_l3_nav_adoption' if nav_candidate else 'native_l3_model_validation']
            if current_l3_identity!=l3_identity else []),
        'release_kind':'nav_strategy_candidate' if nav_candidate else 'paired_upgrade' if upgrading else 'initial_cutover',
        'can_publish':False if nav_candidate else current_l3_identity==l3_identity,
        'execution_sequence':['verify_config_l3_and_plan_readbacks','drain_running_order_intents',
            'publish_next_config_invalidating_previous_model_targets',
            'promote_paired_l3_with_existing_atomic_bundle_controller_if_changed',
            'verify_both_model_readbacks','publish_fresh_plan_against_preserved_account_head'],
        'cross_database_atomicity':False,'transitional_execution':'fail_closed_new_targets_hard_risk_exits_continue','next_config':config,'rollback_config':deepcopy(current_config),
        'migration':'worker/domain-migrations/paper/0005_l4_distribution.sql',
        'expected_initial_plan_parent':current_plan_id,'reset_account':False,'delete_history':False,
        'training_executed':False,'remote_mutations_executed':False,
        'deployment_requires_separate_authorization':True,'source_evidence_checksum':digest(source_evidence)}


def prepare_policy_v2_packet(*,raw_config,merged_config,risk_config,risk_defaults,lookback,cost_objective,engineering_receipt,source_reference):
    """Reviewable v1 -> v2 owner move. Never writes cloud configuration.

    `merged_config` is the Worker-merged view the runtime approval pins; the
    raw KV gets the same owner moves so the merged readback equals the grant.
    """
    from services.active_model_policy import gnn_return_history_lookback
    from services.l4_policy_activation import activation_document,next_trading_config
    from services.paired_nav_journal import digest as approval_digest
    if lookback!=gnn_return_history_lookback():
        raise ValueError('l4_policy_v2_lookback_changes_allocator_history')
    if approval_digest(raw_config.get('l4Distribution'))!=approval_digest(merged_config.get('l4Distribution')):
        raise ValueError('l4_policy_v2_merged_policy_not_raw')
    activation,next_merged,next_risk=activation_document(merged_config,risk_config,lookback=lookback,
        cost_objective=cost_objective,risk_defaults=risk_defaults,engineering_receipt_checksum=approval_digest(engineering_receipt),
        source_reference=source_reference)
    next_raw=next_trading_config(raw_config,l4=next_merged['l4Distribution'],
        scales=activation['circuit_position_scales'])
    return {'schema_version':'l4-policy-v2-packet-v1','activation':activation,
        'next_config':next_raw,'next_merged_config':next_merged,'next_risk_config':next_risk,
        'rollback_config':deepcopy(raw_config),'rollback_risk_config':deepcopy(risk_config),
        'previous_config_checksum':approval_digest(raw_config),'next_config_checksum':approval_digest(next_raw),
        'previous_risk_config_checksum':approval_digest(risk_config),'next_risk_config_checksum':approval_digest(next_risk),
        'approved_policy_identity':activation['next_policy_identity'],
        'write_order':['trading:risk_config','trading:config'],'rollback_order':['trading:config','trading:risk_config'],
        'engineering_receipt':deepcopy(engineering_receipt),
        'remote_mutations_executed':False,'deployment_requires_separate_authorization':True}


def prepare_policy_change_packet(previous,*,changes,engineering_receipt,source_reference):
    """Next link of the release chain: a v2 constraints change after `previous`.

    Derived offline from the previous packet's next configuration, so one
    release can review and stage P1..Pn before any of them is written to KV.
    """
    from services.l4_policy_activation import change_document
    from services.paired_nav_journal import digest as approval_digest
    if previous.get('schema_version') not in ('l4-policy-v2-packet-v1','l4-policy-change-packet-v1'):
        raise ValueError('l4_policy_change_previous_packet_invalid')
    activation,next_merged=change_document(previous['next_merged_config'],changes=changes,
        engineering_receipt_checksum=approval_digest(engineering_receipt),source_reference=source_reference)
    next_raw={**deepcopy(previous['next_config']),'l4Distribution':deepcopy(next_merged['l4Distribution'])}
    risk=previous['next_risk_config']
    return {'schema_version':'l4-policy-change-packet-v1','activation':activation,
        'next_config':next_raw,'next_merged_config':next_merged,'next_risk_config':deepcopy(risk),
        'rollback_config':deepcopy(previous['next_config']),'rollback_risk_config':deepcopy(risk),
        'previous_config_checksum':approval_digest(previous['next_config']),'next_config_checksum':approval_digest(next_raw),
        'previous_risk_config_checksum':approval_digest(risk),'next_risk_config_checksum':approval_digest(risk),
        'approved_policy_identity':activation['next_policy_identity'],
        'write_order':['trading:config'],'rollback_order':['trading:config'],
        'engineering_receipt':deepcopy(engineering_receipt),
        'remote_mutations_executed':False,'deployment_requires_separate_authorization':True}
