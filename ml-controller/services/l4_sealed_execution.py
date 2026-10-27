"""Pre-seal decision evidence and conditional exits; never reallocate a live plan."""
import re
from datetime import date
import numpy as np
from services.l4_distribution import digest
from services.l4_numeric_contract import WEIGHT_SUPPORT

SCHEMA='l4-sealed-execution-v1'

def execution_inputs(policy, runtime, symbols, model_checksum, signal_date, covariance_horizon):
    config=policy.get('sealedExecution')
    if config is None:return None,np.zeros(len(symbols)),np.zeros(len(symbols)),np.zeros(len(symbols))
    keys={'schema_version','rotation_mode','expiry','require_matched_risk_horizon','uncertainty_calibration_checksum',
          'minimum_calibration_dates','execution_cost_calibration_checksum','minimum_cost_observations','minimum_covariance_windows'}
    if not isinstance(config,dict) or set(config)-keys:raise ValueError('l4_sealed_execution_policy_invalid')
    if (config.get('schema_version')!=SCHEMA or config.get('rotation_mode')!='selected_ready_or_filled'
        or config.get('expiry')!='retain_until_next_seal'):
        raise ValueError('l4_sealed_execution_policy_invalid')
    if config.get('require_matched_risk_horizon') and covariance_horizon!=5:
        raise ValueError('l4_sealed_risk_horizon_not_matched')
    uncertainty=np.zeros(len(symbols))
    calibration=config.get('uncertainty_calibration_checksum')
    date.fromisoformat(signal_date)
    if calibration is not None:
        if not isinstance(calibration,str) or not re.fullmatch('[a-f0-9]{64}',calibration):raise ValueError('l4_uncertainty_calibration_identity_invalid')
        evidence=runtime.get('sealed_execution_evidence') or {}
        minimum=config.get('minimum_calibration_dates')
        if (type(minimum) is not int or minimum<1 or evidence.get('schema_version')!='l4-oos-trade-uncertainty-v1'
            or evidence.get('calibration_checksum')!=calibration or evidence.get('model_checksum')!=model_checksum
            or evidence.get('signal_date')!=signal_date or evidence.get('horizon_sessions')!=5
            or evidence.get('known_date_max','9999-12-31')>signal_date
            or evidence.get('independent_dates',0)<minimum or evidence.get('status')!='validated_oos'
            or not evidence.get('source_reference')
            or evidence.get('checksum')!=digest({k:v for k,v in evidence.items() if k!='checksum'})):
            raise ValueError('l4_oos_uncertainty_evidence_missing')
        date.fromisoformat(evidence['known_date_max'])
        by_symbol=evidence.get('absolute_return_error_by_symbol') or {}
        if set(symbols)-set(by_symbol):raise ValueError('l4_oos_uncertainty_coverage_missing')
        uncertainty=np.array([by_symbol[s] for s in symbols],float)
        if not np.isfinite(uncertainty).all() or (uncertainty<0).any():raise ValueError('l4_oos_uncertainty_invalid')
    buy_extra=np.zeros(len(symbols));sell_extra=np.zeros(len(symbols))
    if config.get('execution_cost_calibration_checksum') is not None:
        if not re.fullmatch('[a-f0-9]{64}',str(config['execution_cost_calibration_checksum'])):raise ValueError('l4_cost_calibration_identity_invalid')
        evidence=runtime.get('sealed_execution_cost_evidence') or {};minimum=config.get('minimum_cost_observations')
        if (type(minimum) is not int or minimum<1 or evidence.get('schema_version')!='l4-observed-execution-cost-v1'
            or evidence.get('calibration_checksum')!=config['execution_cost_calibration_checksum']
            or evidence.get('signal_date')!=signal_date or evidence.get('known_date_max','9999-12-31')>signal_date
            or evidence.get('status')!='verified_execution_receipts' or evidence.get('observations',0)<minimum
            or not evidence.get('source_reference')
            or evidence.get('checksum')!=digest({k:v for k,v in evidence.items() if k!='checksum'})):
            raise ValueError('l4_execution_cost_evidence_missing')
        date.fromisoformat(evidence['known_date_max'])
        for field,target in [('additional_buy_cost_by_symbol',buy_extra),('additional_sell_cost_by_symbol',sell_extra)]:
            values=evidence.get(field) or {}
            if set(symbols)-set(values):raise ValueError('l4_execution_cost_coverage_missing')
            target[:]=[values[s] for s in symbols]
            if not np.isfinite(target).all() or (target<0).any():raise ValueError('l4_execution_cost_invalid')
    return config,uncertainty,buy_extra,sell_extra

