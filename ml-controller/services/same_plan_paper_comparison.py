"""Local-only native policy comparison. One sealed input, two private accounts.

No allocator, model, LLM capture, live bindings, or substitute fill simulator.
Both entry and exit policy differ; this is NOT an exit-only causal estimate.
The caller retains exported states for the next frozen session.
"""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from math import isfinite
from datetime import datetime,timezone,timedelta
from services.native_paper_sandbox import PrivatePaperStore, run_native_paper_frames
from services.paired_nav_journal import digest

POLICIES={'fixed_tp':'or15_vwap_v1','swing_no_tp':'or15-5m-orl8-20-v1'}
PLAN_TABLES=('l4_portfolio_plans_v1','paper_daily_plan_heads_v1','paper_daily_plan_reviews_v1')

def inspect_state(raw, account):
    store=PrivatePaperStore(raw,sha256(raw.encode()).hexdigest(),{})
    try:
        db=store.db
        plans={table:[dict(r) for r in db.execute('SELECT * FROM '+table+' WHERE account_id=?',(account,))] for table in PLAN_TABLES}
        if not plans['paper_daily_plan_heads_v1']:
            raise ValueError('same_plan_sealed_head_missing')
        # Sort by canonical content rather than SQLite insertion order.
        plans={k:sorted(v,key=digest) for k,v in plans.items()}
        snapshots=[dict(r) for r in db.execute('SELECT date,total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date',(account,))]
        orders=[dict(r) for r in db.execute('SELECT * FROM paper_orders WHERE account_id=? ORDER BY id',(account,))]
        return {'plan_checksum':digest(plans),'snapshots':snapshots,'orders':orders}
    finally:store.db.close()

def compare_same_plan(*, states, frames, frame_inputs, account_id, variables, runner:Path, continuation=None):
    if set(states)!=set(POLICIES) or not frames:
        raise ValueError('same_plan_two_arms_and_frames_required')
    # Every external response is replayed from this shared frozen packet. No
    # capture_source is passed to the host, even if replay discovers a gap.
    allowed={'settlement','intraday','eod','postclose','snapshot'}
    for frame in frames:
        if frame.get('stage') not in allowed or frame.get('input_id') not in frame_inputs:
            raise ValueError('same_plan_non_execution_frame')
        source=frame_inputs[frame['input_id']]
        if any(source.get(k)!=frame.get(k) for k in ('stage','observed_at')):
            raise ValueError('same_plan_frame_identity_mismatch')
    initial={name:sha256(raw.encode()).hexdigest() for name,raw in states.items()}
    context=digest({'account_id':account_id,'variables':variables,'policies':POLICIES})
    if continuation is None:
        if len(set(initial.values()))!=1:raise ValueError('same_plan_initial_accounts_differ')
    elif continuation.get('state_checksums')!=initial or continuation.get('context_checksum')!=context:
        raise ValueError('same_plan_continuation_mismatch')
    before={name:inspect_state(raw,account_id) for name,raw in states.items()}
    if len({v['plan_checksum'] for v in before.values()})!=1:
        raise ValueError('same_plan_plan_diverged')
    results={}
    for name,owner in POLICIES.items():
        raw=states[name]
        result=run_native_paper_frames(state_sql=raw,state_checksum=sha256(raw.encode()).hexdigest(),
            frames=deepcopy(frames),frame_inputs=deepcopy(frame_inputs),account_id=account_id,runner=runner,
            variables={**variables,'PAPER_DAILY_PLAN_OWNER':'premarket_once_v1','PAPER_INTRADAY_ENTRY_OWNER':owner})
        after=inspect_state(result['state_sql'],account_id)
        if after['plan_checksum']!=before[name]['plan_checksum']:
            raise ValueError('same_plan_execution_mutated_plan')
        results[name]={**result,'summary':after}
    frame_days={datetime.fromisoformat(f['observed_at'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8))).date().isoformat() for f in frames}
    navs={k:{r['date']:r['total_value'] for r in v['summary']['snapshots'] if r['date'] in frame_days} for k,v in results.items()}
    common=sorted(set(navs['fixed_tp'])&set(navs['swing_no_tp']))
    paired=[{'date':d,**{name:navs[name][d] for name in POLICIES}} for d in common]
    if any(not isinstance(row[name],(int,float)) or not isfinite(row[name]) or row[name]<=0 for row in paired for name in POLICIES):
        raise ValueError('same_plan_invalid_nav')
    return {'schema_version':'same-plan-native-comparison-v1','arms':results,'paired_nav':paired,
        'plan_checksum':before['fixed_tp']['plan_checksum'],'frozen_inputs_checksum':digest(frame_inputs),
        'continuation':{'state_checksums':{name:v['state_checksum'] for name,v in results.items()},'context_checksum':context},
        'contrast':'same_plan_complete_execution_policy_not_exit_only',
        'status':'local_replay_complete','efficacy_status':'unproven',
        'production_effect':False,'training_dispatched':False,'nav_maturity_credit':0,
        'missing_nav_dates':{k:sorted(set().union(*(set(v) for v in navs.values()))-set(navs[k])) for k in POLICIES}}
