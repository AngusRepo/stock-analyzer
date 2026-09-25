"""Whole L3/L4 policy contrast on the original ensemble NAV owner.

The ensemble checksum still identifies L3. The comparison configuration binds
its exact L4/allocator policy, so no L3-only or different-policy verdict transfers.
No training, publication, remote writes, or caller-supplied efficacy verdict.
"""
from copy import deepcopy
from datetime import date

from services.paired_nav_journal import digest

SCHEMA = 'paired-nav-l3-l4-strategy-bundle-v1'
CANDIDATE_KEY = 'l4:nav_candidate_bundles:v1'
EV_FIELDS = {'l4AlphaEv', 'allocatorEvFusion', 'l4Distribution'}


def _without_ev(config):
    return {k: v for k, v in config.items() if k not in EV_FIELDS}


def validate_strategy_bundle(bundle, *, candidate_identity=None, signal_date):
    from services.l4_distribution import validate_bundle
    if (not isinstance(bundle, dict) or bundle.get('schema_version') != SCHEMA
            or bundle.get('comparison_unit') != 'complete_l3_l4_strategy'
            or bundle.get('production_effect') is not False
            or bundle.get('bundle_checksum') != digest({k:v for k,v in bundle.items() if k!='bundle_checksum'})):
        raise ValueError('paired_nav_strategy_bundle_corrupt')
    if 'strategy_ab' in bundle:
        from services.strategy_ab import validate_tag
        validate_tag(bundle['strategy_ab'])
    baseline, target = bundle['baseline_trading_config'], bundle['candidate_trading_config']
    primary=(bundle.get('strategy_ab') or {}).get('baseline_primary')
    if primary is not None:
        baseline_l4=(baseline.get('l4Distribution') or {}).get('artifact') or {}
        if (primary['l3_checksum']!=bundle['baseline_l3_identity']['payload_checksum']
                or baseline_l4.get('l3_identity')!=bundle['baseline_l3_identity']
                or (baseline_l4.get('model') or {}).get('residual_mlp')):
            raise ValueError('strategy_ab_primary_baseline_pairing_mismatch')
        validate_bundle(baseline_l4,l3_identity=bundle['baseline_l3_identity'],signal_date=signal_date)

    if (not baseline or _without_ev(baseline) != _without_ev(target)
            or any(k in target for k in ('l4AlphaEv','allocatorEvFusion'))
            or not target.get('l4Distribution')
            or any(k in target['l4Distribution'] for k in ('runtime','_account_rewards'))):
        raise ValueError('paired_nav_strategy_unshared_risk_or_execution_config')
    policy = target['l4Distribution']
    identity = bundle['candidate_l3_identity']
    if candidate_identity is not None and identity != candidate_identity:
        raise ValueError('paired_nav_strategy_l3_pairing_mismatch')
    if policy.get('scope') != 'paper':
        raise ValueError('paired_nav_strategy_paper_scope_required')
    validate_bundle(policy['artifact'],l3_identity=identity,signal_date=signal_date)
    from services.l4_allocation_contract import inherited_sparse_controls
    from services.l4_distribution_runtime import distribution_policy_identity,choose_opb
    constraints=policy['constraints']
    if (constraints.get('max_positions') != baseline['position']['maxPositions']
            or constraints.get('buy_cost') != baseline['fees']['commission']
            or abs(constraints.get('sell_cost',0)-baseline['fees']['commission']-baseline['fees']['tax'])>1e-12
            or any(constraints.get(k)!=v for k,v in inherited_sparse_controls(baseline).items())):
        raise ValueError('paired_nav_strategy_constraint_mismatch')
    choose_opb(policy,[],distribution_policy_identity(policy,identity),signal_date)
    date.fromisoformat(bundle['declared_signal_date'])
    if bundle['declared_signal_date'] > signal_date:
        raise ValueError('paired_nav_strategy_future_declaration')
    return deepcopy(bundle)


