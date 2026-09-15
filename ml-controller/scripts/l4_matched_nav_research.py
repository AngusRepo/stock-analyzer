"""Offline matched economic NAV experiment; never a formal Paper reward/release.
Native signed allocator + native OPB, frozen predictions, explicit daily-bar fills.
Adjusted units represent reinvested total return, NOT legal corporate entitlements.
"""
import os
os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
import argparse, hashlib, json, math, sys, time
from pathlib import Path
import numpy as np
import polars as pl
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ml-controller'))
from services.l4_allocation_contract import risk_groups,native_opb_policy
from services.l4_distribution_runtime import choose_opb
from services.l4_dated_risk import build_dated_risk,estimate_risk
from services.l4_portfolio import allocate
C=ROOT/'audits/l4-design-repair/final-adjudication/corrected-comparison'
OUT=C/'matched-nav-v2'
MODELS=('native_l3','three_head30','qrf31','hybrid')
INITIAL=1000000.
COMMISSION=.001425
TAX=.003

def save(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8',newline='\n')

def fee(value,side):
    return max(20,math.floor(value*COMMISSION+.5)), math.floor(value*TAX+.5) if side=='sell' else 0

def valid(value):
    return value is not None and math.isfinite(float(value)) and value>0

def execute(state,targets,quotes,previous_quotes,adjusted,previous_adjusted,slippage_bps, *, mark_prices=None,max_positions=None):
    """Targets fixed in adjusted economic units at previous close; no open alpha.
    Missing/locked bars are unfilled; observed zero volume cannot be executed.
    Cash affordability and previous-session participation constrain every fill.
    """
    units=dict(state['units']);cash=state['cash'];fills=[];skipped=[];factors=[]
    slip=slippage_bps/10000.
    for s,u in units.items():
        q,p=quotes.get(s,{}),previous_quotes.get(s,{})
        if all(valid(x) for x in (q.get('close'),p.get('close'),adjusted.get(s),previous_adjusted.get(s))):
            ratio=(adjusted[s]/q['close'])/(previous_adjusted[s]/p['close'])
            if abs(ratio-1)>1e-5:factors.append({'symbol':s,'ratio':ratio,'economic_units':u})
    desired=targets if targets is not None else units
    for side in ('sell','buy'):
        for s in sorted(set(units)|set(desired)):
            delta=desired.get(s,0.)-units.get(s,0.)
            if abs(delta)<1e-9 or (side=='buy')!=(delta>0):continue
            q,p=quotes.get(s,{}),previous_quotes.get(s,{})
            if not all(valid(x) for x in (q.get('open'),q.get('close'),adjusted.get(s))):
                skipped.append({'symbol':s,'side':side,'reason':'missing_open_or_adjustment'});continue
            if not valid(q.get('volume')) or not valid(p.get('volume')):
                skipped.append({'symbol':s,'side':side,'reason':'unavailable_liquidity'});continue
            if q.get('high')==q.get('low') and ((side=='buy' and q['open']>=p.get('close',q['open'])) or (side=='sell' and q['open']<=p.get('close',q['open']))):
                skipped.append({'symbol':s,'side':side,'reason':'one_price_bar_inaccessible'});continue
            if side=='buy' and s not in units and max_positions is not None and sum(u*(mark_prices or adjusted).get(k,0.)>=1 for k,u in units.items())>=max_positions:
                skipped.append({'symbol':s,'side':side,'reason':'actual_position_cap_after_failed_sells'});continue
            factor=adjusted[s]/q['close'];requested=math.floor(abs(delta)*factor+1e-9)
            quantity=min(requested,math.floor(p['volume']*.01))
            price=q['open']*(1+slip if side=='buy' else 1-slip)
            if side=='buy':
                quantity=min(quantity,max(0,math.floor((cash-20)/(price*(1+COMMISSION)))))
            if quantity<=0:
                skipped.append({'symbol':s,'side':side,'reason':'rounding_cash_or_participation','requested':requested});continue
            amount=quantity*price;commission,tax=fee(amount,side)
            if side=='buy':cash-=amount+commission
            else:cash+=amount-commission-tax
            units[s]=max(0.,units.get(s,0.)+(quantity/factor)*(1 if side=='buy' else -1))
            if units[s]<1e-9:units.pop(s,None)
            fills.append({'symbol':s,'side':side,'shares':quantity,'requested':requested,'price':price,'commission':commission,'tax':tax,'adjustment_factor':factor,'slippage_cost':quantity*abs(price-q['open'])})
    if cash < -1e-6:raise ValueError('negative_cash')
    stale=[s for s,u in units.items() if u>1e-9 and not valid(adjusted.get(s))]
    marks=adjusted if mark_prices is None else mark_prices
    missing=[s for s,u in units.items() if u>1e-9 and not valid(marks.get(s))]
    if missing:raise ValueError('held_close_missing:'+','.join(missing))
    nav=cash+sum(u*marks[s] for s,u in units.items())
    return {'cash':cash,'units':units,'nav':nav,'stale_symbols':stale},fills,skipped,factors

def load_inputs(*,diagnostic_label_pool=False,asof_dir=None):
    if asof_dir is not None:
        asof_dir=Path(asof_dir)
        receipt=json.loads((asof_dir/'asof-forecast-receipt.json').read_text())
        refpath=C.parent/'selection_reference.json'
        if receipt.get('future_labels_required') is not False or receipt.get('formal_route_sha256')!=hashlib.sha256(refpath.read_bytes()).hexdigest():
            raise ValueError('asof_decision_receipt_invalid')
        path=asof_dir/'held-predictions.parquet'
        if hashlib.sha256(path.read_bytes()).hexdigest()!=receipt.get('source_sha256'):
            raise ValueError('asof_forecast_checksum_mismatch')
        frame=pl.read_parquet(path)
        if 'l3_available' not in frame.columns:raise ValueError('asof_availability_mask_missing')
        ref=json.loads(refpath.read_text())
        expected={(r['signal_date'],r['symbol']) for resp in ref['responses'] for r in resp['results'] if r['hard_gate_passed']==1 and r['feature_available']==1 and r['strategy_selected']==1}
        actual=set(zip(frame['date'],frame['symbol']))
        if actual!=expected or len(actual)!=len(frame):raise ValueError('asof_formal_route_coverage_mismatch')
    else:
        if not diagnostic_label_pool:
            raise ValueError('l4_nav_requires_asof_decision_universe:held_predictions_are_mature_label_conditioned')
        frame=pl.read_parquet(C/'held-predictions.parquet').select('date','symbol',*MODELS)
    days=sorted(frame['date'].unique().to_list())
    forecasts={d:{r['symbol']:r for r in frame.filter(pl.col('date')==d).to_dicts()} for d in days}
    stocks={r['symbol']:r for r in pl.read_parquet(C/'source/stocks.parquet').to_dicts()}
    ids={v['id']:s for s,v in stocks.items()}
    quotes={}
    raw=pl.read_parquet(C/'source/prices.parquet').filter((pl.col('date')>=days[0])&(pl.col('date')<='2026-09-08'))
    for row in raw.to_dicts():
        s=ids.get(row['stock_id'])
        if s:quotes.setdefault(row['date'],{})[s]=row
    records={}
    for path in sorted((C/'source').glob('sequence-batch_*.npz')):
        for row in np.load(path,allow_pickle=True)['sequence_records'].tolist():
            records[row['symbol']]={str(d)[:10]:float(v) for d,v in zip(row['dates'],row['close']) if valid(v)}
    if asof_dir is not None:
        wide=pl.read_parquet(C/'source/canonical-close-raw/combined.parquet')
        dates=[str(d)[:10] for d in wide['date']]
        for symbol in wide.columns:
            if symbol=='date':continue
            observed=records.setdefault(symbol,{})
            for day,value in zip(dates,wide[symbol]):
                if not valid(value):continue
                if day in observed and abs(observed[day]-value)>1e-8:raise ValueError('canonical_source_overlap_mismatch')
                observed[day]=float(value)
    calendar=sorted({d for values in records.values() for d in values if days[0]<=d<='2026-09-08'})
    adj={d:{s:values[d] for s,values in records.items() if d in values} for d in calendar}
    return days,forecasts,stocks,quotes,records,calendar,adj

def risk_for(day,symbols,records):
    path=C/f'dated-risk/{day}.npz'
    archive=np.load(path) if path.exists() else None
    if archive is not None and archive['symbols'].tolist()==symbols:
        risk=json.loads((C/f'dated-risk/{day}.json').read_text())['risk']
        risk.update(covariance=archive['covariance'],graph_correlation=archive['graph_correlation'])
        return risk
    payload=[{'symbol':s,'prices':[{'date':d,'adj_close':v} for d,v in records.get(s,{}).items() if d<=day]} for s in symbols]
    return estimate_risk(build_dated_risk(payload,signal_date=day,lookback=252),symbols)

def run_path(model,cap,slip,inputs,dest):
    days,forecasts,stocks,quotes,records,calendar,adj=inputs
    identity=f'RESEARCH_ONLY:{model}:cap={cap}:slip={slip}'
    state={'cash':INITIAL,'units':{},'nav':INITIAL};ledger=[];plans=[];rewards=[];fills_all=[];peak=INITIAL
    pending=None;pending_plan=None;events=[];last_marks={};blocked_plans=[]
    for i,day in enumerate(calendar):
        last_marks.update(adj[day])
        if i:
            previous=calendar[i-1]
            before_nav=state['nav']
            state,fills,skips,factors=execute(state,pending,quotes.get(day,{}),quotes.get(previous,{}),adj[day],adj[previous],slip,mark_prices=last_marks,max_positions=cap)
            for fill in fills:fill['date']=day
            fills_all.extend(fills)
            if pending_plan is not None:
                rewards.append({'policy_identity':identity,'complete':not state['stale_symbols'],'known_date':day,
                    'reward_kind':'complete_policy_account_net_return','arm_id':pending_plan['opb']['arm_id'],
                    'reward':state['nav']/pending_plan['nav_at_decision']-1,'research_simulated':True})
            peak=max(peak,state['nav'])
            ledger.append({'date':day,**state,'daily_return':state['nav']/before_nav-1,'drawdown':state['nav']/peak-1,
                'exposure':1-state['cash']/state['nav'],'positions':sum(u*last_marks[s]>=1 for s,u in state['units'].items()),
                'costs':sum(f['commission']+f['tax'] for f in fills),'skipped':skips,'factor_changes':factors})
            pending=pending_plan=None
        if day in forecasts and state.get('stale_symbols'):
            blocked_plans.append({'date':day,'reason':'unpriced_account_blocks_new_plan','symbols':state['stale_symbols']})
            print('NAV_STALE_HOLD',model,cap,day,state['stale_symbols'],flush=True)
        if day in forecasts and not state.get('stale_symbols'):
            start=time.monotonic();pred=forecasts[day];symbols=sorted(set(pred)|set(state['units']))
            base={'exposure_cap':1.,'name_cap':.08,'min_weight':0.,'max_positions':cap,
                'buy_cost':COMMISSION,'sell_cost':COMMISSION+TAX,'risk_aversion':2.,'covariance_horizon_sessions':1}
            policy=native_opb_policy(base);policy['approved_policy_identity']=identity
            mature=[r for r in rewards if r['known_date']<day and r['complete']]
            controls,opb=choose_opb({'constraints':base,'opb':policy},mature,identity,day)
            controls['min_weight']=max(controls['min_weight'],30000/state['nav'])
            risk=risk_for(day,symbols,records)
            unavailable={s for s,r in pred.items() if r.get('l3_available') is False}
            locked=sorted((set(state['units'])-set(pred)) | (set(state['units'])&unavailable))
            knobs,groups,pressure,horizon,evidence=risk_groups(symbols,{},stocks,{},controls,dated_covariance_packet=risk)
            current=[state['units'].get(s,0.)*adj[day][s]/state['nav'] if s in state['units'] else 0. for s in symbols]
            result=allocate(symbols=symbols,expected_gross=[pred[s][model] if s in pred and s not in unavailable else 0. for s in symbols],
                covariance=np.asarray(risk['covariance'])*horizon,current_weights=current,
                exposure_groups=groups,turnover_pressure=pressure,forbidden_buys=sorted(set(risk['forbidden_buys'])|unavailable),
                locked_symbols=locked,time_limit=120.,**knobs)
            weights={s:w for s,w in result['weights'].items() if w>1e-7}
            if set(weights)-set(adj[day]):raise ValueError('target_current_price_missing')
            pending={s:w*state['nav']/adj[day][s] for s,w in weights.items()}
            for s in locked:pending[s]=state['units'][s]
            pending_plan={'date':day,'nav_at_decision':state['nav'],'opb':opb,'candidate_count':len(pred),
                'held_only_locked':locked,'asof_unavailable':sorted(unavailable),'target_weights':weights,'proof':result['proof'],'constraints':controls,
                'source_label_access':False,'seconds':time.monotonic()-start}
            plans.append(pending_plan)
            print('NAV_PLAN',model,cap,slip,day,len(symbols),len(weights),round(state['nav'],2),opb['arm_id'],round(pending_plan['seconds'],2),flush=True)
        save(dest,{'model':model,'max_positions':cap,'slippage_bps':slip,'status':'RUNNING','plans':plans,'ledger':ledger,'fills':fills_all,'rewards':rewards})
    if state.get('stale_symbols'):raise ValueError('terminal_account_unpriced')
    fees=sum(f['commission']+f['tax'] for f in fills_all)
    terminal_reserve=sum(sum(fee(u*adj[calendar[-1]][s],'sell')) for s,u in state['units'].items() if u*adj[calendar[-1]][s]>=1)
    summary={'initial_nav':INITIAL,'end_nav':state['nav'],'net_return':state['nav']/INITIAL-1,
        'terminal_fee_reserve_return':(state['nav']-terminal_reserve)/INITIAL-1,'max_drawdown':min(r['drawdown'] for r in ledger),
        'average_exposure':sum(r['exposure'] for r in ledger)/len(ledger),'fees_and_tax':fees,
        'slippage_cost':sum(f['slippage_cost'] for f in fills_all),
        'turnover_over_initial_nav':sum(f['shares']*f['price'] for f in fills_all)/INITIAL,
        'unique_traded_symbols':len({f['symbol'] for f in fills_all}),'fill_count':len(fills_all),
        'mean_positions':sum(r['positions'] for r in ledger)/len(ledger),'max_positions_observed':max(r['positions'] for r in ledger),
        'unfilled_or_partial_events':sum(len(r['skipped']) for r in ledger)+sum(f['shares']<f['requested'] for f in fills_all),
        'factor_events':sum(len(r['factor_changes']) for r in ledger),'opb_rewards':sum(r['complete'] for r in rewards),'blocked_signal_dates':len(blocked_plans),'stale_valuation_days':sum(bool(r['stale_symbols']) for r in ledger),
        'opb_learned_plans':sum(p['opb']['status']=='learned_policy' for p in plans),'signal_dates':len(plans),'nav_intervals':len(ledger),
        'all_optimizer_proofs_pass':all(p['proof']['within_tolerance'] for p in plans)}
    packet={'model':model,'max_positions':cap,'slippage_bps':slip,'status':'PASS','summary':summary,'blocked_plans':blocked_plans,'plans':plans,'ledger':ledger,'fills':fills_all,'rewards':rewards}
    save(dest,packet);print('NAV_RESULT',json.dumps({'model':model,'cap':cap,'slip':slip,**summary}),flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--caps',nargs='+',default=['5','none']);parser.add_argument('--models',nargs='+',default=list(MODELS));parser.add_argument('--slip',type=float,default=5.)
    parser.add_argument('--diagnostic-label-pool',action='store_true',help='Explicit invalid-for-policy-comparison debugging only')
    parser.add_argument('--asof-dir',type=Path)
    args=parser.parse_args()
    global OUT
    if args.asof_dir is not None:
        args.asof_dir=args.asof_dir.resolve()
        OUT=C/'matched-nav-asof'
    if not args.diagnostic_label_pool and args.asof_dir is None:
        raise ValueError('l4_nav_requires_asof_decision_universe:do_not_use_mature_label_panel')
    OUT.mkdir(exist_ok=True)
    protocol={'repair_from_v1':'V1 exposed missing held marks and post-fill count overflow; no model or performance tuning. V2 stale marks only for accounting display; no trading or OPB learning on unpriced account, terminal must have all fresh marks. Enforce actual count after sells.',
        'scope':'offline retrospective matched economic total-return NAV; not actual production or legal corporate-action accounting',
        'initial_cash':INITIAL,'signal_dates':['2026-08-20','2026-09-01'],'end_mark':'2026-09-08',
        'pool':'all frozen research L3 rows; NOT historical formal L1.5 routed universe','forecast_units':'five_session_gross_decimal',
        'optimizer':'native signed full-pool exact solver; no positive-EV gate or preselection; no timeout fallback',
        'opb':'native choose_opb; zero priors; separate accounts; only prior-date complete simulated account receipts',
        'constraints':{'name_cap':.08,'minimum_position_TWD':30000,'max_positions_scenarios':[5,None],'risk_aversion':2,'covariance_horizon':1},
        'execution':'signal-close adjusted-unit target; next-session raw open; integer shares; previous volume 1% participation; one-price bars unfilled; cash-constrained sells then buys',
        'costs':{'commission':COMMISSION,'sell_tax':TAX,'minimum_commission_TWD':20,'slippage_bps':args.slip,'no_label_18bps_cost_added':True},
        'corporate_actions':'canonical adjusted units with raw-price conversion; immediate economic reinvestment, NOT actual cash receipt timing; factor events disclosed',
        'stale_marks':'last observed adjusted mark explicitly flagged; never supplied to risk or labels; missing account disables new plan and reward; fresh terminal required',
        'omitted_policy_layers':['formal L1.5 routing','debate','live circuit breaker state','daily buy budget and per-cash buy cap','broker intraday fills'],
        'terminal':'mark-to-market, no invented liquidation fills; separate estimated fee reserve',
        'inference':'nine reused signal dates; no annualization, no untouched confirmation, no promotion or formal reward ingestion',
        'source_sha256':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),C/'held-predictions.parquet',C/'source/prices.parquet',C/'source/stocks.parquet',ROOT/'ml-controller/services/l4_portfolio.py',ROOT/'ml-controller/services/l4_distribution_runtime.py',ROOT/'ml-controller/services/l4_dated_risk.py',*sorted((C/'source').glob('sequence-batch_*.npz'))]}}
    if args.asof_dir is not None:
        protocol.update(pool='exact historical formal L1.5 routed keys, label-independent reconstructed asof inputs',signal_dates=['2026-08-21','2026-09-01'],inference='eight reused signal dates; matched local economic NAV, no untouched confirmation or promotion')
        protocol['omitted_policy_layers'].remove('formal L1.5 routing')
        protocol['source_sha256'].update({str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [args.asof_dir/'held-predictions.parquet',args.asof_dir/'asof-forecast-receipt.json',C/'source/canonical-close-raw/combined.parquet']})
    save(OUT/f'protocol-slip{args.slip:g}.json',protocol)
    inputs=load_inputs(diagnostic_label_pool=args.diagnostic_label_pool,asof_dir=args.asof_dir)
    for captext in args.caps:
        cap=None if captext=='none' else int(captext)
        for model in args.models:
            path=OUT/f'{model}-cap{captext}-slip{args.slip:g}.json'
            if path.exists() and json.loads(path.read_text())['status']=='PASS':continue
            try:run_path(model,cap,args.slip,inputs,path)
            except Exception as exc:
                packet=json.loads(path.read_text()) if path.exists() else {}
                packet.update(status='FAIL',reason=repr(exc));save(path,packet);print('NAV_FAILED',model,cap,repr(exc),flush=True)
if __name__=='__main__':main()
