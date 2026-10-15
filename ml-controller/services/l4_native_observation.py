"""Prospective, full-pool observations. No Router or trading publication."""
from copy import deepcopy
from datetime import datetime,timezone
import hashlib,json,os
from services.l4_forward_materialization import digest,timestamp
from services.l4_forward_refresh import NATIVE_POOL,publish

PREFIX='l4_distribution/native_observations/v1/'
SCOPE='l4-native-pool-observation-v1'


def daily_roster(day):
    """Use dated listing membership from the original snapshot, before inference."""
    from services.dataset_snapshots import latest_dataset_snapshot
    from services.training_snapshot_integrity import verify_snapshot_manifest
    from services.training_stock_roster import select_training_stock_rows
    from routers.retrain_trigger import _read_gcs_parquet_rows
    snapshot=latest_dataset_snapshot(kind='backtest_dataset',access_tier='compute',business_date=day)
    if not snapshot or snapshot.get('manifest_errors'):raise ValueError('l4_native_roster_snapshot_missing')
    components=verify_snapshot_manifest(snapshot,business_date=day)
    component=components['stocks']
    rows=list(_read_gcs_parquet_rows(component['gcs_uri'],integrity_meta=component))
    roster=select_training_stock_rows(rows,start_date=day,end_date=day)
    selected={r['symbol'] for r in roster}
    exclusions=[dict(symbol=r['symbol'],market=r['market'],listed_date=r.get('listed_date'),
        delisted_date=r.get('delisted_date'),reason='outside_signal_date_listing_or_venue')
        for r in rows if r['symbol'] not in selected]
    return roster,dict(component=component,source_row_count=len(rows),roster_checksum=digest(roster),
        policy='verified_snapshot_listing_membership_at_signal_date',exclusions=exclusions)


def read_reference(bucket,reference):
    raw=bucket.blob(reference['path']).download_as_bytes()
    if hashlib.sha256(raw).hexdigest()!=reference['sha256']:
        raise ValueError('l4_native_reference_hash')
    return json.loads(raw)


def training_cutoffs(context,identity,records):
    """Derive upper bounds from checksum-bound deployed model metadata."""
    manifest=context['serving_manifest'];parent=manifest['active8_ensemble']
    models={r['model']:r for r in manifest['models']}
    if set(records)!=set(parent['model_order']):raise ValueError('l4_native_training_metadata_incomplete')
    dates={'L3':parent['knowledge_cutoff_date']}
    for name,body in records.items():
        row=models[name];checksum=body.get('artifact_checksum') or body.get('checksum','')
        fit=body.get('deployment_fit') or {};att=body.get('model_training_config_attestation') or {}
        if (checksum.removeprefix('sha256:')!=row['checksum'].removeprefix('sha256:')
                or fit.get('performed') is not True or fit.get('validation_models_are_not_served') is not True
                or att.get('input_lineage',{}).get('source_manifest_checksum')!=parent['source_manifest_checksum']):
            raise ValueError('l4_native_training_metadata_binding')
        known=fit.get('label_known_date_max') or fit.get('training_label_known_max')
        if known is None:
            # Sequence full-panel training consumes only this verified calendar.
            panel=body.get('deployment_training_panel') or {}
            known=panel.get('calendar_end')
            if (name not in ('PatchTST','iTransformer') or panel.get('training_history_mode')!='full_pit_history'
                    or known!=body.get('date_max') or known!=att.get('run_date')):
                raise ValueError('l4_native_training_cutoff_missing')
        if known>parent['knowledge_cutoff_date']:raise ValueError('l4_native_training_after_parent')
        dates[name]=known
    return dates