def aligned_covariance(config,runtime,symbols,signal_date,horizon,existing):
    if config is None or not config.get('require_matched_risk_horizon'):return existing,None
    evidence=runtime.get('five_session_risk_evidence') or {};minimum=config.get('minimum_covariance_windows')
    if (horizon!=5 or type(minimum) is not int or minimum<2
        or evidence.get('schema_version')!='l4-measured-horizon-covariance-v1' or evidence.get('horizon_sessions')!=5
        or evidence.get('symbols')!=symbols or evidence.get('signal_date')!=signal_date
        or evidence.get('known_date_max','9999-12-31')>signal_date or evidence.get('observed_windows',0)<minimum
        or evidence.get('method') not in ['observed_nonoverlapping_five_session_returns','autocovariance_adjusted_five_session_returns',
                                         'observed_pairwise_nonoverlapping_five_session_returns']
        or not evidence.get('source_reference')
        or evidence.get('checksum')!=digest({k:v for k,v in evidence.items() if k!='checksum'})):
        raise ValueError('l4_measured_five_session_covariance_missing')
    date.fromisoformat(evidence['known_date_max'])
    if evidence['method']=='observed_pairwise_nonoverlapping_five_session_returns':
        coverage=evidence.get('coverage') or {};counts=np.asarray(evidence.get('pair_observation_counts'))
        if (evidence.get('minimum_windows')!=minimum or set(coverage)!=set(symbols)
                or counts.shape!=(len(symbols),len(symbols)) or not np.issubdtype(counts.dtype,np.integer)
                or (counts<0).any() or not np.array_equal(counts,counts.T)
                or (counts>np.minimum.outer(np.diag(counts),np.diag(counts))).any()
                or any(coverage[s].get('observed_windows')!=int(counts[i,i])
                       or coverage[s].get('new_buys_allowed') is not bool(counts[i,i]>=minimum)
                       for i,s in enumerate(symbols))
                or evidence.get('forbidden_buys')!=[s for s in symbols if counts[symbols.index(s),symbols.index(s)]<minimum]
                or not any(counts[i,i]>=minimum for i in range(len(symbols)))):
            raise ValueError('l4_measured_covariance_coverage_invalid')
    matrix=np.asarray(evidence.get('covariance'),float)
    if matrix.shape!=(len(symbols),len(symbols)) or not np.isfinite(matrix).all() or (len(symbols) and (
        np.max(abs(matrix-matrix.T))>1e-10 or np.linalg.eigvalsh(matrix)[0]<-1e-10)):
        raise ValueError('l4_measured_covariance_invalid')
    return matrix,{k:v for k,v in evidence.items() if k not in ('covariance','pair_observation_counts')}

