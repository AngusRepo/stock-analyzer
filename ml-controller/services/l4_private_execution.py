"""Pure new-L4 evaluation inside the same transactional private Paper host."""
import json
import time
from copy import deepcopy
from services.l4_distribution import digest
from services.l4_distribution_runtime import run


def allocate_private(store,account):
    from services.recommendation_service import build_recommendation_update_statements
    if not store.in_frame or account.get('account_id')!=1 or account.get('complete') is not True:
        raise ValueError('private_l4_account_scope_invalid')
    raw=store.db.execute("SELECT value FROM _native_private_kv WHERE key='l4:private_allocation_inputs'").fetchone()
    if raw is None:raise ValueError('private_l4_frozen_inputs_missing')
    frozen=json.loads(raw[0]);inputs=deepcopy(frozen['inputs'])
    policy=inputs['alpha_policy']['l4Distribution']
    if account['signal_date']!=policy['runtime']['signal_date']:
        raise ValueError('private_l4_signal_mismatch')
    head=store.db.execute('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id=1').fetchone()
    if account.get('active_plan_id')!=(head[0] if head else None):
        raise ValueError('private_l4_account_head_changed')
    policy['runtime']['account']=account
    ledger=[json.loads(row[0]) for row in store.db.execute('SELECT payload_json FROM l4_policy_account_rewards_v1 ORDER BY known_date,receipt_id')]
    captures = []
    shadow=inputs.get('r2_shadow')
    r16=inputs.get('r16_shadow')
    if shadow is not None and r16 is not None:
        raise ValueError('private_l4_multiple_shadow_packets')
    if shadow is not None or r16 is not None:
        # This store is the isolated native Paper host. Production callers have
        # no packet parameter and cannot activate the research scope through KV.
        policy['scope']='private_research'
    solve_started=time.perf_counter()
    rows=run(inputs['recommendations'],policy,return_history=inputs['return_history'],reward_ledger=ledger,
        private_research=True, evidence_sink=captures.append,
        **({'r2_shadow':shadow} if shadow is not None else {}),
        **({'r16_shadow':r16} if r16 is not None else {}))
    if len(captures) != 1:
        raise ValueError('private_l4_allocation_capture_missing')
    plan=captures[0]['portfolio_plan']
    # Timing is diagnostic output, never part of deterministic state/plan hashes.
    if r16 is not None:
        store.execution_metrics.append({'kind':'r17_allocation','plan_id':plan['plan_id'],
            'arm':r16['arm'],'signal_date':account['signal_date'],
            'solve_seconds':time.perf_counter()-solve_started,
            'status':'optimal' if plan.get('proof',{}).get('within_tolerance') is True else 'uncertified'})
    if rows and rows[0].pop('_l4_portfolio_plan') != plan:
        raise ValueError('private_l4_allocation_plan_changed')
    # The exact native serializer; no independent execution or fill approximation.
    for sql,args in build_recommendation_update_statements(rows,account['signal_date']):
        if store.db.execute(sql,args).rowcount!=1:
            raise ValueError('private_l4_recommendation_update_incomplete')
    unsigned={k:v for k,v in plan.items() if k!='plan_id'}
    if digest(unsigned)!=plan['plan_id']:raise ValueError('private_l4_plan_checksum_invalid')
    return {'plan':plan,'canonical_payload':json.dumps(unsigned,sort_keys=True,separators=(',',':'),allow_nan=False),
            'allocation_snapshot_id':frozen['allocation_snapshot_id']}
