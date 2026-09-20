"""Train the accepted B correction from purged, full-L3 three-head OOF inputs."""
from copy import deepcopy
import numpy as np

from services import l4_distribution as native
from services.l4_distribution_lifecycle import chronological_validation_blocks
from services.l4_residual_mlp import SCHEMA, OUTPUTS, validate

SETTINGS = {'minimum_anchor_dates':15, 'refresh_dates':5, 'inputs':34,
            'width':128, 'blocks':3, 'dropout':.1, 'epochs':30, 'patience':5, 'seed':42}


def matrix(rows, outputs, recipe=None):
    x, native_recipe = native.design(rows, None if recipe is None else recipe['native'])
    heads = np.asarray([[p[k] for k in OUTPUTS] for p in outputs],float)
    if recipe is None:
        weights = native.date_weights(rows)[:,None]
        mean = (weights*heads).sum(0)
        scale = np.maximum(np.sqrt((weights*(heads-mean)**2).sum(0)),.001)
        recipe = {'native':native_recipe,'head_names':OUTPUTS,'mean':mean.tolist(),'scale':scale.tolist()}
    values = np.column_stack([x,(heads-np.asarray(recipe['mean']))/np.asarray(recipe['scale'])])
    if not np.isfinite(values).all():
        raise ValueError('l4_mlp_nonfinite_training_matrix')
    return values, recipe


def fit_candidate(rows, anchor, *, as_of):
    """No same-row fitted head values: refit heads before each five-date block.

    The caller supplies exactly the anchor's training rows. Held-out outcomes
    cannot quietly enter the correction, and insufficient history is explicit.
    """
    import torch
    from .l4_mlp_training import fit, predict
    native.validate_bundle(anchor,l3_identity=anchor['l3_identity'],signal_date=as_of,require_paper_release=False)
    if (anchor['training_rows_checksum'] != native.digest(rows)
            or any(r['l3_identity'] != anchor['l3_identity'] or r['prediction_kind'] != 'oof'
                   or not r['l3_training_label_known_max'] < r['date'] < r['label_known_date'] < as_of for r in rows)
            or anchor['model'].get('residual_mlp') is not None):
        raise ValueError('l4_mlp_training_source_mismatch')
    dates = sorted({r['date'] for r in rows})
    usable = [day for day in dates if len({r['date'] for r in rows if r['label_known_date'] < day}) >= 15]
    oof, provenance = [], []
    for start in range(0,len(usable),5):
        days = usable[start:start+5]
        train = [r for r in rows if r['label_known_date'] < days[0]]
        test = [r for r in rows if r['date'] in days]
        fitted = native.fit_candidate(train,l3_identity=anchor['l3_identity'],as_of=days[0],
            validation_dates=chronological_validation_blocks(train))
        outputs = native.predict(test,fitted['model'])
        oof.extend({**r,'three_head_oof':p} for r,p in zip(test,outputs,strict=True))
        provenance.append({'start':days[0],'dates':days,'training_label_known_max':fitted['training_label_known_max'],
            'model_checksum':fitted['model_checksum'],'training_rows_checksum':fitted['training_rows_checksum']})
    days = sorted({r['date'] for r in oof})
    if len(days) < 2:
        raise ValueError('l4_mlp_purged_history_insufficient')
    cutoff = days[int(len(days)*.8)]
    train = [r for r in oof if r['label_known_date'] < cutoff]
    valid = [r for r in oof if r['date'] >= cutoff]
    if not train or not valid:
        raise ValueError('l4_mlp_purged_history_insufficient')

    def arrays(data, recipe=None):
        x, recipe = matrix(data,[r['three_head_oof'] for r in data],recipe)
        return (x,np.asarray([r['gross_return'] for r in data]),
                np.asarray([r['three_head_oof']['expected_return_gross'] for r in data]),
                native.date_weights(data)),recipe

    torch.set_num_threads(8)
    tx,tr = arrays(train)
    vx,_ = arrays(valid,tr)
    selected,selection = fit(*tx,valid=vx,epochs=30,patience=5,seed=42)
    del selected
    full,recipe = arrays(oof)
    model,report = fit(*full,epochs=selection['selected_epochs'],seed=42)
    model.eval()
    result = {'schema_version':SCHEMA,'inputs':34,'width':128,'blocks':3,'output':'scalar_ev_correction',
        'anchor_model_checksum':native.digest(anchor['model']),
        'training_label_known_max':max(r['label_known_date'] for r in oof),
        'residual_scale':report['residual_scale'],'recipe':recipe,
        'state':{name:value.detach().cpu().tolist() for name,value in model.state_dict().items()},
        'training_evidence':{'settings':SETTINGS,'source_rows_checksum':native.digest(rows),
            'oof_rows_checksum':native.digest(oof),'oof_rows':len(oof),'oof_dates':days,
            'three_head_folds':provenance,'inner_train_known_max':max(r['label_known_date'] for r in train),
            'inner_valid_date_min':min(r['date'] for r in valid),'selection':selection,'fit':report}}
    result['payload_checksum'] = native.digest(result)
    validate(result,anchor_model=anchor['model'],signal_date=as_of)
    output = deepcopy(anchor)
    output['model']['residual_mlp'] = result
    output['model_checksum'] = native.digest(output['model'])
    output['release'] = {'scope':'research','decision':'CANDIDATE'}
    # The anchor's historical EV assessment does not assess the new correction.
    output.pop('evaluation',None)
    output.pop('candidate_id',None)
    from services.l4_residual_mlp import apply
    official = predict(model,full[0],full[2],scale=report['residual_scale'])
    exported = apply(oof,[r['three_head_oof'] for r in oof],result,anchor_model=anchor['model'])
    error = float(np.max(np.abs(official-np.asarray([r['expected_return_gross'] for r in exported]))))
    if error > 1e-6:
        raise ValueError('l4_mlp_export_parity_failed')
    output['export_verification'] = {'rows':len(oof),'max_absolute_error':error,'tolerance':1e-6}
    native.validate_bundle(output,l3_identity=output['l3_identity'],signal_date=as_of,require_paper_release=False)
    return output
