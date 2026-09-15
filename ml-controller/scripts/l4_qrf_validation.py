"""Preregistered finite-grid QRF versus frozen native controls, no serving writes."""
import os
os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
import json,hashlib,time,joblib
from pathlib import Path
import numpy as np
import polars as pl
from scipy.special import expit
from services import l4_distribution as base
from services.l4_distribution_lifecycle import chronological_validation_blocks
from services.l4_prediction_evaluation import mean_error
from l4_mean_preservation import summarize
from l4_qrf_research import LeafQRF

W=Path(__file__).resolve().parents[2];OUT=W/'audits/l4-design-repair/qrf-validation'
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(n,x):(OUT/n).write_text(json.dumps(x,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf-8',newline='\n')

def design(rows,forecasts,recipe=None):
    x,rec=base.design(rows,recipe['base'] if recipe else None)
    raw=np.array([forecasts[r['date'],r['symbol']] for r in rows]);w=base.date_weights(rows)
    mean=float(w@raw) if recipe is None else recipe['extra_mean']
    scale=max(.001,float(np.sqrt(w@((raw-mean)**2)))) if recipe is None else recipe['extra_scale']
    return np.column_stack((x,(raw-mean)/scale)),{'base':rec,'extra_mean':mean,'extra_scale':scale}

def mean_summary(rows,values):
    daily=[]
    for day in sorted({r['date'] for r in rows}):
        ids=[i for i,r in enumerate(rows) if r['date']==day]
        daily.append({'date':day,**mean_error(np.array([values[i] for i in ids]),np.array([rows[i]['gross_return'] for i in ids]))})
    return {'daily':daily,'date_equal':{k:float(np.mean([r[k] for r in daily])) for k in daily[0] if k!='date' and all(r[k] is not None for r in daily)}}

def main():
    paths=[W/'audits/l4-refactor/native-oof-rows.json',W/'audits/l4-regression/native-l3-predictions.json',W/'audits/l4-regression/native-three-fold-candidate.json']
    rows,forecasts,candidate=map(read,paths);forecasts={(r['date'],r['symbol']):r['native_l3_gross'] for r in forecasts}
    for path,expected in read(W/'audits/l4-regression/forecast-ablation-protocol.json')['inputs'].items():
        assert sha(Path(path))==expected,'31-feature-source-mismatch'
    assert len(forecasts)==len(rows)==len({(r['date'],r['symbol']) for r in rows})
    train=[r for r in rows if r['label_known_date']<'2026-08-20'];held=[r for r in rows if '2026-08-20'<=r['date']<='2026-09-01']
    assert len(train)==47159 and len(held)==11403
    assert all(r['prediction_kind']=='oof' and r['l3_training_label_known_max']<r['date']<r['label_known_date'] for r in train+held)
    fold_dates=chronological_validation_blocks(train);folds=[];audit=[]
    for dates in fold_dates:
        tr=[r for r in train if r['label_known_date']<min(dates)];va=[r for r in train if r['date'] in dates]
        tx,recipe=design(tr,forecasts);vx,_=design(va,forecasts,recipe)
        folds.append((tx,np.array([r['gross_return'] for r in tr]),base.date_weights(tr),vx,np.array([r['gross_return'] for r in va]),base.date_weights(va)))
        audit.append({'validation_dates':dates,'train_rows':len(tr),'validation_rows':len(va),'train_label_known_max':max(r['label_known_date'] for r in tr)})
    tx,recipe=design(train,forecasts);vx,_=design(held,forecasts,recipe);ty=np.array([r['gross_return'] for r in train]);tw=base.date_weights(train)
    head31=read(W/'audits/l4-regression/native31_with_l3_forecast-research-heads.json')
    assert head31['recipe']==recipe,'31-feature-recipe-mismatch'
    config={'n_estimators':128,'bootstrap':True,'random_state':20260914,'n_jobs':2}
    grid=[{'min_samples_leaf':leaf,'max_features':features} for leaf in (128,512) for features in (.5,1.)]
    save('protocol.json',{'sources':{str(p.relative_to(W)):sha(p) for p in paths},'source_sha256':sha(Path(__file__)),'kernel_sha256':sha(Path(__file__).with_name('l4_qrf_research.py')),'forest':config,'grid':grid,'select':'mean of three date-weighted validation mean MSE; no heldout tuning','folds':audit,'train_rows':len(train),'held_rows':len(held),'feature_count':31,'native31_recipe_exact_match':True,'scope':'reused historical diagnostic, offline fit only'})
    cv=[]
    for knobs in grid:
        losses=[];started=time.time()
        for i,(x,y,w,v,vy,vw) in enumerate(folds):
            model=LeafQRF(**config,**knobs).fit(x,y,w)
            pred=model.forest.predict(v);losses.append(float(vw@((pred-vy)**2)))
            print('CV',knobs,'fold',i,'MSE',losses[-1],flush=True)
        cv.append({**knobs,'fold_mse':losses,'mean_mse':float(np.mean(losses)),'seconds':time.time()-started})
        save('cv.json',cv)
    chosen=min(cv,key=lambda r:(r['mean_mse'],-r['min_samples_leaf'],r['max_features']))
    print('SELECTED',chosen,flush=True)
    model=LeafQRF(**config,min_samples_leaf=chosen['min_samples_leaf'],max_features=chosen['max_features']).fit(tx,ty,tw)
    outputs=model.predict(vx);forest_error=max(abs(p['expected_return_gross']-v) for p,v in zip(outputs,model.forest.predict(vx)))
    assert forest_error<1e-12
    controls=base.predict(held,candidate['model'])
    heads={h:expit(vx@np.asarray(head31['heads'][h]['beta'])+head31['heads'][h]['intercept']) if h=='p_loss' else np.maximum(0,vx@np.asarray(head31['heads'][h]['beta'])+head31['heads'][h]['intercept']) for h in base.HEADS}
    mu=(1-heads['p_loss'])*heads['gain']-heads['p_loss']*heads['loss']
    control31=[{**{h:float(v[i]) for h,v in heads.items()},'expected_return_gross':float(mu[i])} for i in range(len(held))]
    native=[forecasts[r['date'],r['symbol']] for r in held]
    results={'scope':'same native historical OOF full pool, reused9 diagnostic','dates':sorted({r['date'] for r in held}),'train_rows':len(train),'held_rows':len(held),'chosen':chosen,'forest_mean_parity_error':forest_error,'arms':{'native_l3':mean_summary(held,native),'three_head30':summarize(held,controls),'three_head31':summarize(held,control31),'qrf31':summarize(held,outputs)}}
    sealed=[]
    for i,r in enumerate(held):
        item={'date':r['date'],'symbol':r['symbol'],'gross_return':r['gross_return'],'label_known_date':r['label_known_date'],'native_l3_mean':native[i]}
        for name,pred in [('three_head30',controls),('three_head31',control31),('qrf31',outputs)]:
            item.update({name+'_'+key:pred[i][key] for key in ['expected_return_gross','p_loss','gain','loss']})
        sealed.append(item)
    pl.DataFrame(sealed).write_parquet(OUT/'predictions.parquet')
    joblib.dump({'qrf':model,'recipe':recipe,'scope':'offline_research_only'},OUT/'qrf31.joblib',compress=3)
    save('results.json',results)
    print('METRICS',json.dumps({k:v['date_equal'] for k,v in results['arms'].items()}),flush=True)
    print('EXACT_CDF_CRPS_START',flush=True)
    crps=model.crps(vx,[r['gross_return'] for r in held]);daily=[]
    for day in results['dates']:
        idx=np.array([r['date']==day for r in held]);daily.append({'date':day,'crps':float(crps[idx].mean())})
    results['arms']['qrf31']['crps']={'daily':daily,'date_equal':float(np.mean([r['crps'] for r in daily]))}
    save('results.json',results)
    print('QRF_VALIDATION_COMPLETE',results['arms']['qrf31']['crps']['date_equal'],flush=True)

if __name__=='__main__':main()
