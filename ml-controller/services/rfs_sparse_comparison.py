"""Comparison-only RFS-inspired cost frontier on the released B sparse inputs.

No model fit, no new account, no order authority. A static proximal aim supplies
linear preference to exactly the incumbent's discrete constraints. Outcome labels are
fixed-basket adjusted-close experiments, never represented as actual Paper NAV.
"""
from copy import deepcopy
import numpy as np
from services.l4_distribution import digest
from services.l4_portfolio import allocate

SCHEMA = 'rfs-b-sparse-comparison-v1'


def build_comparison(plan, rows, history, account):
    from services.l4_dated_risk import is_dated_risk, estimate_risk
    from services.similarity_evidence import ledoit_wolf_covariance
    if (plan.get('owner') != 'l4_distribution' or plan.get('execution_scope') != 'paper'
            or plan.get('account_id') != 1 or digest(account) != plan['account_checksum']
            or digest({k:v for k,v in plan.items() if k!='plan_id'}) != plan['plan_id']):
        raise ValueError('rfs_formal_plan_identity_invalid')
    symbols = sorted(plan['targets'])
    if not symbols or len(symbols)>3000: raise ValueError('rfs_candidate_bound')
    n=len(symbols);targets=plan['targets'];by_symbol={r['symbol']:r for r in rows}
    current=np.array([targets[s]['current_weight'] for s in symbols],float)
    gross=np.array([targets[s]['expected_return_gross'] or 0. for s in symbols],float)
    locked={s for s in symbols if targets[s]['locked']}
    forbidden=set(plan['forbidden_buys'])
    if any(targets[s]['expected_return_gross'] is None and s not in locked|forbidden for s in symbols):
        raise ValueError('rfs_missing_alpha_not_locked')
    if is_dated_risk(history):
        if history['signal_date']!=plan['signal_date']:raise ValueError('rfs_risk_date_mismatch')
        risk=estimate_risk(history,symbols)
    else:
        risk=ledoit_wolf_covariance(symbols,history,daily_vol_floor=.01)
    horizon=plan['risk_evidence']['covariance_horizon_sessions']
    covariance=np.asarray(risk['covariance'])*horizon
    knobs=plan['utility_parameters'];limits=plan['constraints']
    fees=account['fees'];buy=float(fees['buy_cost']);sell=float(fees['sell_cost'])
    incumbent_delta=np.array([plan['weights'][s] for s in symbols])-current
    incumbent_cost=float(buy*np.maximum(incumbent_delta,0).sum()+sell*np.maximum(-incumbent_delta,0).sum())
    if 'expected_trading_cost' in plan and abs(incumbent_cost-plan['expected_trading_cost'])>1e-8:
        raise ValueError('rfs_formal_cost_mismatch')
    capital=min(1.,float(current.sum())+account['available_cash']/account['nav'])
    pressure=np.array([plan['risk_evidence']['turnover_pressure_by_symbol'][s] for s in symbols])
    mu=gross*knobs['alpha_strength']-knobs['turnover_penalty']*pressure
    q=covariance*knobs['risk_aversion']+np.eye(n)*knobs['l2_penalty']
    adv=[]
    for s in symbols:
        row=by_symbol.get(s,{})
        value=next((row[k] for k in ('avg_daily_turnover_twd','adv_twd','adtv_twd') if row.get(k)),None)
        adv.append(float(value) if value is not None else np.nan)
    adv=np.asarray(adv);missing=~np.isfinite(adv)|(adv<=0)
    # Unknown ADV cannot silently become zero impact. Require it for every
    # candidate which could trade; locked or zero-forbidden names are inert.
    required=np.array([s not in locked and (s not in forbidden or current[i]>0) for i,s in enumerate(symbols)])
    missing_symbols=[s for s,b in zip(symbols,missing & required) if b]
    base={'schema_version':SCHEMA,'method':'rfs_static_proximal_aim_linear_preference_shared_constraints',
          'signal_date':plan['signal_date'],'plan_id':plan['plan_id'],'policy_identity':plan['policy_identity'],
          'model_checksum':plan['model_checksum'],'production_effect':False,'promotion_eligible':False,
          'incumbent_role':'sparse_allocator_production_owner','source_expected_return_candidate_count':int(sum(targets[s]['expected_return_gross'] is not None for s in symbols)),
          'excluded_missing_adv_symbols':missing_symbols,'candidate_symbols':symbols,
          'input_checksum':digest({'symbols':symbols,'gross':gross.tolist(),'covariance':covariance.tolist(),
              'current':current.tolist(),'constraints':limits,'utility':knobs,'capital':capital,'fees':fees,
              'adv':{s:None if missing[i] else float(adv[i]) for i,s in enumerate(symbols)},'forbidden':sorted(forbidden)}),
          'incumbent_weights':deepcopy(plan['weights']),'fees':deepcopy(fees),
          'outcome_semantic':'fixed_basket_adjusted_close_5_20_sessions_not_actual_account_NAV',
          'research_limitations':['static_frontier_no_trained_direct_weight_model','aim_to_discrete_portfolio_is_linear_preference_not_exact_quadratic_projection','impact_coefficient_assumed_10bps','no_intraday_fills_or_minimum_commission_simulation']}
    if missing_symbols:
        return seal({**base,'status':'blocked','validation_blockers':['tradability_adv_missing'], 'weights':{}})
    adv=np.where(missing,1.,adv)
    step=1/max(1e-8,2*np.max(np.abs(q).sum(axis=1)))
    step=min(step,10.)
    upper=np.array([min(limits['name_cap'],limits.get('name_caps',{}).get(s,1.)) for s in symbols])
    lower=np.zeros(n)
    for i,s in enumerate(symbols):
        if s in forbidden:upper[i]=min(upper[i],current[i])
        if s in locked:lower[i]=upper[i]=current[i]
    aim=current.copy()
    for _ in range(120):
        delta=aim-current
        impact=.001*1.5*np.sqrt(np.abs(delta)*account['nav']/adv)*np.sign(delta)
        z=aim+step*(mu-2*q@aim-impact)-current
        proposal=current+np.maximum(z-step*buy,0)+np.minimum(z+step*sell,0)
        aim=np.clip(proposal,lower,upper)
        # Convex capped-budget projection, retaining all names before the
        # common discrete projector; never top-k preselect.
        if aim.sum()>limits['exposure_cap']:
            lo,hi=0.,float(max(aim-lower))
            for _ in range(40):
                mid=(lo+hi)/2
                if np.clip(aim-mid,lower,upper).sum()>limits['exposure_cap']:lo=mid
                else:hi=mid
            aim=np.clip(aim-hi,lower,upper)
    # The aim contains covariance/impact aversion. Implement its preferences
    # through one bounded linear MILP with all formal constraints. Avoid a
    # second expensive quadratic solve just to collect research evidence.
    projected=allocate(symbols=symbols,expected_gross=aim.tolist(),covariance=np.zeros((n,n)),
        current_weights=current.tolist(),capital_available=capital,locked_symbols=locked,forbidden_buys=forbidden,
        exposure_cap=limits['exposure_cap'],name_cap=limits['name_cap'],min_weight=limits['min_weight'],
        max_positions=limits['max_positions'],name_caps=limits.get('name_caps'),
        exposure_groups=limits.get('exposure_groups'),buy_cost=buy,sell_cost=sell,risk_aversion=0.,time_limit=3.)
    candidate=np.array([projected['weights'][s] for s in symbols]);incumbent=np.array([plan['weights'][s] for s in symbols])
    def metrics(w):
        d=w-current
        linear=buy*np.maximum(d,0).sum()+sell*np.maximum(-d,0).sum()
        impact=float((np.abs(d)*.001*np.sqrt(np.abs(d)*account['nav']/adv)).sum())
        return {'expected_gross':float(gross@w),'linear_rebalance_cost':float(linear),'impact_cost':impact,
                'risk_penalty':float(w@q@w),'utility':float(mu@w-w@q@w-linear-impact)}
    return seal({**base,'status':'collecting','validation_blockers':[],
        'weights':{s:float(w) for s,w in zip(symbols,candidate) if w>1e-7},
        'incumbent_metrics':metrics(incumbent),'challenger_metrics':metrics(candidate),
        'constraint_proof':projected['proof'],'no_preselection':True})


