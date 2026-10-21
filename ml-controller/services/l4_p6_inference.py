"""P6-a CPU inference primitives. No fitting, calibration update or pointer write."""
import hashlib
import math
import numpy as np
from services import l4_tabpack_weights as weights
from services import l4_p6_recipe as recipe
from services import l4_p6_pure_head as pure


def infer_seed(inputs, seed, raw):
    inputs=np.asarray(inputs,np.float32)
    if inputs.ndim!=2 or inputs.shape[1]!=31 or not np.isfinite(inputs).all():raise ValueError('p6_inference_input_invalid')
    if (seed.get('seed') not in (42,43,44) or not math.isfinite(seed['target_mean'])
            or not math.isfinite(seed['target_scale']) or seed['target_scale']<=0):raise ValueError('p6_inference_target_invalid')
    reference=seed['weights']
    # Decode binds bytes/size/checksum. Source object paths remain in the receipt;
    # the bounded safe NPZ decoder is shared with the existing serving owner.
    arrays=weights.decode(raw,dict(path=weights.PREFIX+reference['sha256']+'.npz',sha256=reference['sha256'],bytes=reference['bytes']))
    members=seed.get('members') or []
    if not 1<=len(members)<=32:raise ValueError('p6_inference_members_invalid')
    identities=set();fields=set();total=0.
    for i,member in enumerate(members):
        mid,epoch,depth=member.get('member_id'),member.get('epoch'),member.get('depth')
        value=member.get('weight')
        if (type(mid) is not int or not 0<=mid<16 or type(epoch) is not int or not 1<=epoch<=200
                or type(depth) is not int or not 1<=depth<=4 or (mid,epoch) in identities
                or type(value) not in (int,float) or not math.isfinite(value) or not 0<value<=1):
            raise ValueError('p6_inference_member_identity')
        identities.add((mid,epoch));total+=value;width=31
        for layer in range(depth+1):
            out=1 if layer==depth else 384
            w,b=f'm{i}_l{layer}_weight',f'm{i}_l{layer}_bias';fields.update((w,b))
            if w not in arrays or b not in arrays or arrays[w].shape!=(width,out) or arrays[b].shape!=(out,):
                raise ValueError('p6_inference_weight_shape')
            width=out
    if fields!=set(arrays) or not math.isclose(total,1.,rel_tol=0,abs_tol=1e-10):raise ValueError('p6_inference_member_sum_or_fields')
    # Preserve the R16 arithmetic order: FP32 per-member de-normalization,
    # followed by FP64 weighted accumulation (not affine-after-ensemble).
    values=np.zeros(len(inputs),np.float64)
    for i,member in enumerate(members):
        value=inputs
        for layer in range(member['depth']+1):
            value=value@arrays[f'm{i}_l{layer}_weight']+arrays[f'm{i}_l{layer}_bias']
            if layer<member['depth']:value=np.maximum(value,0)
        values+=member['weight']*(value[:,0]*seed['target_scale']+seed['target_mean'])
    if not np.isfinite(values).all():raise ValueError('p6_inference_nonfinite')
    return values


def predict(rows, *, seeds, head, load_bytes):
    if [s.get('seed') for s in seeds]!=[42,43,44]:raise ValueError('p6_inference_seed_roster')
    if not rows or len({r['symbol'] for r in rows})!=len(rows):raise ValueError('p6_inference_pool_invalid')
    raw=pure.extract(rows)
    x,_=pure.design(raw,[r.get('date') for r in rows],head['recipe'])
    probability=pure.predict(x,head['head'])
    forecasts=[];matrix_checksums={}
    for seed in seeds:
        inputs,_=recipe.matrix(rows,probability,seed['final_recipe'])
        matrix_checksums[str(seed['seed'])]=hashlib.sha256(inputs.tobytes(order='C')).hexdigest()
        forecasts.append(infer_seed(inputs,seed,load_bytes(seed['weights'])))
    score=np.median(np.stack(forecasts),axis=0)
    centered=score-score.mean();spread=float(score.std())
    if spread<=0:raise ValueError('p6_unidentifiable_score_scale')
    z=centered/spread
    return dict(score=score,relative_score=centered,z=z,p_loss=probability,
        seed_input_matrix_checksums=matrix_checksums)
