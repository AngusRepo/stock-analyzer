"""Preserve native sparse controls and full L3 evidence at the new boundary."""
from copy import deepcopy
from collections import defaultdict
from services.l4_distribution import finite,digest
from services.similarity_evidence import similarity_components

UNKNOWN = {'','UNKNOWN','UNCLASSIFIED','NONE','NULL'}

def risk_groups(symbols,history,rows,holdings,constraints, *, dated_covariance_packet=None):
    knobs = deepcopy(constraints)
    cluster_cap = finite(knobs.pop('max_cluster_weight',.55),'max_cluster_weight')
    sector_cap = knobs.pop('sector_concentration_cap',.5)
    threshold = knobs.pop('cluster_edge_threshold',None)
    quantile = finite(knobs.pop('cluster_threshold_quantile',.9),'cluster_threshold_quantile')
    if not 0 <= cluster_cap <= 1 or not 0 <= quantile <= 1:
        raise ValueError('l4_native_cluster_controls_invalid')
    if threshold is not None and not 0 <= finite(threshold,'cluster_threshold') <= 1:
        raise ValueError('l4_native_cluster_controls_invalid')
    if sector_cap is not None and not 0 <= finite(sector_cap,'sector_cap') <= 1:
        raise ValueError('l4_native_sector_control_invalid')
    similarity = similarity_components(symbols,history,edge_threshold=threshold,
        threshold_quantile=quantile,daily_vol_floor=.01,min_observations=20,dated_covariance_packet=dated_covariance_packet)
    groups = {'cluster:'+group['cluster_id']:{'symbols':group['symbols'],'cap':cluster_cap}
              for group in similarity['clusters']}
    sectors,unknown = defaultdict(list),[]
    for symbol in symbols:
        sector = str((rows.get(symbol) or holdings.get(symbol) or {}).get('sector') or '').strip().upper()
        if sector in UNKNOWN:unknown.append(symbol)
        else:sectors[sector].append(symbol)
    if sector_cap is not None:
        groups.update({'sector:'+sector:{'symbols':members,'cap':sector_cap} for sector,members in sectors.items()})
    pressure=[]
    for symbol in symbols:
        row=rows.get(symbol) or {}
        value=next((row[k] for k in ('turnover_pressure','turnover','expected_turnover') if row.get(k) is not None),0.)
        pressure.append(max(0.,finite(value,'turnover_pressure')))
    knobs.setdefault('risk_aversion',2.)
    knobs.setdefault('alpha_strength',1.)
    knobs.setdefault('turnover_penalty',0.)
    knobs.setdefault('l2_penalty',0.)
    horizon=knobs.pop('covariance_horizon_sessions',5)
    if type(horizon) is not int or horizon not in (1,5):
        raise ValueError('l4_covariance_horizon_invalid')
    evidence={'similarity':similarity,'sector_by_symbol':{s:k for k,v in sectors.items() for s in v},
        'sector_unknown_symbols':unknown,'max_cluster_weight':cluster_cap,'sector_concentration_cap':sector_cap,
        'covariance_horizon_sessions':horizon,'constraints_owner':'same_full_pool_optimizer',
        'turnover_pressure_by_symbol':dict(zip(symbols,pressure))}
    return knobs,groups,pressure,horizon,evidence


