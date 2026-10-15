"""R2 CPU inference for explicitly sealed shadow bundles; no serving mutation."""
from datetime import date
import hashlib,io,math
import numpy as np
from services import l4_distribution as native

SCHEMA='l4-r2-shadow-v1'
HEAD_NAMES=['p_loss','gain','loss','expected_return_gross']

def validate(bundle,*,identity,signal_date):
    if (bundle.get('schema_version')!=SCHEMA or bundle.get('l3_identity')!=identity
            or bundle.get('payload_checksum')!=native.digest({k:v for k,v in bundle.items() if k!='payload_checksum'})
            or bundle.get('source_pool')!='native_non_etf_equity_v1'
            or bundle.get('production_enabled') is not False):
        raise ValueError('l4_r2_shadow_contract_invalid')
    if not date.fromisoformat(bundle['training_label_known_max'])<date.fromisoformat(signal_date):
        raise ValueError('l4_r2_training_after_decision')
    seeds=bundle['seeds']
    if [s['seed'] for s in seeds]!=[42,43,44]:raise ValueError('l4_r2_seed_set')
    c=bundle['calibration']
    if c['w'] not in (0.,.5,1.) or not math.isfinite(c['b']):raise ValueError('l4_r2_calibration_invalid')
    for s in seeds:
        members=s['members']
        if (not 1<=len(members)<=32 or not math.isfinite(s['target_mean'])
                or not math.isfinite(s['target_scale']) or s['target_scale']<=0
                or not math.isclose(sum(m['weight'] for m in members),1.,abs_tol=1e-10)
                or any(not 0<m['weight']<=1 or type(m['depth']) is not int or not 1<=m['depth']<=4
                    or type(m['member_id']) is not int or not 0<=m['member_id']<16
                    or type(m['epoch']) is not int or not 1<=m['epoch']<=200 for m in members)):
            raise ValueError('l4_r2_members_invalid')
        recipe=s['final_recipe'];order=native.recipe_order(recipe['native'])
        if native.feature_schema(order)!=bundle['feature_schema']:raise ValueError('l4_r2_native_schema')
        for k in ('mean','scale'):
            values=np.asarray(recipe['native'][k],float)
            if values.shape!=(30,) or not np.isfinite(values).all() or (k=='scale' and (values<=0).any()):
                raise ValueError('l4_r2_native_normalizer_invalid')
        if recipe['head_names']!=HEAD_NAMES:raise ValueError('l4_r2_head_schema')
        for k in ('mean','scale'):
            values=np.asarray(recipe[k],float)
            if values.shape!=(4,) or not np.isfinite(values).all() or (k=='scale' and (values<=0).any()):
                raise ValueError('l4_r2_head_normalizer_invalid')

def infer_seed(inputs,seed,raw):
    if hashlib.sha256(raw).hexdigest()!=seed['weights']['sha256']:raise ValueError('l4_r2_weight_hash')
    result=np.zeros(len(inputs),np.float64)
    with np.load(io.BytesIO(raw),allow_pickle=False) as arrays:
        expected=set()
        for index,member in enumerate(seed['members']):
            x=np.asarray(inputs,np.float32);width=34
            for layer in range(member['depth']+1):
                w=f'm{index}_l{layer}_weight';b=f'm{index}_l{layer}_bias';expected.update((w,b))
                weight=arrays[w];bias=arrays[b];out=1 if layer==member['depth'] else 384
                if (weight.shape!=(width,out) or bias.shape!=(out,) or weight.dtype!=np.float32
                        or bias.dtype!=np.float32 or not np.isfinite(weight).all() or not np.isfinite(bias).all()):
                    raise ValueError('l4_r2_weight_shape_or_values')
                x=x@weight+bias
                if layer<member['depth']:x=np.maximum(x,0)
                width=out
            result+=member['weight']*(x[:,0]*seed['target_scale']+seed['target_mean'])
        if set(arrays.files)!=expected:raise ValueError('l4_r2_weight_fields')
    if not np.isfinite(result).all():raise ValueError('l4_r2_nonfinite_prediction')
    return result

def predict(rows,*,bundle,anchor,identity,signal_date,load_bytes,pool_symbols):
    validate(bundle,identity=identity,signal_date=signal_date)
    symbols=[r['symbol'] for r in rows]
    if not symbols or len(symbols)!=len(set(symbols)) or sorted(symbols)!=sorted(set(pool_symbols)):
        raise ValueError('l4_r2_incomplete_pool')
    if any(r.get('date')!=signal_date or r.get('l3_identity')!=identity
            or r.get('feature_schema')!=bundle['feature_schema'] for r in rows):
        raise ValueError('l4_r2_input_identity_or_date')
    if (anchor['model_checksum']!=native.digest(anchor['model']) or anchor['l3_identity']!=identity
            or anchor['training_label_known_max']>=signal_date):
        raise ValueError('l4_r2_causal_anchor_invalid')
    heads=native.predict(rows,anchor['model'])
    raw_heads=np.asarray([[r[k] for k in HEAD_NAMES] for r in heads],float)
    corrections=[];matrix_checksums={}
    for seed in bundle['seeds']:
        recipe=seed['final_recipe'];x,_=native.design(rows,recipe['native'])
        inputs=np.column_stack([x,(raw_heads-np.asarray(recipe['mean']))/np.asarray(recipe['scale'])]).astype(np.float32)
        matrix_checksums[str(seed['seed'])]=hashlib.sha256(inputs.tobytes(order='C')).hexdigest()
        corrections.append(infer_seed(inputs,seed,load_bytes(seed['weights'])))
    delta=np.median(np.stack(corrections),axis=0)
    score=bundle['calibration']['w']*raw_heads[:,3]+delta
    mu=bundle['calibration']['b']*(score-score.mean())
    return [dict(symbol=symbol,anchor=float(raw_heads[i,3]),delta=float(delta[i]),score=float(score[i]),
        relative_mu=float(mu[i]),pool_checksum=native.digest(sorted(symbols)),
        model_checksum=bundle['payload_checksum'],anchor_checksum=anchor['model_checksum'],
        head_inputs=dict(zip(HEAD_NAMES,map(float,raw_heads[i]),strict=True)),
        seed_input_matrix_checksums=matrix_checksums,
        execution_scope='shadow_only',production_enabled=False) for i,symbol in enumerate(symbols)]
