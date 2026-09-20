"""TimeXer OOF/full-fit adapter. Publishes immutable candidate files only."""
from __future__ import annotations

from datetime import date, timedelta
import hashlib
import io
import json
from pathlib import Path
import tempfile
import time

from .timexer_contract import ARCHITECTURE, OFFICIAL_COMMIT, SCHEMA, SCORE_SEMANTIC


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def materialize_inputs(bucket, payload, directory):
    """Verify identities before fitting; downloads one compressed shard at a time."""
    snapshot = payload['dataset_snapshot']
    manifest = json.loads(bucket.blob(snapshot['manifest_path']).download_as_bytes())
    from .canonical_adjusted_prep import _manifest_checksum, _sequence_manifest_checksum
    if (manifest.get('manifest_checksum') != _manifest_checksum(manifest)
            or manifest['manifest_checksum'] != snapshot['manifest_checksum']
            or manifest.get('schema_version') != 'active8-canonical-adjusted-prep-v3'
            or manifest.get('status') != 'ready'
            or manifest.get('source_feature_date_max','') > payload['run_date']):
        raise ValueError('timexer_training_manifest_invalid')
    feature_prefix = manifest['source_gcs_prefix']
    receipt = json.loads(bucket.blob(feature_prefix+'/prep/immutable_receipt.json').download_as_bytes())
    raw = json.dumps({k:v for k,v in receipt.items() if k != 'receipt_checksum'}, sort_keys=True).encode()
    if (hashlib.sha256(raw).hexdigest() != manifest['source_receipt_checksum']
            or receipt.get('receipt_checksum') != manifest['source_receipt_checksum']
            or receipt.get('output_checksums') != manifest['source_checksums']
            or receipt.get('feature_semantic_version') != 'formal137-pit-asof-source-quality-v3'):
        raise ValueError('timexer_training_feature_source_invalid')
    from .features import FEATURE_COLS
    names = json.loads(bucket.blob(feature_prefix+'/prep/feature_names.json').download_as_bytes())
    if names != list(FEATURE_COLS) or len(names) != 137:
        raise ValueError('timexer_training_feature_order_invalid')
    sequence_prefix = manifest['sequence_gcs_prefix']
    sequence = json.loads(bucket.blob(sequence_prefix+'/prep/sequence_manifest.json').download_as_bytes())
    if (sequence.get('manifest_checksum') != _sequence_manifest_checksum(sequence)
            or sequence['manifest_checksum'] != manifest['sequence_manifest_checksum']
            or sequence.get('contract') != 'sequence_records_v3'
            or sequence.get('status') != 'ready'):
        raise ValueError('timexer_training_sequence_source_invalid')
    for local, source in [('features-ready',receipt),('sequence',sequence)]:
        for path, checksum in source['output_checksums'].items():
            if not path.endswith('.npz'):
                continue
            raw = bucket.blob(path).download_as_bytes()
            if hashlib.sha256(raw).hexdigest() != checksum:
                raise ValueError('timexer_training_shard_changed:'+path)
            target = directory/local/'prep'/Path(path).name
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(raw)
    # The canonical target owner fixes market membership; derive it from its
    # checksum-bound output, not a mutable market-map side file.
    import numpy as np
    markets, eligible_by_date = {}, {}
    for path, checksum in manifest['output_checksums'].items():
        if not path.endswith('.npz'):
            continue
        raw = bucket.blob(path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != checksum:
            raise ValueError('timexer_training_canonical_shard_changed')
        with np.load(io.BytesIO(raw),allow_pickle=True) as shard:
            symbols, values = shard['symbols'].astype(str), shard['markets'].astype(str)
            days, counts = np.unique(shard['dates'].astype(str),return_counts=True)
            for day, count in zip(days,counts):
                eligible_by_date[day] = eligible_by_date.get(day,0)+int(count)
        for symbol, market in set(zip(symbols,values)):
            if symbol in markets and markets[symbol] != market:
                raise ValueError('timexer_training_market_membership_changed')
            markets[symbol] = market
    target = directory/'canonical/prep/symbol_market.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(markets),encoding='utf-8')
    return manifest, eligible_by_date


def run(payload, *, bucket=None):
    import torch
    from .model_store import _get_bucket
    from .timexer_training import train
    from .training_policy import build_model_feature_policy_metadata, build_model_training_config_attestation
    from .sequence_training import SEQUENCE_RETURN_SEMANTIC_VERSION
    bucket = bucket if bucket is not None else _get_bucket()
    started = time.monotonic()
    from .oof_lineage import _runtime_source_sha
    source_sha = _runtime_source_sha()
    full_fit = payload.get('candidate_type') == 'oof_full_fit_release'
    if not full_fit and payload.get('generation_mode') != 'purged_oof':
        raise ValueError('timexer_explicit_oof_or_full_fit_required')
    if full_fit:
        from .training_policy import validate_release_training_dataset_binding
        contract=payload.get('release_training_contract')
        if not isinstance(contract,dict) or contract.get('producer_source_sha') != source_sha:
            raise ValueError('timexer_release_source_contract_mismatch')
        validate_release_training_dataset_binding(contract,payload.get('dataset_snapshot'))
    version = payload.get('output_model_version') or payload['version']
    if not version or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in version):
        raise ValueError('timexer_version_invalid')
    with tempfile.TemporaryDirectory(prefix='timexer-') as temp:
        manifest, eligible_by_date = materialize_inputs(bucket,payload,Path(temp))
        cutoff = payload['run_date']
        if (not full_fit and not (payload['train_start'] <= payload['train_end'] < payload['test_start'] <= payload['test_end'] <= cutoff)):
            raise ValueError('timexer_oof_date_split_invalid')
        job = {'name':version, 'settings':payload['settings'], 'exogenous':payload['exogenous'],
               'train_start':payload.get('train_start') or manifest['source_feature_date_min'],
               'train_end':payload.get('train_end') or cutoff,
               'test_start':(date.fromisoformat(cutoff)+timedelta(days=1)).isoformat() if full_fit else payload['test_start'],
               'test_end':cutoff if full_fit else payload['test_end']}
        result = train(job,Path(temp),device='cuda',full_fit=full_fit)
    report = result['report']
    effective = {'settings':job['settings'], 'exogenous':job['exogenous'], 'device':report['device'],
        'target_semantic_version':SEQUENCE_RETURN_SEMANTIC_VERSION,
        'torch_float32_matmul_precision':report['torch_float32_matmul_precision'],
        'checkpoint_selection':report['checkpoint_selection']}
    attestation = build_model_training_config_attestation('TimeXer',payload,effective)
    variant = 'exo137' if job['exogenous'] else 'price'
    from .features import FEATURE_COLS
    metadata = {**report, 'schema_version':SCHEMA+'-metadata', 'model_name':'TimeXer',
        'version':version,'model_pool_version':version, 'seq_len':168,'pred_len':5,
        'target_semantic_version':SEQUENCE_RETURN_SEMANTIC_VERSION,
        'raw_score_semantic_version':SCORE_SEMANTIC,
        'timexer':{'variant':variant,'official_commit':OFFICIAL_COMMIT,'architecture':ARCHITECTURE,
            'inference_device':'cuda','matmul_precision':'high',
            'feature_history_schema':'formal137-pit-asof-source-quality-v3',
            'max_exogenous_staleness_sessions':1},
        'train_range':[job['train_start'],job['train_end']],
        'deployment_fit':{'performed':True,'method':'purged_inner_epoch_then_full_train_refit',
            'train_rows':report['train_rows'],'selected_epochs':report['selected_epochs'],
            'training_label_known_max':report['training_label_known_max'],'validation_models_are_not_served':True},
        'source_manifest_checksum':manifest['manifest_checksum'],
        'model_training_config_attestation':attestation,
        'producer_source_sha':source_sha,
        **build_model_feature_policy_metadata('TimeXer', [*FEATURE_COLS,'close'] if job['exogenous'] else ['close'],
             feature_release_mode='timexer_'+variant),
        'elapsed_s':round(time.monotonic()-started,3)}
    buffer = io.BytesIO()
    torch.save(result['checkpoint'],buffer)
    raw = buffer.getvalue()
    sha = hashlib.sha256(raw).hexdigest()
    # Content-addressed writes cannot replace an already-registered checkpoint.
    prefix = f'universal/timexer/{version}/{sha}'
    metadata.update(checksum=sha,artifact_path=prefix+'/model.pt',metadata_path=prefix+'/metadata.json')
    _write_immutable(bucket,metadata['artifact_path'],raw,'application/octet-stream')
    # Elapsed time is operational telemetry, not an immutable model identity.
    immutable_metadata = {k:v for k,v in metadata.items() if k != 'elapsed_s'}
    _write_immutable(bucket,metadata['metadata_path'],json.dumps(immutable_metadata,sort_keys=True).encode(),'application/json')
    saved = {'weights_path':metadata['artifact_path'],'metadata_path':metadata['metadata_path'],
             'checksum':sha,'metadata':metadata}
    oof_artifact, tracking = None, {}
    if not full_fit:
        import numpy as np
        from .oof_lineage import save_oof_prediction_artifact
        rows = result['oof_rows']
        oof_artifact = save_oof_prediction_artifact(bucket=bucket,gcs_prefix=payload['gcs_prefix'],
            cohort_id=payload['cohort_id'],fold_id=payload.get('fold_id') or payload['window_id'],
            model_name='TimeXer',artifact_version=version,raw_scores=result['oof_scores'],
            targets=np.asarray([r['target'] for r in rows]),dates=[r['date'] for r in rows],
            symbols=[r['symbol'] for r in rows],markets=[r['market'] for r in rows],
            label_known_dates=[r['label_known_date'] for r in rows],split_metadata={
                'score_semantic_version':SCORE_SEMANTIC,'checkpoint_selection':report['checkpoint_selection'],
                'method':'outer_train_fixed_dense_test_purged_rank_ic',
                'train_start':job['train_start'],'train_end':job['train_end'],
                'test_start':job['test_start'],'test_end':job['test_end'],
                'training_label_known_max':report['training_label_known_max'],
                'purge_horizon':5,'refit_inside_test':False,
                'source_manifest_checksum':manifest['manifest_checksum']})
        from .oof_lineage import date_market_rank_ic_evidence
        from .model_validation import build_model_cpcv_evidence
        dates=np.asarray([r['date'] for r in rows])
        daily=[]
        for day in sorted(set(dates)):
            mask=dates==day
            subset=[r for r in rows if r['date']==day]
            evidence=date_market_rank_ic_evidence(raw_scores=result['oof_scores'][mask],
                targets=np.asarray([r['target'] for r in subset]),dates=dates[mask],
                markets=np.asarray([r['market'] for r in subset]))
            daily.append({'fold_id':day,'oos_ic':evidence['fold_oos_ic'],
                'date_cluster_ics':evidence['date_cluster_ics'],'test_rows':len(subset),
                'coverage':len(subset)/max(1,eligible_by_date.get(day,0))})
        validation=build_model_cpcv_evidence(model='TimeXer',fold_metrics=daily[::5],
            policy=payload.get('model_cpcv_policy'),family='learned_sequence',
            coverage_mode='sequence_window',method='outer_train_fixed_dense_test_purged_rank_ic')
        tracking={'TimeXer':{'model_cpcv':validation,'oos_ic':float(np.mean(
            [r['oos_ic'] for r in daily if r['oos_ic'] is not None])) if any(r['oos_ic'] is not None for r in daily) else None}}
    return {'saved':saved,'metadata':metadata,'version':version,'elapsed_s':metadata['elapsed_s'],
            'ic_tracking':tracking,'oof_artifact':oof_artifact,'type':'timexer_universal'}


def _write_immutable(bucket,path,raw,content_type):
    blob=bucket.blob(path)
    if not blob.exists():
        try:
            blob.upload_from_string(raw,content_type=content_type,if_generation_match=0)
        except Exception:
            if not blob.exists():
                raise
    if blob.download_as_bytes() != raw:
        raise ValueError('timexer_immutable_artifact_conflict:'+path)
