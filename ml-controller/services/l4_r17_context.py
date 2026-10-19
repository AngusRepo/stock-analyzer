"""Bind the archived daily slate to frozen full-pool predictions and dated risk."""
from copy import deepcopy
from services.l4_distribution import digest as model_digest
from services.paired_nav_journal import digest, read_snapshot, _timestamp
from services.l4_r16_allocation import allocation_policy

CONTEXT_FIELDS=('inputs','risk_config','formal_output','recommendation_context.inputs.screener_recs')


def read_original_context(query,snapshot_id):
    """Hash-verify all original bytes; materialize only the fields P4 consumes.

    Formal contexts also contain GB-scale feature/payload histories. Those are
    not R17 inputs: reading them all into memory adds no provenance assurance.
    The cold reader verifies the complete uncompressed checksum before return.
    """
    rows=query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',[snapshot_id])
    if len(rows)!=1:raise ValueError('r17_canonical_pipeline_context_pending')
    manifest=rows[0]
    from services.paired_nav_cold import load
    prefixes={'schema_version','signal_date','source_run_id','snapshot_kind'}|{'content.'+f for f in CONTEXT_FIELDS}
    payload=load(query,manifest,prefixes=frozenset(prefixes))
    if payload is None:return read_snapshot(query,snapshot_id)
    if any(payload.get(k)!=manifest[k] for k in ('signal_date','source_run_id','snapshot_kind')):
        raise ValueError('r17_canonical_projection_identity')
    return {'manifest':manifest,'payload':payload,'r17_projection_proof':{
        'schema':'r17-full-source-verified-projection-v1','fields':list(CONTEXT_FIELDS),
        'original_payload_checksum':manifest['payload_checksum'],'projection_checksum':digest(payload)}}


def canonical_context(*, day, ops_query, learning_query):
    rows=ops_query("SELECT canonical_run_id,status FROM pipeline_stage_runs "
        "WHERE business_date=? AND stage='pipeline_execution'",[day])
    if len(rows)!=1 or rows[0]['status'] not in ('success','completed'):
        raise ValueError('r17_canonical_pipeline_context_pending')
    run_id=rows[0]['canonical_run_id']
    if not run_id:raise ValueError('r17_canonical_pipeline_context_pending')
    # Exact canonical parent, never the latest arbitrary allocation/research row.
    saved=read_original_context(learning_query,digest(['allocation_context',day,run_id]))
    if saved['manifest']['source_run_id']!=run_id:
        raise ValueError('r17_canonical_parent_changed')
    return saved


def prepare(*, saved, observation, forecast, predictions, risk, configuration, frozen_policy):
    manifest=saved['manifest'];source=saved['payload']['content'];day=forecast['signal_date']
    proof=saved.get('r17_projection_proof')
    if proof is not None:
        verified=(proof=={'schema':'r17-full-source-verified-projection-v1','fields':list(CONTEXT_FIELDS),
            'original_payload_checksum':manifest['payload_checksum'],'projection_checksum':digest(saved['payload'])})
    else:verified=digest(saved['payload'])==manifest['payload_checksum']
    if (manifest['snapshot_kind']!='allocation_context' or manifest['prospective']!=1
            or manifest['signal_date']!=day or 'formal_output' not in source
            or not verified):
        raise ValueError('r17_original_allocation_context_invalid')
    original=deepcopy(source['inputs'])
    policy=deepcopy(frozen_policy)
    current=original['alpha_policy']['l4Distribution']
    if model_digest(allocation_policy(current))!=model_digest(allocation_policy(policy)):
        raise ValueError('r17_allocator_policy_changed')
    if (risk.get('schema_version')!='l4-dated-risk-v1' or risk['signal_date']!=day
            or risk['checksum']!=model_digest({k:v for k,v in risk.items() if k!='checksum'})):
        raise ValueError('r17_dated_risk_binding')
    if source['risk_config']!=configuration['risk_config']:
        raise ValueError('r17_frozen_risk_configuration_changed')
    pool=set(forecast['symbols']);features={r['symbol']:r['features'] for r in observation['rows']}
    if not pool<=set(predictions) or pool!=set(features):
        raise ValueError('r17_frozen_predictions_coverage')
    seeds=deepcopy(source['recommendation_context']['inputs']['screener_recs'])
    if len({r['symbol'] for r in seeds})!=len(seeds):
        raise ValueError('r17_duplicate_original_slate')
    original_slate_checksum=digest(seeds)
    for seed in seeds:
        if seed.get('date')!=day:
            raise ValueError('r17_original_slate_date')
        # The archived recommendation projection omits the DB insert timestamp.
        # Serializer metadata uses the original context's actual freeze clock;
        # admission still depends on server-time preopen target receipts.
        if not seed.get('created_at'):seed['created_at']=manifest['frozen_at']
    seed_symbols={r['symbol'] for r in seeds}
    recs=deepcopy(original['recommendations'])
    if set(r['symbol'] for r in recs)-seed_symbols:
        raise ValueError('r17_recommendations_outside_original_slate')
    excluded=sorted(r['symbol'] for r in recs if r['symbol'] not in pool)
    recs=[r for r in recs if r['symbol'] in pool]
    from services.l4_distribution_runtime import native_features
    from services.recommendation_service import calculate_ml_score, _rescale_score
    for row in recs:
        row.pop('_l4_portfolio_plan',None)
        prediction=predictions[row['symbol']]
        # Same original candidate membership/non-ML inputs in all four arms.
        # mlEdge must come from the frozen full-pool rank semantics, rather than
        # combining full-pool TabPack features with the live narrow-pool ranks.
        row.setdefault('score_components',{}).setdefault('components',{})['mlEdge']=_rescale_score(
            calculate_ml_score(prediction['ensemble_v2'],prediction),30,25)
        if model_digest(native_features(row,prediction,observation['l3_identity']))!=model_digest(features[row['symbol']]):
            raise ValueError('r17_original_prediction_feature_binding')
    policy['scope']='private_research'
    policy['r16_binding']={k:forecast[k] for k in ('model_checksum','upstream_checksum','calibration_checksum')}
    policy['r16_binding']['allocation_policy_checksum']=model_digest(allocation_policy(policy))
    policy['runtime']={**deepcopy(current['runtime']),'signal_date':day,
        'l3_identity':deepcopy(observation['l3_identity']),'predictions':deepcopy(predictions)}
    policy.pop('_account_rewards',None)
    original['recommendations']=recs
    original['alpha_policy']['l4Distribution']=policy
    original['return_history']=deepcopy(risk)
    # Native private execution reads each arm's own reward ledger at solve time.
    original['opb_reward_ledger']=[]
    return {'allocation_inputs':original,'seed_rows':seeds,'model_predictions':predictions,
            'source_evidence':{'canonical_snapshot_id':manifest['snapshot_id'],
                'canonical_payload_checksum':manifest['payload_checksum'],
                'original_slate_checksum':original_slate_checksum,'serialized_slate_checksum':digest(seeds),
                'created_at_fallback_source':'original_context_frozen_at_serializer_metadata_only',
                'excluded_slate_symbols':excluded,
                'replacement_candidates':[],'risk_checksum':risk['checksum'],
                'prediction_checksum':digest(predictions),
                'feature_source':'frozen_full_pool_predictions_all_four_arms'}}