def seal_execution_evidence(config, symbols, current, gross, covariance, result, nav, uncertainty, locked_symbols=()):
    if config is None:return None
    current=np.asarray(current,float);mu=np.asarray(gross,float)
    targets=np.array([result['weights'][s] for s in symbols]);c=result['constraints']
    parameters=result['utility_parameters']
    def feasible(w):
        if w.sum()>c['exposure_cap']+1e-8 or (w>WEIGHT_SUPPORT).sum()>(c['max_positions'] or len(symbols)):return False
        if any(w[i]>min(c['name_cap'],c.get('name_caps',{}).get(s,1.))+1e-8 for i,s in enumerate(symbols) if s not in locked_symbols):return False
        if any(WEIGHT_SUPPORT<w[i]<c['min_weight']-1e-8 for i,s in enumerate(symbols) if s not in locked_symbols):return False
        for group in c.get('membership_groups',{}).values():
            if sum(w[symbols.index(s)]>WEIGHT_SUPPORT for s in group['symbols'])>group['effective_count']:return False
        for group in c.get('exposure_groups',{}).values():
            if sum(w[symbols.index(s)] for s in group['symbols'])>group['effective_cap']+1e-8:return False
        for pair in c.get('excluded_pairs',[]):
            i,j=[symbols.index(s) for s in pair]
            if w[i]>WEIGHT_SUPPORT and w[j]>WEIGHT_SUPPORT and not (current[i]>WEIGHT_SUPPORT and current[j]>WEIGHT_SUPPORT and w[i]<=current[i]+1e-8 and w[j]<=current[j]+1e-8):return False
        return True
    # Costed target and hold/cash candidates use the SAME sealed inputs.
    def utility(w):
        delta=w-current
        # Hold/cash exits must price trades exactly as the MILP objective did.
        buy_costs=np.asarray(result.get('_objective_entry_costs',result.get('_buy_costs',np.full(len(symbols),result['_buy_cost']))))
        sell_costs=np.asarray(result.get('_objective_reduce_costs',result.get('_sell_costs',np.full(len(symbols),result['_sell_cost']))))
        costs=buy_costs@np.maximum(delta,0)+sell_costs@np.maximum(-delta,0)
        pressure=np.asarray(result.get('_turnover_pressure',np.zeros(len(symbols))),float)
        score=(parameters['alpha_strength']*mu-parameters['turnover_penalty']*pressure)@w
        risk=parameters['risk_aversion']*(w@covariance@w)+parameters['l2_penalty']*(w@w)
        ambiguity=uncertainty@abs(delta)
        return {'feasible':feasible(w),'utility':float(score-risk-costs-ambiguity),'exposure':float(w.sum()),
                'gross':float(mu@w),'risk':float(risk),'costs':float(costs),'uncertainty_penalty':float(ambiguity)}
    cash_weights=np.array([current[i] if s in locked_symbols else 0. for i,s in enumerate(symbols)])
    hold=utility(current);cash=utility(cash_weights)
    buy_capacity={s:max(0.,targets[i]-current[i])*nav for i,s in enumerate(symbols)}
    used={s:0. for s in symbols};rules={}
    for i,s in enumerate(symbols):
        reduction=max(0.,current[i]-targets[i])*nav
        if reduction<=1e-8:continue
        # Hard infeasibility and cash-preferred exits never wait for replacement.
        if not hold['feasible'] or mu[i]<=0 or hold['utility']<=cash['utility']:
            rules[s]={'mode':'unconditional','reason':'cash_or_risk_preferred'};continue
        # Sell and buy fees consume part of a funded rotation. Do not demand
        # that a replacement reinvest the gross pre-fee sale value.
        sell_rate=result.get('_sell_costs',[result['_sell_cost']]*len(symbols))[i]
        buy_rate=max(result.get('_buy_costs',[result['_buy_cost']]*len(symbols)),default=result['_buy_cost'])
        remaining=reduction*(1-sell_rate)/(1+buy_rate);credits=[]
        for candidate in sorted(symbols,key=lambda v:(-mu[symbols.index(v)],v)):
            available=buy_capacity[candidate]-used[candidate]
            take=min(remaining,available)
            if take<=1e-8:continue
            credits.append({'symbol':candidate,'credit_start':used[candidate],'credit_end':used[candidate]+take})
            used[candidate]+=take;remaining-=take
            if remaining<=1e-8:break
        if remaining>1e-8:
            for credit in credits:used[credit['symbol']]-=credit['credit_end']-credit['credit_start']
            credits=[]
        rules[s]={'mode':'selected_ready_or_filled' if remaining<=1e-8 else 'retain_until_next_seal',
                  'credits':credits,'expiry':'retain_until_next_seal','reason':'positive_incumbent_conditional_rotation'}
    scenarios={'hold_current':hold,'cash_after_exit':cash,'ideal_targets':utility(targets)}
    # Deterministic stress cases are not invented fill probabilities or forecasts.
    for name,fills in [('no_new_fills',{}),('all_new_fills',{s:1. for s in symbols})]+[
        ('missing_'+s,{v:float(v!=s) for v in symbols}) for s in symbols if buy_capacity[s]>0]:
        w=current+np.maximum(targets-current,0)*np.array([fills.get(s,0.) for s in symbols])
        for i,s in enumerate(symbols):
            if targets[i]>=current[i]:continue
            rule=rules[s]
            passed=rule['mode']=='unconditional' or rule['mode']=='selected_ready_or_filled' and all(
                buy_capacity[r['symbol']]*fills.get(r['symbol'],0.)>=r['credit_end']-1e-8 for r in rule['credits'])
            if passed:w[i]=targets[i]
        scenarios[name]=utility(w)
    return {'schema_version':SCHEMA,'rotation_mode':config['rotation_mode'],'expiry':config['expiry'],
            'exit_rules':rules,'decision_comparisons':scenarios,'scenario_probability_policy':'stress_only_no_invented_probabilities',
            'uncertainty_calibration_checksum':config.get('uncertainty_calibration_checksum'),
            'execution_cost_calibration_checksum':config.get('execution_cost_calibration_checksum')}