def bundle_from_packet(packet):
    """Consume the engineering-approved candidate packet, never its NAV claim."""
    if (packet.get('schema_version')!='l4-local-cutover-packet-v1'
            or packet.get('release_kind')!='nav_strategy_candidate'
            or packet.get('can_publish') is not False
            or packet.get('l3_nav_gate_waived') is not False
            or digest(packet['rollback_config'])!=packet.get('previous_config_checksum')
            or digest(packet['next_config'])!=packet.get('next_config_checksum')):
        raise ValueError('paired_nav_strategy_candidate_packet_invalid')
    result={'schema_version':SCHEMA,'comparison_unit':'complete_l3_l4_strategy',
        'declared_signal_date':packet['signal_date'],
        'baseline_l3_identity':deepcopy(packet['expected_l3_identity']),
        'candidate_l3_identity':deepcopy(packet['next_l3_identity']),
        'baseline_trading_config':deepcopy(packet['rollback_config']),
        'candidate_trading_config':deepcopy(packet['next_config']),
        'source_evidence_checksum':packet['source_evidence_checksum'],
        'production_effect':False}
    result['bundle_checksum']=digest(result)
    return validate_strategy_bundle(result,signal_date=packet['signal_date'])


def validate_comparison_configuration(configuration, *, signal_date):
    bundle=configuration.get('strategy_bundle')
    if bundle is None:
        return None
    bundle=validate_strategy_bundle(bundle,signal_date=signal_date)
    if (configuration['trading_config'] != bundle['baseline_trading_config']
            or any(configuration['formal_baseline_identity'].get(k)!=v
                for k,v in bundle['baseline_l3_identity'].items())):
        raise ValueError('paired_nav_strategy_baseline_changed')
    return bundle


def arm_configuration(configuration, arm, *, signal_date):
    if arm not in ('baseline','candidate'):
        raise ValueError('paired_nav_strategy_arm_invalid')
    bundle=validate_comparison_configuration(configuration,signal_date=signal_date)
    return deepcopy(bundle[arm+'_trading_config'] if bundle else configuration['trading_config'])


def verify_strategy_inputs(configuration, parent, *, signal_date, copy_inputs=True):
    bundle=validate_comparison_configuration(configuration,signal_date=signal_date)
    if bundle is None:
        return None
    arms=parent.get('strategy_allocation_input_arms')
    if not isinstance(arms,dict) or set(arms)!={'baseline','candidate'}:
        raise ValueError('paired_nav_strategy_allocation_arms_missing')
    if arms['baseline']!=parent['inputs']:
        raise ValueError('paired_nav_strategy_baseline_inputs_changed')
    candidate=arms['candidate']
    if any(candidate.get(k)!=arms['baseline'].get(k) for k in (
            'ranking_config','ensemble_v2_cfg','regime_label','regime_surface')):
        raise ValueError('paired_nav_strategy_shared_inputs_changed')
    risk=parent.get('strategy_bundle_risk_context')
    if risk is not None:
        from services.paired_nav_collection import replay_allocator_return_history
        history=replay_allocator_return_history(risk,
            payloads=parent['recommendation_context']['inputs']['payloads'],signal_date=signal_date)
        if candidate['return_history']!=history:
            raise ValueError('paired_nav_strategy_risk_inputs_changed')
    elif candidate['return_history']!=arms['baseline']['return_history']:
        raise ValueError('paired_nav_strategy_risk_parent_missing')
    policy=candidate['alpha_policy']['l4Distribution']
    static={k:v for k,v in policy.items() if k not in ('runtime','_account_rewards')}
    if static!=bundle['candidate_trading_config']['l4Distribution']:
        raise ValueError('paired_nav_strategy_candidate_policy_changed')
    runtime=policy.get('runtime') or {}
    if (runtime.get('signal_date')!=signal_date
            or runtime.get('l3_identity')!=bundle['candidate_l3_identity']
            or runtime.get('predictions')!=parent['model_prediction_arms']['candidate']['predictions']):
        raise ValueError('paired_nav_strategy_candidate_predictions_changed')
    return deepcopy(arms) if copy_inputs else None


