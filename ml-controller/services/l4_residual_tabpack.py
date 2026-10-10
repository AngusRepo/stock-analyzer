"""Frozen, selected TabPack members: exact CPU inference without training dependencies."""
from datetime import date
import re
import numpy as np
from services.l4_distribution import design,digest,finite,recipe_order

SCHEMA='l4-three-head-residual-tabpack-v1'
OUTPUTS=['p_loss','gain','loss','expected_return_gross']


def validate(model,*,anchor_model,signal_date=None):
    from services import l4_tabpack_median as median
    if model.get('schema_version') == median.SCHEMA:
        return median.validate(model, anchor_model=anchor_model, signal_date=signal_date)
    from services import l4_tabpack_weights as official
    is_official = model.get('schema_version') == official.SCHEMA
    if (model.get('schema_version') not in (SCHEMA, official.SCHEMA) or model.get('inputs')!=34
            or model.get('output')!='scalar_ev_correction' or model.get('activation')!='ReLU'
            or model.get('anchor_model_checksum')!=digest(anchor_model)
            or model.get('payload_checksum')!=digest({k:v for k,v in model.items() if k!='payload_checksum'})):
        raise ValueError('l4_tabpack_contract_invalid')
    known=date.fromisoformat(model['training_label_known_max'])
    if signal_date is not None and known>=date.fromisoformat(signal_date):
        raise ValueError('l4_tabpack_training_after_decision')
    if finite(model.get('residual_scale'),'tabpack_scale')<=0:
        raise ValueError('l4_tabpack_scale_invalid')
    recipe=model['recipe'];recipe_order(recipe['native'])
    if recipe.get('head_names')!=OUTPUTS:raise ValueError('l4_tabpack_recipe_invalid')
    for key,size in (('mean',4),('scale',4)):
        values=np.asarray(recipe[key],float)
        if values.shape!=(size,) or not np.isfinite(values).all() or (key=='scale' and (values<=0).any()):
            raise ValueError('l4_tabpack_scaler_invalid')
    provenance=model.get('provenance') or {}
    if any(not re.fullmatch('[a-f0-9]{64}',str(provenance.get(k,''))) for k in ('checkpoint_sha256','training_manifest_sha256')):
        raise ValueError('l4_tabpack_provenance_missing')
    if is_official:
        finite(model.get('residual_mean'), 'tabpack_mean')
        if provenance.get('upstream_commit') != '05a89e21b955f12de84889d662e15ca534019aaa':
            raise ValueError('l4_tabpack_upstream_invalid')
        official.validate_members(model, official.load(model.get('weights') or {}))
        return
    members=model.get('members')
    if not isinstance(members,list) or not 1<=len(members)<=8:
        raise ValueError('l4_tabpack_members_invalid')
    ids=[m.get('member_id') for m in members]
    if len(set(ids))!=len(ids) or any(type(i) is not int or not 0<=i<8 for i in ids):
        raise ValueError('l4_tabpack_members_invalid')
    for member in members:
        layers=member.get('layers') or []
        if not 2<=len(layers)<=4:raise ValueError('l4_tabpack_layers_invalid')
        width=34
        for index,layer in enumerate(layers):
            out=1 if index==len(layers)-1 else 128
            weight=np.asarray(layer['weight'],np.float32);bias=np.asarray(layer['bias'],np.float32)
            if weight.shape!=(width,out) or bias.shape!=(out,) or not np.isfinite(weight).all() or not np.isfinite(bias).all():
                raise ValueError('l4_tabpack_weight_invalid')
            width=out
    provenance=model.get('provenance') or {}
    if any(not re.fullmatch('[a-f0-9]{64}',str(provenance.get(k,''))) for k in ('checkpoint_sha256','training_manifest_sha256')):
        raise ValueError('l4_tabpack_provenance_missing')


def apply(rows,outputs,model,*,anchor_model):
    from services import l4_tabpack_median as median
    if model.get('schema_version') == median.SCHEMA:
        return median.apply(rows, outputs, model, anchor_model=anchor_model)
    validate(model,anchor_model=anchor_model)
    if not rows:return []
    native,_=design(rows,model['recipe']['native'])
    raw=np.asarray([[row[k] for k in OUTPUTS] for row in outputs],float)
    recipe=model['recipe']
    inputs=np.asarray(np.column_stack([native,(raw-np.asarray(recipe['mean']))/np.asarray(recipe['scale'])]),np.float32)
    from services import l4_tabpack_weights as official
    if model['schema_version'] == official.SCHEMA:
        correction = (official.infer(inputs, model['members'], official.load(model['weights']))
                      * model['residual_scale'] + model['residual_mean'])
        return _outputs(outputs, raw[:, 3] + correction, correction, model)
    corrections=[]
    for member in model['members']:
        x=inputs
        for index,layer in enumerate(member['layers']):
            x=x@np.asarray(layer['weight'],np.float32)+np.asarray(layer['bias'],np.float32)
            if index<len(member['layers'])-1:x=np.maximum(x,np.float32(0))
        corrections.append(x[:,0])
    correction=np.stack(corrections).mean(0)*model['residual_scale']
    expected=raw[:,3]+correction
    return _outputs(outputs, expected, correction, model)


def _outputs(outputs, expected, correction, model):
    if not np.isfinite(expected).all():raise ValueError('l4_tabpack_nonfinite_prediction')
    return [{**row,'three_head_expected_return_gross':row['expected_return_gross'],
        'expected_return_gross':float(expected[i]),'residual_ev_correction':float(correction[i]),
        'calibration_model':model['schema_version'],'calibration_checksum':model['payload_checksum']} for i,row in enumerate(outputs)]
