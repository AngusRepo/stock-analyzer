"""Offline simplification experiment using frozen forecasts and matured errors.

No serving model imports this file. No parameter search, base/head retraining,
new serving artifact or portfolio outperformance claim.
"""
import json
from pathlib import Path
import numpy as np
from services.l4_distribution import date_weights, digest, predict
from services.l4_prediction_evaluation import binary_metrics, mean_error

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'audits/l4-design-repair/mean-preservation'


class EmpiricalError:
    """One weighted residual distribution; all conditional moments agree."""
    def __init__(self, residuals, weights, *, centered):
        e=np.asarray(residuals,float);w=np.asarray(weights,float)
        if e.ndim!=1 or not len(e) or e.shape!=w.shape or not np.isfinite(e).all() or not np.isfinite(w).all() or np.any(w<=0):
            raise ValueError('invalid_empirical_errors')
        w=w/w.sum();self.bias=float(w@e)
        e=e-self.bias if centered else e
        order=np.argsort(e,kind='stable');self.e=e[order];self.w=w[order]
        self.mass=np.r_[0,np.cumsum(self.w)];self.mass[-1]=1.
        self.first=np.r_[0,np.cumsum(self.w*self.e)]
        self.mean=float(self.first[-1])
        self.half_pair_distance=float(np.sum(self.w*(self.e*self.mass[:-1]-self.first[:-1])))
        self.centered=centered

    def distribution(self, means):
        mu=np.asarray(means,float)
        if mu.ndim!=1 or not np.isfinite(mu).all():raise ValueError('invalid_means')
        k=np.searchsorted(self.e,-mu,side='left')
        p=self.mass[k];neg=-(mu*p+self.first[k]);pos=mu*(1-p)+self.mean-self.first[k]
        gain=np.divide(pos,1-p,out=np.zeros_like(pos),where=p<1)
        loss=np.divide(neg,p,out=np.zeros_like(neg),where=p>0)
        net_k=np.searchsorted(self.e,.0018-mu,side='right')
        return [{'p_loss':float(p[i]),'gain':float(max(0,gain[i])),'loss':float(max(0,loss[i])),
            'expected_return_gross':float(mu[i] if self.centered else mu[i]+self.mean),
            'probability_positive_net_return':float(1-self.mass[net_k[i]]),
            'gain_defined':bool(p[i]<1),'loss_defined':bool(p[i]>0),
            'horizon_sessions':5,'output_is_net_of_costs':False,'l4plus_status':'disabled',
            'support_min_gross':float(mu[i]+self.e[0])} for i in range(len(mu))]

    def crps(self, means, outcomes):
        z=np.asarray(outcomes)-np.asarray(means)
        k=np.searchsorted(self.e,z,side='right')
        return z*(2*self.mass[k]-1)+self.mean-2*self.first[k]-self.half_pair_distance


def summarize(rows, outputs):
    dates=np.asarray([r['date'] for r in rows]);y=np.asarray([r['gross_return'] for r in rows])
    mu=np.asarray([r['expected_return_gross'] for r in outputs]);p=np.asarray([r['p_loss'] for r in outputs])
    g=np.asarray([r['gain'] for r in outputs]);l=np.asarray([r['loss'] for r in outputs]);daily=[]
    for day in sorted(set(dates)):
        i=dates==day;yi=y[i];gi=g[i];li=l[i]
        daily.append({'date':day,'rows':int(i.sum()),**mean_error(mu[i],yi),**binary_metrics(p[i],yi<0),
            'predicted_loss_rate':float(p[i].mean()),'observed_loss_rate':float((yi<0).mean()),
            'gain_mse':float(np.mean((gi[yi>=0]-yi[yi>=0])**2)),
            'loss_mse':float(np.mean((li[yi<0]+yi[yi<0])**2))})
    aggregate={key:float(np.mean([d[key] for d in daily])) for key in daily[0] if key not in ('date','rows') and all(d[key] is not None for d in daily)}
    return {'rows':len(rows),'date_count':len(daily),'date_equal':aggregate,'daily':daily,
        'max_moment_identity_error':float(np.max(abs((1-p)*g-p*l-mu)))}


def matured_history(rows, baselines, before):
    train=[r for r in rows if r['label_known_date']<before]
    if len({(r['date'],r['symbol']) for r in train})!=len(train):raise ValueError('duplicate_error_history')
    for r in train:
        if r.get('prediction_kind')!='oof' or not r['l3_training_label_known_max']<r['date']<r['label_known_date']<before:
            raise ValueError('error_history_not_point_in_time')
    if not train:return [],np.array([]),np.array([])
    errors=np.asarray([r['gross_return']-baselines[r['date'],r['symbol']] for r in train])
    return train,errors,date_weights(train)


