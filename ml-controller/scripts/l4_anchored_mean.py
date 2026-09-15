"""Offline full-L3 residual ridge; no serving imports this research candidate."""
import os
os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
import json, hashlib
from pathlib import Path
import numpy as np
import polars as pl
from services import l4_distribution as base
from services.l4_distribution_lifecycle import chronological_validation_blocks
from l4_qrf_validation import design, mean_summary

W=Path(__file__).resolve().parents[2]
O=W/'audits/l4-design-repair/qrf-validation/anchored-mean'
GRID=(.01,.1,1.,10.)

def fit_correction(x,y,native,weights,lam):
    x=np.asarray(x,float); y=np.asarray(y,float);native=np.asarray(native,float);w=np.asarray(weights,float)
    if (x.ndim!=2 or y.shape!=(len(x),) or native.shape!=y.shape or w.shape!=y.shape
        or not all(np.isfinite(v).all() for v in (x,y,native,w)) or (w<0).any() or w.sum()<=0):
        raise ValueError('invalid_fit_arrays')
    if lam is None:return np.zeros(x.shape[1]+1)
    if not np.isfinite(lam) or lam<=0:raise ValueError('invalid_lambda')
    w=w/w.sum(); z=np.column_stack((np.ones(len(x)),x))
    return np.linalg.solve(z.T@(w[:,None]*z)+lam*np.eye(z.shape[1]),z.T@(w*(y-native)))

def correction_predict(x,native,beta):
    return np.asarray(native)+np.column_stack((np.ones(len(x)),x))@beta

def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
def key(r):return r['date'],r['symbol']