def attach_strategy_bundles(selection, *, declarations=None, registered=()):
    """Bind predeclared pairs before inference; retain immutable running pairs."""
    declared={}
    if declarations is not None:
        if (declarations.get('schema_version')!='paired-nav-strategy-bundles-v1'
                or not isinstance(declarations.get('bundles'),list)):
            raise ValueError('paired_nav_strategy_declarations_invalid')
        for item in declarations['bundles']:
            item=validate_strategy_bundle(item,signal_date=selection['signal_date'])
            key=item['candidate_l3_identity']['payload_checksum']
            if key in declared:raise ValueError('paired_nav_strategy_duplicate_l3_binding')
            declared[key]=item
    pinned={}
    for candidate in registered:
        bundle=candidate.get('strategy_bundle')
        if bundle is None:continue
        key=candidate['artifact']['payload_checksum']
        bundle=validate_strategy_bundle(bundle,signal_date=selection['signal_date'])
        if ((key in declared and declared[key]!=bundle) or (key in pinned and pinned[key]!=bundle)):
            raise ValueError('paired_nav_strategy_registered_policy_changed')
        pinned[key]=bundle
    bindings={**declared,**pinned}
    result=deepcopy(selection)
    eligible=[]
    for candidate in result['candidates']:
        key=candidate['artifact']['payload_checksum']
        if key in bindings:
            artifact=candidate['artifact']
            identity={'schema_version':'paired-nav-formal-ml-baseline-v1',
                'artifact_id':candidate['registry']['artifact_id'],
                **{k:artifact[k] for k in ('cohort_id','payload_checksum','base_artifact_set_checksum')}}
            candidate['strategy_bundle']=validate_strategy_bundle(bindings[key],
                candidate_identity=identity,signal_date=selection['signal_date'])
        elif declarations is not None and not candidate.get('registered_pairs'):
            continue  # A whole-chain trial admits executable PAIRS, not lone L3s.
        eligible.append(candidate)
    result['candidates']=eligible
    keys={c['bundle_key'] for c in eligible}
    result['requests']=[r for r in result['requests'] if r['bundle_key'] in keys]
    result['request_checksum']=digest(result['requests'])
    result['status']='candidate_ensembles_frozen' if eligible else 'awaiting_matching_executable_ensemble'
    if declarations is not None or pinned:
        result['comparison_unit']='complete_l3_l4_strategy'
        result['declared_bundle_checksums']=sorted(b['bundle_checksum'] for b in bindings.values())
    return result


def publication_configuration(configuration, *, signal_date):
    """A whole-chain NAV verdict authorizes ONLY the paired target config.

    The original baseline configuration remains immutable evidence. Staging the
    exact target is a separate approved release operation; until then adoption
    remains HOLD, rather than publishing L3 alone under the incumbent L4.
    """
    bundle=validate_comparison_configuration(configuration,signal_date=signal_date)
    result=deepcopy(configuration)
    if bundle is not None:
        result['trading_config']=deepcopy(bundle['candidate_trading_config'])
    return result


def capture_strategy_context(*, selection, recommendation_context, signal_date, query, writer):
    """Freeze canonical risk for today's pool PLUS each private account's holdings."""
    from services.l4_distribution_context import worker_request
    from services.paired_nav_native_holdings import capture_native_holdings
    from services.l4_risk_history import load_held_risk_payloads,load_canonical_risk_payloads
    from services.recommendation_service import gnn_return_history_lookback
    from services.paired_nav_collection import capture_allocator_return_history
    from services.paired_nav_journal import _timestamp
    from datetime import datetime,timezone,timedelta
    start=datetime.now(timezone.utc)
    account=worker_request('/api/internal/l4-distribution/account',{'signal_date':signal_date})
    if (account.get('schema_version')!='l4-account-context-v1' or account.get('complete') is not True
            or account.get('signal_date')!=signal_date or not account.get('risk_limits') or not account.get('fees')
            or not start-timedelta(seconds=5)<=_timestamp(account['observed_at'])<=datetime.now(timezone.utc)+timedelta(seconds=5)):
        raise ValueError('paired_nav_strategy_account_incomplete')
    checksums=[c['artifact']['payload_checksum'] for c in selection['candidates'] if c.get('strategy_bundle')]
    holdings=capture_native_holdings(signal_date=signal_date,definition_checksums=checksums,
        query=query,writer=writer,owner='ensemble')
    if any(d['status']!='ready' for d in holdings['definitions'].values()):
        raise ValueError('paired_nav_strategy_native_holdings_unavailable')
    symbols={p['symbol'] for p in account['holdings']}
    symbols.update(s for d in holdings['definitions'].values() for arm in ('baseline','candidate') for s in d['arms'][arm])
    payloads=recommendation_context['inputs']['payloads']
    lookback=gnn_return_history_lookback()
    held=load_held_risk_payloads(holdings=[{'symbol':s} for s in sorted(symbols)],
        payloads=payloads,signal_date=signal_date,lookback=lookback)
    canonical=load_canonical_risk_payloads(payloads=payloads,held_payloads=held,signal_date=signal_date,lookback=lookback)
    risk=capture_allocator_return_history(payloads=payloads,signal_date=signal_date,
        held_payloads=held,canonical_risk_payloads=canonical)
    return {'strategy_bundle_account':account,'strategy_bundle_native_holdings':holdings,
        'strategy_bundle_risk_context':risk}
