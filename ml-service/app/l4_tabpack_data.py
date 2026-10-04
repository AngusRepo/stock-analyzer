"""Causal finance adapter for the unmodified official TabPack trainer."""
import json
from pathlib import Path

import numpy as np

from services import l4_distribution as native
from services.l4_distribution_lifecycle import chronological_validation_blocks
from .l4_residual_features import matrix


def prepare(rows, anchor, *, as_of):
    native.validate_bundle(anchor, l3_identity=anchor['l3_identity'], signal_date=as_of, require_paper_release=False)
    dates = anchor['evaluation']['dates']
    train = [r for r in rows if r['label_known_date'] < min(dates)]
    held = [r for r in rows if r['date'] in dates]
    if (native.digest(train) != anchor['training_rows_checksum'] or not held
            or set(dates) != {r['date'] for r in held}
            or any(anchor['model'].get(key) is not None for key in ('residual_mlp', 'residual_tabpack'))
            or any(r['l3_identity'] != anchor['l3_identity'] or r['prediction_kind'] != 'oof'
                   or not r['l3_training_label_known_max'] < r['date'] < r['label_known_date'] < as_of for r in rows)):
        raise ValueError('l4_tabpack_training_source_mismatch')
    days = sorted({r['date'] for r in train})
    usable = [d for d in days if len({r['date'] for r in train if r['label_known_date'] < d}) >= 15]
    oof, folds = [], []
    for start in range(0, len(usable), 5):
        block = usable[start:start + 5]
        prior = [r for r in train if r['label_known_date'] < block[0]]
        test = [r for r in train if r['date'] in block]
        head = native.fit_candidate(prior, l3_identity=anchor['l3_identity'], as_of=block[0],
                                    validation_dates=chronological_validation_blocks(prior))
        oof.extend({**r, 'three_head_oof': p} for r, p in zip(test, native.predict(test, head['model']), strict=True))
        folds.append({'dates': block, 'training_label_known_max': head['training_label_known_max'],
                      'model_checksum': head['model_checksum'], 'training_rows_checksum': head['training_rows_checksum']})
    split_days = sorted({r['date'] for r in oof})
    if len(split_days) < 2:
        raise ValueError('l4_tabpack_purged_history_insufficient')
    cutoff = split_days[int(len(split_days) * .8)]
    partitions = {'train': [r for r in oof if r['label_known_date'] < cutoff],
                  'val': [r for r in oof if r['date'] >= cutoff],
                  'test': [{**r, 'three_head_oof': p} for r, p in zip(held, native.predict(held, anchor['model']), strict=True)]}
    if any(not part for part in partitions.values()):
        raise ValueError('l4_tabpack_purged_history_insufficient')
    recipe, arrays = None, {}
    for name, part in partitions.items():
        x, fitted = matrix(part, [r['three_head_oof'] for r in part], recipe)
        if recipe is None:
            recipe = fitted
        residual = np.asarray([r['gross_return'] - r['three_head_oof']['expected_return_gross'] for r in part], np.float32)
        arrays[name] = (np.asarray(x, np.float32), residual)
    y = arrays['train'][1]
    if not np.isfinite(y).all() or float(y.std()) <= 0:
        raise ValueError('l4_tabpack_constant_or_invalid_residual')
    evidence = {'source_rows_checksum': native.digest(rows), 'three_head_folds': folds,
                'train_known_max': max(r['label_known_date'] for r in partitions['train']),
                'val_date_min': min(r['date'] for r in partitions['val']),
                'val_known_max': max(r['label_known_date'] for r in partitions['val']),
                'test_date_min': min(dates),
                'partitions': {k: {'rows': len(v), 'checksum': native.digest(v)} for k, v in partitions.items()},
                'loss': 'official_unweighted_residual_mse', 'seed_selection': 'predeclared_42_no_test_selection',
                'refit_after_selection': False}
    if not evidence['train_known_max'] < evidence['val_date_min'] or not evidence['val_known_max'] < evidence['test_date_min']:
        raise ValueError('l4_tabpack_purge_failed')
    return arrays, recipe, evidence, held


def write_dataset(path, arrays):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=False)
    splits = path / 'splits' / 'default'
    splits.mkdir(parents=True)
    offset = 0
    for name in ('train', 'val', 'test'):
        x, y = arrays[name]
        if x.shape != (len(y), 34) or not len(y) or not np.isfinite(x).all() or not np.isfinite(y).all():
            raise ValueError('l4_tabpack_dataset_shape_invalid')
        np.save(splits / (name + '.npy'), np.arange(offset, offset + len(y), dtype=np.int32))
        offset += len(y)
    np.save(path / 'x_num.npy', np.concatenate([arrays[k][0] for k in ('train', 'val', 'test')]).astype(np.float32))
    np.save(path / 'y.npy', np.concatenate([arrays[k][1] for k in ('train', 'val', 'test')]).astype(np.float32))
    (path / 'info.json').write_text(json.dumps({'task': {'type': 'regression', 'score': 'rmse'}}), encoding='utf-8')