def validate_context(context,identity,cutoffs,day,records):
    """Cutoffs are sealed release evidence, including every base and L3 fit."""
    from services.alpha_model_roster import validate_order
    from services.frozen_manifest_budget import canonical_manifest_bytes
    from services.ensemble_v2 import ensemble_artifact_id
    manifest=context['serving_manifest'];parent=manifest['active8_ensemble']
    if (context.get('schema_version')!='pipeline-modal-serving-context-v1'
            or hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()!=context.get('serving_manifest_digest')
            or ensemble_artifact_id(parent)!=identity.get('artifact_id')
            or any(parent.get(k)!=identity.get(k) for k in
                ('payload_checksum','cohort_id','base_artifact_set_checksum'))):
        raise ValueError('l4_native_pinned_l3_identity')
    order=validate_order(parent['model_order'])
    if (cutoffs.get('l3_identity')!=identity or set(cutoffs.get('label_known_max',{}))!=set(order)|{'L3'}
            or cutoffs.get('base_artifact_set_checksum')!=identity['base_artifact_set_checksum']
            or not cutoffs.get('source_references')
            or cutoffs['label_known_max']!=training_cutoffs(context,identity,records)):
        raise ValueError('l4_native_training_cutoff_evidence')
    for value in cutoffs['label_known_max'].values():
        if datetime.strptime(value,'%Y-%m-%d').date().isoformat()!=value or value>=day:
            raise ValueError('l4_native_model_after_signal')
    return max(cutoffs['label_known_max'].values())


def projection(predictions,*,identity,day,roster,classification,known_max):
    from services.l4_distribution_runtime import native_features,missing_l3_evidence
    from services.l4_distribution import feature_schema,feature_order
    from services.l4_l3_baseline import native_baseline
    from services.recommendation_service import calculate_ml_score,_rescale_score
    symbols=[r['symbol'] for r in roster]
    if len(symbols)!=len(set(symbols)) or set(symbols)!=set(predictions):
        raise ValueError('l4_native_full_inference_coverage')
    accepted=classification['accepted_evidence'];excluded=classification['excluded_symbols']
    rejected={r['symbol'] for r in excluded}
    if (not accepted or any(not v['cfi'].startswith(('ES','ED')) for v in accepted.values())
            or any(r['instrument_type']!='etf' for r in excluded)
            or len(rejected)!=len(excluded) or set(accepted)&rejected
            or set(symbols)-(set(accepted)|rejected)):
        raise ValueError('l4_native_classification_incomplete')
    # L3 already ranked the complete source pool by venue. Classify afterwards,
    # matching the original native OOF feature semantics exactly.
    rows=[]
    for symbol in sorted(set(symbols)&set(accepted)):
        prediction=predictions[symbol]
        if prediction.get('error') or missing_l3_evidence(prediction,identity,day):
            raise ValueError('l4_native_incomplete_core_evidence')
        edge=_rescale_score(calculate_ml_score(prediction['ensemble_v2'],prediction),30,25)
        features=native_features({'score_components':{'components':{'mlEdge':edge}}},prediction,identity)
        # Native OOF excludes rows without all five core models. Do not turn an
        # unobserved/error row into a smaller, purported full-pool prediction.
        from services.alpha_model_roster import validate_order
        order=validate_order(prediction['ensemble_v2']['model_order'])
        if any(features[name+'_available']!=1 for name in order[:5]):
            raise ValueError('l4_native_incomplete_core_evidence')
        rows.append(dict(symbol=symbol,features=features,l3_baseline=native_baseline(prediction,identity)))
    if not rows:raise ValueError('l4_native_empty_equity_pool')
    return dict(signal_date=day,feature_rows=rows,features_checksum=digest(rows),
        eligible_symbols=[r['symbol'] for r in rows],l3_identity=identity,
        pool_contract=NATIVE_POOL,feature_schema=feature_schema(feature_order(rows[0]['features'])),
        l3_training_label_known_max=known_max,coverage_exclusions=[],original_prediction_count=len(predictions))


