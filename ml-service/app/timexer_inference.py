"""Version-bound TimeXer inference over the shared immutable PIT feature prep.

Read one feature shard at a time and generate at most 64 window tensors. Neither
the controller nor Modal RPC transports the five-year 137-column matrix.
"""
from __future__ import annotations

import hashlib
import io
import json
import time
import numpy as np

from .timexer_contract import metadata_contract, SCORE_SEMANTIC, canonical_checksum
from .timexer_runtime import load_checkpoint, predict_asof


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def feature_receipt(bucket, reference, signal_date):
    if (reference.get('schema_version') != 'timexer-feature-source-v1'
            or reference.get('signal_date') != signal_date
            or reference.get('status') != 'ready'
            or reference.get('training_dispatched') is not False):
        raise ValueError('timexer_feature_reference_invalid')
    prefix = reference['source_gcs_prefix'].rstrip('/')
    if not prefix.startswith('universal/oof_forward_prep_v2/') or '..' in prefix.split('/'):
        raise ValueError('timexer_feature_prefix_invalid')
    receipt = json.loads(bucket.blob(prefix+'/prep/immutable_receipt.json').download_as_bytes())
    unsigned = {k:v for k,v in receipt.items() if k != 'receipt_checksum'}
    digest = _sha(json.dumps(unsigned, sort_keys=True).encode('utf-8'))
    if (digest != receipt.get('receipt_checksum')
            or digest != reference.get('source_receipt_checksum')
            or receipt.get('business_date') != signal_date
            or receipt.get('output_gcs_prefix') != prefix
            or receipt.get('status') != 'ready'
            or receipt.get('training_dispatched') is not False
            or receipt.get('feature_semantic_version') != 'formal137-pit-asof-source-quality-v3'
            or receipt.get('feature_imputation_semantic') != 'prior_252_row_median_then_zero_v2'):
        raise ValueError('timexer_feature_receipt_mismatch')
    count = receipt.get('batch_count')
    expected = {f'{prefix}/prep/batch_{i}.npz' for i in range(count or 0)}
    if not expected or expected != set(receipt.get('output_checksums') or {}):
        raise ValueError('timexer_feature_inventory_invalid')
    from .features import FEATURE_COLS
    names = json.loads(bucket.blob(prefix+'/prep/feature_names.json').download_as_bytes())
    if names != list(FEATURE_COLS) or len(names) != 137:
        raise ValueError('timexer_feature_order_mismatch')
    return receipt


def batch_predict(*, series_list, artifact_identity, feature_source, signal_date,
                  version, horizon_used=5, bucket=None):
    import torch
    from .model_store import _get_bucket
    started = time.monotonic()
    identity = artifact_identity or {}
    if (identity.get('model') != 'TimeXer' or identity.get('version') != version
            or horizon_used != 5 or any(not identity.get(k) for k in
                ('artifact_id','artifact_path','metadata_path','checksum'))):
        raise ValueError('timexer_serving_identity_invalid')
    if not torch.cuda.is_available():
        raise ValueError('timexer_verified_cuda_runtime_required')
    bucket = bucket if bucket is not None else _get_bucket()
    metadata = json.loads(bucket.blob(identity['metadata_path']).download_as_bytes())
    config = metadata_contract(metadata)
    if (any(metadata.get(k) != identity[k] for k in ('version','artifact_path'))
            or canonical_checksum(metadata.get('checksum')) != canonical_checksum(identity['checksum'])):
        raise ValueError('timexer_metadata_identity_mismatch')
    receipt = feature_receipt(bucket, feature_source, signal_date)
    torch.set_float32_matmul_precision('high')
    model, settings = load_checkpoint(bucket.blob(identity['artifact_path']).download_as_bytes(),
        expected_checksum=identity['checksum'], expected_variant=config['variant'], device='cuda')
    histories = {}
    for row in series_list:
        symbol = str(row.get('symbol') or row.get('stock_id') or '')
        if (not symbol or symbol in histories or row.get('price_basis') != 'finlab_adjusted_close'
                or not row.get('dates') or row['dates'][-1] > signal_date):
            raise ValueError('timexer_price_history_identity_invalid')
        histories[symbol] = (row['dates'], row['prices'])
    calendar = sorted({d for dates,_ in histories.values() for d in dates})
    outputs, seen = {}, set()
    for path, digest in sorted(receipt['output_checksums'].items()):
        raw = bucket.blob(path).download_as_bytes()
        if _sha(raw) != digest:
            raise ValueError('timexer_feature_shard_checksum_mismatch')
        with np.load(io.BytesIO(raw), allow_pickle=True) as shard:
            symbols = shard['symbols'].astype(str)
            dates = shard['dates'].astype(str)
            matrix = shard['X'].astype(np.float32)
        del raw
        features = {}
        for symbol in set(symbols) & set(histories):
            if symbol in seen:
                raise ValueError('timexer_duplicate_feature_symbol')
            seen.add(symbol)
            mask = (symbols == symbol) & (dates <= signal_date)
            order = np.argsort(dates[mask], kind='stable')
            features[symbol] = (dates[mask][order], matrix[mask][order])
        predictions = predict_asof(model, settings=settings, exogenous=config['variant']=='exo137',
            histories=histories, feature_histories=features, calendar=calendar,
            symbols=sorted(features), signal_date=signal_date, device='cuda')
        outputs.update({row['symbol']: row for row in predictions})
        del matrix, features
    results = []
    for symbol in histories:
        row = outputs.get(symbol, {'symbol':symbol, 'raw_score':None, 'available':False,
                                  'reason':'timexer_causal_context_unavailable'})
        results.append({**row, 'forecast_pct':row['raw_score'], 'model':'TimeXer',
            'version':version, 'horizon_used':5, 'score_semantic_version':SCORE_SEMANTIC,
            'artifact_id':identity['artifact_id'], 'artifact_checksum':identity['checksum'],
            'feature_receipt_checksum':receipt['receipt_checksum'],
            'inference_device':'cuda', 'matmul_precision':'high'})
    del model
    torch.cuda.empty_cache()
    print('TIMEXER_INFERENCE', config['variant'], len(results),
          sum(r['available'] for r in results), round(time.monotonic()-started,3), flush=True)
    return results