def full_l3_attribution(rows,predictions,outputs,feature_rows,*,model_feature_names,unavailable=None):
    """Preserve full upstream packets; modeling and audit roles stay explicit."""
    ordered=sorted(rows)
    feature_by_symbol={row['symbol']:row['features'] for row in feature_rows}
    packet={'schema_version':'l4-full-l3-input-attribution-v1',
        'model_feature_names':list(model_feature_names),'model_feature_count':len(model_feature_names),
        'unmodeled_fields_role':'retained_for_audit_no_implicit_extra_alpha',
        'candidates':{s:{'native_prediction':deepcopy(predictions[s]),
            'model_features':deepcopy(feature_by_symbol.get(s)),
            'prediction_blockers':(unavailable or {}).get(s,[]),
            'l4_distribution':deepcopy(outputs.get(s)),
            'candidate_metadata':{k:deepcopy(rows[s].get(k)) for k in
                ('sector','allocator_edge_quality_score','conditional_admission_allowed','s12_target_quality_state',
                 'turnover_pressure','market_segment','recommendation_lane','eligible_for_pending_buy')}} for i,s in enumerate(ordered)}}
    from services.online_portfolio_bandit import _candidate_feature_summary
    candidates=[{**rows[s],'expected_return':outputs[s]['expected_return_gross']} for s in ordered if s in outputs]
    packet['opb_candidate_summary']=_candidate_feature_summary(candidates,utility_field='expected_return',
        utility_semantic='five_session_gross_decimal')
    # Full packets are already sealed in the chunked allocation snapshot.
    # Keep a verifiable index in the Paper plan instead of duplicating megabytes.
    packet['upstream_snapshot_path']='content.inputs.alpha_policy.l4Distribution.runtime.predictions'
    packet['candidate_input_checksums']={symbol:digest(value) for symbol,value in packet.pop('candidates').items()}
    packet['native_predictions_checksum']=digest({s:predictions[s] for s in ordered})
    packet['checksum']=digest(packet)
    return packet


def inherited_sparse_controls(config):
    """Resolve the original allocation controls before evaluating a cutover.

    Daily covariance is explicit for matched-config comparisons. A five-session
    covariance change requires its own evaluated configuration, never a default.
    """
    allocation=(config.get('alphaFramework') or {}).get('allocation') or {}
    aliases={'alpha_strength':('alphaStrength',1.),'risk_aversion':('riskAversion',2.),
        'turnover_penalty':('turnoverPenalty',0.),'l2_penalty':('l2Penalty',0.),
        'max_cluster_weight':('maxClusterWeight',allocation.get('max_weight',allocation.get('maxWeight',.55))),
        'cluster_edge_threshold':('clusterEdgeThreshold',None),
        'cluster_threshold_quantile':('clusterThresholdQuantile',.9),
        'sector_concentration_cap':('sectorConcentrationCap',.5)}
    values={}
    for key,(alias,default) in aliases.items():
        raw=allocation.get(key,allocation.get(alias,default))
        values[key]=None if raw is None and key in ('cluster_edge_threshold','sector_concentration_cap') else finite(raw,key)
    values['covariance_horizon_sessions']=1
    return values


def native_opb_policy(constraints):
    """Migrate ALL native arm knobs, with a neutral cold-start base and no priors.

    Cash/name/floor constraints enter the same optimizer. Legacy candidate caps
    stay descriptive; post-optimization rescaling and stock truncation are gone.
    """
    from services.online_portfolio_bandit import DEFAULT_ARMS
    return {'enabled':True,'exploration':.05,'arms':[{'id':'base','constraints':{}}]+[
        {'id':arm.arm_id,'constraints':{
            'exposure_cap':min(constraints['exposure_cap'],1-arm.cash_buffer),
            'name_cap':min(constraints['name_cap'],arm.max_weight),
            'min_weight':max(constraints['min_weight'],arm.min_trade_weight)}} for arm in DEFAULT_ARMS],
        'migration':{'source':'online_portfolio_bandit.DEFAULT_ARMS','source_arm_count':len(DEFAULT_ARMS),
            'legacy_candidate_caps_ignored':{arm.arm_id:arm.candidate_cap for arm in DEFAULT_ARMS},
            'static_and_old_owner_prior_samples_imported':0,'hard_risk_overrides_arm_caps':True,
            'cash_buffer_role':'exposure_ceiling_not_forced_investment',
            'minimum_weight_role':'joint_optimizer_constraint_not_posthoc_pool_truncation'}}


def initial_paper_constraints(config):
    """Preserve live risk limits, evaluated against actual NAV on every plan.

    A neutral policy envelope must not freeze one day's exposure or a 30k
    minimum as an arbitrary 3% forever. Account risk limits tighten it at run.
    """
    return {**inherited_sparse_controls(config), 'exposure_cap':1.,
        'name_cap':finite(config['position']['maxPctOfPortfolio'],'configured_name_cap'),
        'min_weight':0.,'max_positions':config['position']['maxPositions'],
        'buy_cost':config['fees']['commission'],
        'sell_cost':config['fees']['commission']+config['fees']['tax']}