def seal(packet):
    return {**packet,'packet_checksum':digest(packet)}


def adjusted_basket_outcome(packet, bars, sessions, horizon):
    """Entry first completed canonical close after collection; then H sessions.
    Both baskets use the same entry/exit, adjustment factors and cost schedule.
    Missing/suspended/delisted prices block the whole pair, never disappear.
    """
    if len(sessions)<=horizon:return None
    first,last=sessions[0],sessions[horizon]
    universe={s for side in ('weights','incumbent_weights') for s,w in packet[side].items() if w>1e-7}
    returns={}
    for s in sorted(universe):
        a=bars.get((s,first));b=bars.get((s,last))
        if a is None or b is None or not np.isfinite([a,b]).all() or min(a,b)<=0:return None
        returns[s]=b/a-1
    def pnl(side,metric):
        weights=packet[side]
        gross=sum(w*returns[s] for s,w in weights.items() if w>1e-7)
        # Incremental rebalance from the shared inherited portfolio, plus
        # common hypothetical terminal liquidation. Cash earns zero.
        exit_cost=packet['fees']['sell_cost']*sum(w*(1+returns[s]) for s,w in weights.items() if w>1e-7)
        return gross-packet[metric]['linear_rebalance_cost']-packet[metric]['impact_cost']-exit_cost
    incumbent=pnl('incumbent_weights','incumbent_metrics');challenger=pnl('weights','challenger_metrics')
    return {'horizon':horizon,'entry_date':first,'exit_date':last,'incumbent_net':incumbent,
            'challenger_net':challenger,'delta':challenger-incumbent,
            'price_checksum':digest({s:{'entry':bars[(s,first)],'exit':bars[(s,last)]} for s in sorted(universe)}),
            'semantic':packet['outcome_semantic']}