def discover(bucket,*,start,end,cutoff):
    """Verify immutable capture and server creation time before admitting it."""
    found=[]
    for blob in bucket.list_blobs(prefix=PREFIX+'index/'):
        if not blob.name.endswith('.json'):continue
        ref=json.loads(blob.download_as_bytes(if_generation_match=blob.generation))
        snapshot=read_reference(bucket,ref)
        if not start<=snapshot['signal_date']<=end:continue
        original_ref=snapshot['original_reference'];original=read_reference(bucket,original_ref)
        origin=bucket.blob(original_ref['path']);origin.reload()
        if origin.time_created is None:raise ValueError('l4_native_server_clock_missing')
        if origin.time_created>timestamp(cutoff):continue
        if (snapshot['original_sha256']!=original_ref['sha256']
                or original['projection']!={k:v for k,v in snapshot.items() if k not in
                    ('snapshot_id','original_reference','original_sha256','verified_original_sha256','frozen_at')}
                or original['scope']!=SCOPE):
            raise ValueError('l4_native_projection_binding')
        # Server time is authoritative. A caller cannot backdate a capture.
        snapshot['frozen_at']=max(origin.time_created,timestamp(snapshot['frozen_at'])).isoformat()
        found.append((snapshot,ref))
    return found


async def prepare(*,bucket,config,day,context,key):
    """Freeze inputs once; a lost acknowledgement requires explicit recovery."""
    import asyncio
    from google.api_core.exceptions import PreconditionFailed
    from graphs import daily_pipeline_v2 as pipeline
    from services.payload_builder import capture_payload_sources,load_market_env
    from dataclasses import asdict
    import re
    source_sha=os.environ.get('STOCKVISION_SOURCE_SHA','')
    if not re.fullmatch('[a-f0-9]{40}',source_sha):raise ValueError('l4_native_source_version_missing')
    claim=bucket.blob(PREFIX+'claims/'+key+'.json')
    if claim.exists():raise ValueError('l4_native_existing_dispatch_requires_recovery')
    roster,roster_proof=await asyncio.to_thread(daily_roster,day)
    from services.l4_instrument_classification import capture,select
    catalog,catalog_ref=await asyncio.to_thread(capture,bucket,day)
    roster,classification,listing_exclusions=select(roster,catalog,day)
    roster_proof.update(official_listing=catalog_ref,official_listing_exclusions=listing_exclusions,
        inference_roster_checksum=digest(roster))
    if not 1<=len(roster)<=5000:raise ValueError('l4_native_capacity_exceeded')
    context=deepcopy(context)
    context['expected_source_sha']=source_sha
    sources=await asyncio.to_thread(capture_payload_sources,roster,day)
    market,adaptive,barriers,lifecycle,trading=await asyncio.to_thread(load_market_env,day)
    state=dict(run_date=day,producer_run_id='l4-native:'+key,active_stocks=roster,
        market_env=asdict(market),payload_source_observations=sources,trading_config=trading,
        adaptive_params=adaptive,barrier_params=barriers,lifecycle_weights=lifecycle,
        pipeline_modal_serving_context=context)
    state.update(await pipeline.node_build_payloads(state))
    try:
        claim.upload_from_string(json.dumps(dict(day=day,configuration_checksum=digest(config),
            source_checksum=state['payload_source_observations']['source_checksum'])),if_generation_match=0)
    except PreconditionFailed:
        raise ValueError('l4_native_existing_dispatch_requires_recovery')
    # Frozen L2 model/policy, with this observation's date; never select latest.
    l2=deepcopy(read_reference(bucket,config['timesfm_context']))
    l2['signal_date']=day
    from services.paired_nav_journal import digest as pipeline_digest
    l2['source_checksum']=pipeline_digest({k:v for k,v in l2.items() if k!='source_checksum'})
    state['pipeline_timesfm_context']=l2
    state.update(await pipeline._node_l2_timesfm_enrich(state))
    if state['timesfm_l2_summary']['status']!='ready':raise ValueError('l4_native_l2_not_ready')
    request=await pipeline._build_pipeline_modal_prediction_payload(state,state_gcs_uri='',research_only=True)
    request.update(execution_scope=SCOPE,max_symbols=5000)
    from services.l4_risk_history import load_canonical_risk_payloads
    from services.l4_dated_risk import build_dated_risk
    from services.recommendation_service import gnn_return_history_lookback
    lookback=gnn_return_history_lookback()
    risk_payloads=await asyncio.to_thread(load_canonical_risk_payloads,
        payloads=request['payloads'],held_payloads=[],signal_date=day,lookback=lookback,
        capture_source=request['timexer_feature_source'],bucket=bucket)
    risk_reference=publish(bucket,'native_risk',build_dated_risk(risk_payloads,signal_date=day,lookback=lookback))
    request_ref=publish(bucket,'native_requests',request)
    envelope=publish(bucket,'native_envelopes',dict(request=request_ref,roster=roster,
        roster_proof=roster_proof,classification=classification,catalog_reference=catalog_ref,risk_reference=risk_reference))
    bucket.blob(PREFIX+'requests/'+key+'.json').upload_from_string(json.dumps(envelope),if_generation_match=0)
    return envelope