def main():
    O.mkdir(parents=True,exist_ok=True)
    paths=[W/'audits/l4-refactor/native-oof-rows.json',W/'audits/l4-regression/native-l3-predictions.json']
    source,fp=map(read,paths); native={key(r):r['native_l3_gross'] for r in fp}
    for path,expected in read(W/'audits/l4-regression/forecast-ablation-protocol.json')['inputs'].items():
        assert sha(Path(path))==expected,'source_changed'
    assert len(native)==len(fp)==len(source)==len({key(r) for r in source})
    assert all(r['prediction_kind']=='oof' and r['l3_training_label_known_max']<r['date']<r['label_known_date'] for r in source)
    tr=[r for r in source if r['label_known_date']<'2026-08-20']
    held=[r for r in source if '2026-08-20'<=r['date']<='2026-09-01']
    assert len(tr)==47159 and len(held)==11403
    dates=chronological_validation_blocks(tr)
    folds=[]
    for ds in dates:
        a=[r for r in tr if r['label_known_date']<min(ds)];v=[r for r in tr if r['date'] in ds]
        x,recipe=design(a,native);vx,_=design(v,native,recipe)
        folds.append((a,v,x,vx,recipe))
    protocol={'scope':'user-authorized single offline candidate; reused historical exploratory comparison',
      'formula':'mu4=mu3+[1,standardized full L3(31)]@delta',
      'loss':'date-equal weighted squared gross residual + lambda*||delta||^2; intercept also shrinks to zero',
      'grid':list(GRID),'zero_correction_control':True,
      'selection':'equal average of 3 inner date-equal MSE; exact ties prefer zero then stronger shrinkage; held never selects',
      'features':base.FEATURE_NAMES+['native_l3_gross'],'no_clipping_or_top_k':True,
      'source_hashes':{str(p):sha(p) for p in paths},'script_hash':sha(Path(__file__)),
      'folds':[{'dates':ds,'train_rows':len(a),'validation_rows':len(v),'max_training_label_known':max(r['label_known_date'] for r in a)} for ds,(a,v,*_) in zip(dates,folds)],
      'train_rows':len(tr),'train_dates':len({r['date'] for r in tr}),'held_rows':len(held),'held_dates':sorted({r['date'] for r in held}),
      'full_account_nav':False,'no_probability_heads_fabricated':True}
    save('protocol.json',protocol)
    cv=[]; allpred={}; validation=sum([f[1] for f in folds],[])
    for lam in [None,*GRID]:
        records=[]; name='native_l3' if lam is None else 'ridge_'+str(lam)
        for i,(a,v,x,vx,recipe) in enumerate(folds):
            beta=fit_correction(x,[r['gross_return'] for r in a],[native[key(r)] for r in a],base.date_weights(a),lam)
            values=correction_predict(vx,[native[key(r)] for r in v],beta)
            records.append({'fold':i,**mean_summary(v,values)})
            allpred.setdefault(name,[]).extend(values.tolist())
        cv.append({'name':name,'lambda':lam,'mean_mse':float(np.mean([s['date_equal']['mse'] for s in records])),'folds':records})
    selected=min(cv,key=lambda c:(c['mean_mse'],0 if c['lambda'] is None else 1,-(c['lambda'] or 0)))
    bestfinite=min([c for c in cv if c['lambda'] is not None],key=lambda c:(c['mean_mse'],-c['lambda']))
    save('cv.json',cv)
    print('SELECTED',json.dumps({k:selected[k] for k in ['name','lambda','mean_mse']}),flush=True)
    x,recipe=design(tr,native);vx,_=design(held,native,recipe)
    beta=fit_correction(x,[r['gross_return'] for r in tr],[native[key(r)] for r in tr],base.date_weights(tr),bestfinite['lambda'])
    save('research-model.json',{'scope':'offline only; not a serving distribution artifact','recipe':recipe,'beta':beta.tolist(),'lambda':bestfinite['lambda'],'selected_by_inner':selected['name']==bestfinite['name']})
    values=correction_predict(vx,[native[key(r)] for r in held],beta)
    frozen=pl.read_parquet(O.parent/'predictions.parquet');mix=pl.read_parquet(O.parent/'hybrid/held-predictions.parquet')
    fm={key(r):r for r in frozen.to_dicts()};hm={key(r):r for r in mix.to_dicts()}
    assert len(fm)==len(hm)==len(held) and set(fm)==set(hm)=={key(r) for r in held}
    records=[]
    for r,value in zip(held,values):
        f=fm[key(r)];h=hm[key(r)];assert r['gross_return']==f['gross_return']==h['gross_return'];assert native[key(r)]==f['native_l3_mean']
        records.append({'date':r['date'],'symbol':r['symbol'],'gross_return':r['gross_return'],'native_l3':native[key(r)],'anchored':float(value),'three_head':f['three_head30_expected_return_gross'],'hybrid':h['expected_return_gross'],'selected':native[key(r)] if selected['lambda'] is None else float(value)})
    frame=pl.DataFrame(records);frame.write_parquet(O/'held-predictions.parquet')
    arms={name:mean_summary(held,frame[name].to_list()) for name in ['native_l3','anchored','three_head','hybrid','selected']}
    innerframe=pl.read_parquet(O.parent/'hybrid/inner-predictions.parquet');im={key(r):r for r in innerframe.to_dicts()}
    assert len(im)==len(validation) and set(im)=={key(r) for r in validation}
    innerrecords=[]
    for i,r in enumerate(validation):
        f=im[key(r)];assert f['gross_return']==r['gross_return']
        innerrecords.append({'date':r['date'],'symbol':r['symbol'],'gross_return':r['gross_return'],'native_l3':native[key(r)],'anchored':allpred[bestfinite['name']][i],'three_head':f['three_head30_expected_return_gross'],'hybrid':f['hybrid_expected_return_gross']})
    pl.DataFrame(innerrecords).write_parquet(O/'inner-predictions.parquet')
    daily_diagnostics=[]
    for day in sorted(set(frame['date'])):
        f=frame.filter(pl.col('date')==day);delta=f['anchored']-f['native_l3']
        daily_diagnostics.append({'date':day,'rows':f.height,'mean_correction':delta.mean(),'mean_absolute_correction':delta.abs().mean(),'sign_flip_rate':((f['anchored']>0)!=(f['native_l3']>0)).mean(),'predicted_gross_mean':f['anchored'].mean(),'native_gross_mean':f['native_l3'].mean(),'actual_gross_mean':f['gross_return'].mean()})
    results={'selected':{k:selected[k] for k in ['name','lambda','mean_mse']},'best_finite':{k:bestfinite[k] for k in ['name','lambda','mean_mse']},'held':arms,'inner':{name:mean_summary(validation,[r[name] for r in innerrecords]) for name in ['native_l3','anchored','three_head','hybrid']},'correction_daily':daily_diagnostics,'scope':'exploratory; same reused dates; inner folds also used for tuning; no NAV claims'}
    save('results.json',results)
    check={}
    for name in arms:
        daily=frame.with_columns(((pl.col(name)-pl.col('gross_return'))**2).alias('sq')).group_by('date').agg(pl.col('sq').mean())
        measured=daily['sq'].mean();assert abs(measured-arms[name]['date_equal']['mse'])<1e-14
        check[name]=measured
    # Confirm the residual parameterization equals a direct-return prior-centered solve.
    z=np.column_stack((np.ones(len(x)),x));prior=np.zeros(z.shape[1]);prior[0]=recipe['extra_mean'];prior[-1]=recipe['extra_scale']
    w=base.date_weights(tr);a=z.T@(w[:,None]*z)+bestfinite['lambda']*np.eye(z.shape[1])
    direct=np.linalg.solve(a,z.T@(w*np.array([r['gross_return'] for r in tr]))+bestfinite['lambda']*prior)
    error=float(np.max(abs(direct-prior-beta)));assert error<1e-12
    assert max(r['label_known_date'] for r in tr)<'2026-08-20'
    save('verification.json',{'independent_polars_mse':check,'ridge_prior_equivalence_max_error':error,'full_pool_rows':len(held),'full_feature_count':31,'training_dates':len({r['date'] for r in tr}),'label_purge_checked':True,'control_key_and_outcome_parity':True,'full_native_nav_completed':False,'source_hashes':protocol['source_hashes'],'artifact_hashes':{n:sha(O/n) for n in ['protocol.json','cv.json','results.json','research-model.json','held-predictions.parquet','inner-predictions.parquet']}})
    print('HELD',json.dumps({k:v['date_equal'] for k,v in arms.items()}),flush=True)
    print('ANCHORED_COMPLETE',flush=True)
if __name__=='__main__':main()