def rolling_check(rows,baselines):
    collected={'centered':[],'raw':[],'unconditional':[]};eligible=[];history=[]
    for day in sorted({r['date'] for r in rows}):
        train,e,w=matured_history(rows,baselines,day)
        if not train:continue
        held=[r for r in rows if r['date']==day]
        mu=np.asarray([baselines[r['date'],r['symbol']] for r in held])
        for name,cdf,location in [('centered',EmpiricalError(e,w,centered=True),mu),
            ('raw',EmpiricalError(e,w,centered=False),mu),
            ('unconditional',EmpiricalError([r['gross_return'] for r in train],w,centered=False),np.zeros(len(mu)))]:
            collected[name].extend(cdf.distribution(location))
        eligible.extend(held)
        history.append({'date':day,'prior_rows':len(train),'prior_dates':len({r['date'] for r in train}),
            'prior_label_known_max':max(r['label_known_date'] for r in train),'residual_bias':float(w@e)})
    return {'scope':'all_available_dates_expanding_matured_error_statistics_not_new_untouched_confirmation',
        'update_cadence':'daily_diagnostic_not_a_serving_schedule_proposal',
        'eligible_dates':history,'cases':{name:summarize(eligible,pred) for name,pred in collected.items()}}


def main():
    read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
    source=[ROOT/'audits/l4-refactor/native-oof-rows.json',ROOT/'audits/l4-regression/native-l3-predictions.json',ROOT/'audits/l4-regression/native-three-fold-candidate.json']
    rows,forecasts,bundle=map(read,source)
    baseline={(r['date'],r['symbol']):r['native_l3_gross'] for r in forecasts}
    assert len(baseline)==len(forecasts)==len(rows)
    first='2026-08-20'
    train,errors,weights=matured_history(rows,baseline,first)
    held=[r for r in rows if r['date']>bundle['training_label_known_max']]
    assert digest(train)==bundle['training_rows_checksum'] and min(r['date'] for r in held)==first
    mu=np.asarray([baseline[r['date'],r['symbol']] for r in held]);y=np.asarray([r['gross_return'] for r in held]);w=date_weights(held)
    result={'scope':'reused_historical_oof_diagnostic_no_promotion','training_rows':len(train),
        'training_dates':len({r['date'] for r in train}),'training_label_known_max':max(r['label_known_date'] for r in train),
        'evaluation_dates':sorted({r['date'] for r in held}),'model_checksum':bundle['model_checksum'],
        'protocol':{'frozen_cutoff':first,'parameter_search':False,'new_base_or_three_head_fit':False,
            'centered_and_raw_reported_without_holdout_selection':True,'distribution_output_not_connected_to_allocator':True,
            'top_k':None,'weighting':'equal_date_then_equal_security'},'cases':{}}
    frozen=predict(held,bundle['model']);result['cases']['current_three_head']=summarize(held,frozen)
    for name,centered in [('l3_centered_error',True),('l3_raw_error',False)]:
        cdf=EmpiricalError(errors,weights,centered=centered);output=cdf.distribution(mu)
        summary=summarize(held,output)
        summary.update(error_bias=cdf.bias,distribution_error_mean=cdf.mean,
            support_below_minus_one_rows=sum(o['support_min_gross']< -1 for o in output),
            mean_shift_min=min(o['expected_return_gross']-m for o,m in zip(output,mu)),
            mean_shift_max=max(o['expected_return_gross']-m for o,m in zip(output,mu)),
            date_equal_crps=float(w@cdf.crps(mu,y)),
            not_extrapolated_beyond_empirical_error_support=True)
        assert summary['max_moment_identity_error']<1e-12
        if centered:assert max(abs(summary['mean_shift_min']),abs(summary['mean_shift_max']))<1e-12
        result['cases'][name]=summary
    # A real naive comparator for probability/magnitude, not a fictitious L3 distribution.
    naive=EmpiricalError([r['gross_return'] for r in train],weights,centered=False)
    result['cases']['unconditional_training_return']=summarize(held,naive.distribution(np.zeros(len(mu))))
    result['cases']['unconditional_training_return']['date_equal_crps']=float(w@naive.crps(np.zeros(len(mu)),y))
    result['rolling_sensitivity']=rolling_check(rows,baseline)
    import hashlib
    result['source_checksums']={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source}
    (OUT/'results.json').write_text(json.dumps(result,indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps({'fixed':{k:v['date_equal'] for k,v in result['cases'].items()},
        'rolling':{k:v['date_equal'] for k,v in result['rolling_sensitivity']['cases'].items()},
        'rolling_days':len(result['rolling_sensitivity']['eligible_dates'])},indent=2))

if __name__=='__main__':main()