async def collect(*,bucket,config,day,spawn=None,poll=None):
    """Resume the same frozen inference across bounded Cloud Run invocations."""
    from graphs import daily_pipeline_v2 as pipeline
    from services.l4_native_dispatch import advance
    identity=config['l3_identity']
    context=read_reference(bucket,config['serving_context'])
    cutoffs=read_reference(bucket,config['training_cutoffs'])
    records={r['model']:read_reference(bucket,r['reference']) for r in cutoffs.get('source_references',[])}
    known=validate_context(context,identity,cutoffs,day,records)
    key=digest(dict(day=day,identity=identity,policy=config))
    index=bucket.blob(PREFIX+'index/'+key+'.json')
    if index.exists():return dict(status='captured',projection=json.loads(index.download_as_bytes()),reused=True)
    request_index=bucket.blob(PREFIX+'requests/'+key+'.json')
    envelope_ref=(json.loads(request_index.download_as_bytes()) if request_index.exists() else
        await prepare(bucket=bucket,config=config,day=day,context=context,key=key))
    envelope=read_reference(bucket,envelope_ref)
    request_ref=envelope['request'];request=read_reference(bucket,request_ref)
    dispatched=await advance(bucket,key,envelope_ref,request,request_ref=request_ref,spawn=spawn,poll=poll)
    if dispatched['status']=='pending':return dispatched
    bundle=dispatched['result']
    context=deepcopy(context);context['expected_source_sha']=request['expected_source_sha']
    state=dict(run_date=day,producer_run_id=request['run_id'],payloads=request['payloads'],
        pipeline_modal_serving_context=context,
        pipeline_modal_sequence_input_contract=request['sequence_input_contract'])
    roster=envelope['roster'];classification=envelope['classification']
    if bundle.get('execution_scope')!=SCOPE:raise ValueError('l4_native_output_scope')
    state['modal_prediction_bundle']=bundle
    pipeline._validate_pipeline_modal_feature_bundle_before_writes(state,bundle)
    merged=await pipeline.node_ml_predict(state,research_only=True)
    projected=projection(merged['predictions'],identity=identity,day=day,roster=roster,
        classification=classification,known_max=known)
    original=publish(bucket,'native_originals',dict(scope=SCOPE,projection=projected,
        request=request_ref,raw_bundle_reference=dispatched['reference'],classification=envelope['catalog_reference'],
        risk_reference=envelope['risk_reference'],
        roster_checksum=digest(roster),roster_proof=envelope['roster_proof'],training_cutoffs=config['training_cutoffs']))
    frozen=datetime.now(timezone.utc).isoformat()
    snapshot=dict(projected,snapshot_id='l4-native:'+key,frozen_at=frozen,
        original_reference=original,original_sha256=original['sha256'],verified_original_sha256=original['sha256'])
    reference=publish(bucket,'native_projections',snapshot)
    from google.api_core.exceptions import PreconditionFailed
    try:index.upload_from_string(json.dumps(reference,sort_keys=True),if_generation_match=0)
    except PreconditionFailed:
        # Concurrent continuations may finish the same immutable output.
        prior=json.loads(index.download_as_bytes())
        previous=read_reference(bucket,prior)
        if previous['original_reference']!=original:raise ValueError('l4_native_projection_conflict')
        reference=prior;snapshot=previous
    if read_reference(bucket,reference)!=snapshot:raise ValueError('l4_native_readback')
    return dict(status='captured',projection=reference,reused=False,training_dispatched=False,promoted=False)
