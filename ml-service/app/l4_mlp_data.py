"""Purged head-OOF inputs and inner/full scalers for original E0 refit."""
import numpy as np
from services import l4_distribution as native
from services.l4_distribution_lifecycle import chronological_validation_blocks
from app.l4_residual_features import matrix


def prepare(rows, anchor, *, as_of):
    native.validate_bundle(anchor, l3_identity=anchor['l3_identity'], signal_date=as_of, require_paper_release=False)
    dates = anchor['evaluation']['dates']
    train = [r for r in rows if r['label_known_date'] < min(dates)]
    held = [r for r in rows if r['date'] in dates]
    if (native.digest(train) != anchor['training_rows_checksum'] or not held
            or set(dates) != {r['date'] for r in held}
            or any(anchor['model'].get(k) is not None for k in ('residual_mlp','residual_tabpack'))
            or any(r['l3_identity'] != anchor['l3_identity'] or r['prediction_kind'] != 'oof'
                   or not r['l3_training_label_known_max'] < r['date'] < r['label_known_date'] < as_of for r in rows)):
        raise ValueError('l4_mlp_training_source_mismatch')
    days = sorted({r['date'] for r in train})
    usable = [d for d in days if len({r['date'] for r in train if r['label_known_date'] < d}) >= 15]
    oof, folds = [], []
    for start in range(0, len(usable), 5):
        block = usable[start:start+5]
        prior = [r for r in train if r['label_known_date'] < block[0]]
        test = [r for r in train if r['date'] in block]
        head = native.fit_candidate(prior, l3_identity=anchor['l3_identity'], as_of=block[0],
            validation_dates=chronological_validation_blocks(prior))
        oof.extend({**r,'three_head_oof':p} for r,p in zip(test,native.predict(test,head['model']),strict=True))
        folds.append({'dates':block,'training_label_known_max':head['training_label_known_max'],
            'model_checksum':head['model_checksum'],'training_rows_checksum':head['training_rows_checksum']})
    days = sorted({r['date'] for r in oof})
    if len(days) < 2:
        raise ValueError('l4_mlp_purged_history_insufficient')
    cutoff = days[int(len(days)*.8)]
    parts = {'inner':[r for r in oof if r['label_known_date'] < cutoff],
        'valid':[r for r in oof if r['date'] >= cutoff], 'full':oof,
        'test':[{**r,'three_head_oof':p} for r,p in zip(held,native.predict(held,anchor['model']),strict=True)]}
    if any(not part for part in parts.values()):
        raise ValueError('l4_mlp_purged_history_insufficient')
    arrays, recipes = {}, {}
    for name,part in parts.items():
        recipe = recipes['inner'] if name == 'valid' else recipes['full'] if name == 'test' else None
        output = [r['three_head_oof'] for r in part]
        x, fitted = matrix(part, output, recipe)
        recipes[name] = fitted
        arrays[name] = (x.astype('float32'), np.asarray([r['gross_return'] for r in part]),
            np.asarray([p['expected_return_gross'] for p in output]), native.date_weights(part))
    evidence = {'source_rows_checksum':native.digest(rows),'three_head_folds':folds,
        'inner_label_known_max':max(r['label_known_date'] for r in parts['inner']),
        'validation_start':cutoff,'training_label_known_max':max(r['label_known_date'] for r in oof),
        'test_start':min(dates),'anchor_model_checksum':anchor['model_checksum'],
        'partition_checksums':{k:native.digest(v) for k,v in parts.items()},
        'recipes':{'inner':recipes['inner'],'full':recipes['full']},
        'loss':'date_equal_weighted_residual_mse','seed_selection':'predeclared_42_43_44_no_test_selection',
        'refit_after_selection':True}
    if not evidence['inner_label_known_max'] < cutoff or not evidence['training_label_known_max'] < min(dates):
        raise ValueError('l4_mlp_purge_failed')
    return arrays, recipes['full'], evidence, held
