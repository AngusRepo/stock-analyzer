"""One full-L3 -> L4 -> portfolio boundary with replayable account evidence."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import math
import numpy as np

from services.l4_distribution import MODELS, OWNER, SCHEMA, digest, finite, features, predict, validate_bundle
from services.l4_portfolio import allocate
from services.l4_l3_baseline import native_baseline, attach_baseline
from services.similarity_evidence import ledoit_wolf_covariance

PLAN_SCHEMA = 'l4-portfolio-plan-v1'


def native_features(row, prediction, identity=None):
    if identity is not None:
        ensemble = prediction.get("ensemble_v2") or {}
        for key, source in (("artifact_id","artifact_id"),("payload_checksum","artifact_checksum"),
                            ("cohort_id","cohort_id"),("base_artifact_set_checksum","base_artifact_set_checksum")):
            if ensemble.get(source) != identity.get(key):
                raise ValueError("l4_distribution_prediction_lineage_mismatch:" + key)
        if (ensemble.get("avg_rank_semantic") != "compatibility_alias_probability_positive_net_return"
                or ensemble.get("lineage_status") != "complete"):
            raise ValueError("l4_distribution_native_ensemble_semantic_mismatch")
    from services.recommendation_service import _per_model_signal_payload
    from services.l4_alpha_ev_producer import _feature_value
    result = {}
    optional = (prediction.get('l3_model_eligibility') or {}).get('sequence_models') or {}
    lineage = prediction.get('model_score_lineage') or {}
    selected = lineage.get('selected_models')
    selection_attested = (isinstance(selected,list) and bool(selected) and set(selected)<=set(MODELS)
        and lineage.get('coverage_policy')=='validated-bundle-selected-core-sequence-missingness-v1'
        and lineage.get('ensemble_payload_checksum')==prediction.get('ensemble_v2',{}).get('artifact_checksum')
        and lineage.get('complete') is True)
    for model in MODELS:
        payload = _per_model_signal_payload(prediction, model)
        raw, rank = payload.get('raw_score'), payload.get('rank_score')
        available = raw is not None and rank is not None
        if not available:
            missing = optional.get(model) or {}
            excluded_by_l3 = selection_attested and model not in selected
            optional_history_missing = (model in MODELS[5:] and missing.get('eligible') is False
                and missing.get('reason') == 'active8_sequence_history_contract_unmet_optional_masked')
            optional_rank_missing = (selection_attested and model in MODELS[5:]
                and model in lineage.get('optional_missing_models',[]))
            if not (excluded_by_l3 or optional_history_missing or optional_rank_missing):
                raise ValueError('l4_distribution_native_model_missing:' + model)
            raw = rank = None
        result.update({f'{model}_raw': raw, f'{model}_rank': rank, f'{model}_available': int(available)})
    for key in ('ml_edge_norm','ensemble_directional_margin'):
        result[key] = _feature_value(key,row,prediction)
    if identity is not None:
        from services.recommendation_service import calculate_ml_score, _rescale_score
        expected_edge = _rescale_score(calculate_ml_score(prediction['ensemble_v2'],prediction),30,25)/25
        if abs(result['ml_edge_norm']-expected_edge)>1e-10:
            raise ValueError('l4_distribution_ml_edge_semantic_mismatch')
    return features(result)


def missing_l3_evidence(prediction, identity, signal_date):
    """Only attested coverage gaps may abstain locally; integrity errors still fail."""
    lineage = prediction.get('model_score_lineage') or {}
    blockers = lineage.get('blockers') or []
    if (lineage.get('complete') is False and blockers
            and lineage.get('coverage_policy') == 'validated-bundle-selected-core-sequence-missingness-v1'
            and lineage.get('ensemble_payload_checksum') == identity['payload_checksum']
            and lineage.get('run_date') == signal_date
            and all(reason == 'selected_model_evidence_missing' or reason.startswith('rank_missing:')
                    for reason in blockers)):
        return list(blockers)
    return None


def distribution_policy_identity(policy,identity):
    opb={k:v for k,v in (policy.get('opb') or {'enabled':False}).items() if k!='approved_policy_identity'}
    return digest({'model':policy['artifact']['model_checksum'],'l3':identity,
                   'constraints':policy['constraints'],'opb_policy':opb,'schema':PLAN_SCHEMA})


def choose_opb(policy, ledger, identity, signal_date):
    """Native nonstationary reward estimator, backed by this policy's account.

    Reuse the existing 60-observation / 20-observation half-life estimator and
    effective-sample UCB. No fabricated prior observations or stock truncation.
    Validate every arm before cold-start or selection, including dormant arms.
    """
    from datetime import date
    from services.online_portfolio_bandit import (
        _decayed_reward_stats, _ucb_score, REWARD_WINDOW_DAYS, REWARD_HALF_LIFE_DAYS,
    )
    date.fromisoformat(signal_date)
    base = deepcopy(policy['constraints'])
    config = policy.get('opb') or {}
    if not config.get('enabled'):
        return base, {'enabled': False, 'status': 'fixed_policy', 'arm_id': 'base'}
    arms = config.get('arms') or []
    if not arms or config.get('approved_policy_identity') != identity:
        raise ValueError('l4_distribution_opb_policy_identity_missing')
    ids = [arm['id'] for arm in arms]
    if 'base' not in ids or next(arm for arm in arms if arm['id']=='base').get('constraints'):
        raise ValueError('l4_distribution_opb_base_arm_required')
    if len(ids) != len(set(ids)) or any(not isinstance(key,str) or not key for key in ids):
        raise ValueError('l4_distribution_opb_duplicate_arm')
    exploration = finite(config.get('exploration',0.), 'opb_exploration')
    if not 0 <= exploration <= 1:
        raise ValueError('l4_distribution_opb_exploration_invalid')
    policies = {}
    for arm in arms:
        overrides = arm.get('constraints') or {}
        if set(overrides) - {'risk_aversion','exposure_cap','name_cap','min_weight'}:
            raise ValueError('l4_distribution_opb_forbidden_override')
        updated = {**base, **overrides}
        for key in overrides:
            updated[key] = finite(overrides[key], 'opb_'+key)
        if (not 0 <= updated['exposure_cap'] <= base['exposure_cap']
                or not 0 < updated['name_cap'] <= base['name_cap']
                or not 0 <= updated['min_weight'] <= 1
                or finite(updated.get('risk_aversion',2.),'risk_aversion') < 0):
            raise ValueError('l4_distribution_opb_exceeds_hard_risk')
        policies[arm['id']] = updated
    rewards, seen = {key: [] for key in ids}, set()
    for item in ledger:
        if item.get('policy_identity') != identity or item.get('complete') is not True:
            continue
        known = item.get('known_date')
        if (not isinstance(known,str) or not known < signal_date
                or item.get('reward_kind') != 'complete_policy_account_net_return'
                or item.get('arm_id') not in rewards):
            raise ValueError('l4_distribution_opb_reward_contract_invalid')
        date.fromisoformat(known)
        # One closed account interval per arm/day; never count duplicate reads.
        key = (item['arm_id'],known)
        if key in seen:
            raise ValueError('l4_distribution_opb_duplicate_reward')
        seen.add(key)
        rewards[item['arm_id']].append({'known_date':known,'reward':finite(item['reward'],'opb_reward')})
    stats = {}
    for arm_id, history in rewards.items():
        stat = _decayed_reward_stats(sorted(history,key=lambda r:r['known_date']))
        stats[arm_id] = stat or {'samples':0.,'effective_samples':0.,'reward_mean':0.}
    total = sum(stat['effective_samples'] for stat in stats.values())
    evidence = {'enabled':True, 'reward_scope':'complete_policy_account',
        'reward_estimator':'sliding_window_exponential_decay',
        'window_observations':REWARD_WINDOW_DAYS, 'half_life_observations':REWARD_HALF_LIFE_DAYS,
        'samples':sum(int(stat['samples']) for stat in stats.values()),
        'effective_samples':total, 'arm_statistics':stats, 'fabricated_prior_samples':0}
    if not total:
        return base, {**evidence,'status':'cold_start_base','arm_id':'base'}
    for stat in stats.values():
        stat['ucb_score'] = _ucb_score(
            {'samples':stat['effective_samples'],'reward_mean':stat['reward_mean']},total,exploration)
    selected = max(ids,key=lambda key:(stats[key]['ucb_score'],key))
    return policies[selected], {**evidence,'status':'learned_policy','arm_id':selected}


def run(recommendations, policy, *, return_history, reward_ledger=(), evidence_sink=None, private_research=False):
    runtime = policy.get('runtime') or {}
    signal_date = runtime['signal_date']
    identity = runtime['l3_identity']
    bundle = policy['artifact']
    research = private_research and policy.get('scope') == 'private_research'
    if policy.get('scope') != 'paper' and not research:
        raise ValueError('l4_distribution_scope_invalid')
    validate_bundle(bundle,l3_identity=identity,signal_date=signal_date,require_paper_release=not research)
    account = runtime['account']
    if account.get('schema_version') != 'l4-account-context-v1' or account.get('account_id') != 1:
        raise ValueError('l4_distribution_account_contract_invalid')
    if account.get('signal_date') != signal_date or account.get('complete') is not True:
        raise ValueError('l4_distribution_account_stale_or_incomplete')
    nav = finite(account['nav'], 'nav')
    available_cash = finite(account['available_cash'], 'available_cash')
    if nav <= 0 or available_cash < 0:
        raise ValueError('l4_distribution_account_value_invalid')
    rows = deepcopy(recommendations)
    by_symbol = {row['symbol']:row for row in rows}
    if len(by_symbol) != len(rows):
        raise ValueError('l4_distribution_duplicate_candidate')
    holdings = {position['symbol']:position for position in account['holdings']}
    if len(holdings) != len(account['holdings']):
        raise ValueError('l4_distribution_duplicate_holding')
    # Held names outside the routed pool remain locked until an explicit risk or
    # next full-pool decision provides an exit. Missing alpha is never fake zero.
    locked = set(account.get('locked_symbols') or []) | (set(holdings)-set(by_symbol))
    symbols = sorted(set(by_symbol)|set(holdings))
    predictions = runtime['predictions']
    unavailable = {s: reasons for s in sorted(by_symbol)
        if (reasons := missing_l3_evidence(predictions[s], identity, signal_date))}
    # Missing evidence never authorizes liquidation or new buying. Its utility
    # coefficient is inert because zero/new or existing/held weights are fixed.
    locked.update(set(unavailable) & set(holdings))
    modeled = sorted(set(by_symbol) - set(unavailable))
    feature_rows = [{'symbol':s,'features':native_features(by_symbol[s],predictions[s],identity),
                     'l3_baseline':native_baseline(predictions[s],identity)} for s in modeled]
    outputs = dict(zip(modeled,
        [attach_baseline(output,row['l3_baseline']) for row,output in
         zip(feature_rows,predict(feature_rows,bundle['model']),strict=True)],strict=True))
    policy_identity = distribution_policy_identity(policy,identity)
    constraints, opb = choose_opb(policy,reward_ledger,policy_identity,signal_date)
    hard=account.get('risk_limits') or {}
    if hard:
        constraints['exposure_cap']=min(constraints['exposure_cap'],finite(hard['exposure_cap'],'risk_exposure'))
        constraints['name_cap']=min(constraints['name_cap'],finite(hard['name_cap'],'risk_name'))
        constraints['max_positions']=min(constraints['max_positions'] or len(symbols),int(hard['max_positions']))
        constraints['min_weight']=max(constraints['min_weight'],finite(hard['min_trade_value'],'min_trade')/nav)
        constraints.update(account['fees'])
    if not symbols:
        raise ValueError('l4_distribution_empty_pool')
    from services.l4_dated_risk import is_dated_risk,estimate_risk
    dated_risk=None
    if is_dated_risk(return_history):
        if return_history['signal_date']!=signal_date:raise ValueError('l4_risk_packet_date_mismatch')
        dated_risk=estimate_risk(return_history,symbols)
        if any(dated_risk['coverage'][s]['observations']<20 for s in holdings):
            raise ValueError('l4_risk_held_observations_insufficient')
    else:
        for symbol in symbols:
            history = return_history.get(symbol) or []
            if len(history)<20 or any(not math.isfinite(float(v)) for v in history):
                raise ValueError('l4_distribution_risk_history_missing:'+symbol)
    from services.l4_allocation_contract import risk_groups,full_l3_attribution
    constraints,groups,pressure,horizon,risk_evidence = risk_groups(symbols,return_history,by_symbol,holdings,constraints,dated_covariance_packet=dated_risk)
    covariance = np.asarray((dated_risk or ledoit_wolf_covariance(symbols,return_history,daily_vol_floor=.01))['covariance'])*horizon
    if dated_risk is not None:
        risk_evidence['dated_history']={k:v for k,v in dated_risk.items() if k not in ('covariance','graph_correlation')}

    current = [finite(holdings[s]['market_value'],'holding_value')/nav if s in holdings else 0. for s in symbols]
    # A locked holding's utility is constant, so its alpha coefficient is inert.
    gross = [outputs[s]['expected_return_gross'] if s in outputs else 0. for s in symbols]
    capital = min(1.,sum(current)+available_cash/nav)
    forbidden = set(account.get('forbidden_buys', [])) | set(unavailable)
    if dated_risk is not None:forbidden.update(dated_risk['forbidden_buys'])
    if hard.get('buys_halted'):
        forbidden.update(symbols)
    for symbol, row in by_symbol.items():
        if row.get('eligible_for_pending_buy') not in (1, True) or row.get('risk_skip') is True:
            forbidden.add(symbol)
    result = allocate(symbols=symbols,expected_gross=gross,covariance=covariance,
                      current_weights=current,capital_available=capital,name_caps={s:min(v,constraints['name_cap']) for s,v in (account.get('name_caps') or {}).items()},
                      locked_symbols=locked,forbidden_buys=forbidden,exposure_groups=groups,turnover_pressure=pressure,**constraints)
    attribution=full_l3_attribution(by_symbol,predictions,outputs,feature_rows,unavailable=unavailable)
    plan = {'schema_version':PLAN_SCHEMA,'owner':OWNER,'signal_date':signal_date,
            'execution_scope':'private_research' if research else 'paper',
            'account_id':1,'account_anchor':account.get('account_anchor'),'parent_plan_id':account.get('active_plan_id'),'account_checksum':digest(account),'policy_identity':policy_identity,
            'model_checksum':bundle['model_checksum'],'l3_identity':identity,'nav_at_decision':nav,
            'opb':{**opb,'candidate_feature_summary':attribution['opb_candidate_summary']},
            'input_attribution':attribution,'risk_evidence':risk_evidence,
            'prediction_coverage':{'available':len(modeled),'candidate_count':len(by_symbol),
                                   'unavailable':unavailable},
            'forbidden_buys':sorted(forbidden),**result,'targets':{s:{'weight':result['weights'][s],
                'current_weight':current[i],'locked':s in locked,
                'expected_return_gross':outputs[s]['expected_return_gross'] if s in outputs else None,
                'distribution':outputs.get(s)}
                for i,s in enumerate(symbols)}}
    plan['plan_id']=digest(plan)
    rank = {s:i+1 for i,s in enumerate(sorted(symbols,key=lambda s:(-result['weights'][s],s)))}
    for row in rows:
        symbol=row['symbol'];weight=result['weights'][symbol]
        old_advice=row.get('ml_advisory') or {'signal':row.get('signal'),'role':'advisory_only'}
        selected=weight>1e-7 and symbol not in unavailable
        output=outputs.get(symbol)
        expected=output['expected_return_gross'] if output else None
        row.update(ml_advisory=old_advice, signal='BUY' if selected else 'HOLD',
                   signal_source='sparse_tangent_inverse_risk',has_buy_signal=int(selected),
                   sparse_tangent_selected=selected,allocation_weight=weight,
                   l4_distribution=output)
        row['alpha_allocation']={'engine':'sparse_tangent_inverse_risk','schema_version':PLAN_SCHEMA,
            'expected_return_owner':OWNER,'expected_return':expected,
            'expected_return_semantic':'five_session_gross_decimal','expected_return_source':SCHEMA,
            'selected':selected,'allocation_weight':weight,'allocation_rank':rank[symbol],
            'selection_reason':'l3_evidence_unavailable' if symbol in unavailable else 'portfolio_target' if selected else 'portfolio_cash_or_other_assets',
            'prediction_blockers':unavailable.get(symbol,[]),
            'plan_id':plan['plan_id'],'policy_identity':policy_identity,'opb_controller':opb,
            'l4_distribution':output}
        row.setdefault('score_components',{})['mlAdvisory']=old_advice
    if rows:
        rows[0]['_l4_portfolio_plan']=plan
    if evidence_sink:
        evidence_sink({'schema_version':'formal-sparse-allocation-capture-v1',
                       'effective_weights':result['weights'],'portfolio_plan':plan,
                       'candidate_symbols':symbols,'expected_return_owner':OWNER,
                       'inherited_state':{},'status':'allocated'})
    return rows
