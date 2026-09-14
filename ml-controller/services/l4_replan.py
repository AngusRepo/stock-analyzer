"""Reapply the same frozen L3/L4 full pool with updated account/risk constraints."""
from copy import deepcopy
import json
from datetime import datetime,timezone,timedelta

from services.l4_distribution import digest
from services.l4_distribution_runtime import run


def replan(*, plan_id, veto_symbols, reason, paper, learning, account_reader, publisher, weight_caps=None):
    weight_caps=weight_caps or {}
    request={'source_plan_id':plan_id,'veto_symbols':sorted(set(veto_symbols)),'weight_caps':weight_caps,'reason':reason}
    request_id=digest(request)
    existing=paper.query('SELECT * FROM l4_replan_requests_v1 WHERE request_id=?',[request_id])
    if existing and existing[0].get('result_plan_id'):
        return {'status':'replanned','plan_id':existing[0]['result_plan_id'],'request_id':request_id}
    rows=paper.query('SELECT * FROM l4_portfolio_plans_v1 WHERE plan_id=? AND account_id=1 AND activated=1',[plan_id])
    if len(rows)!=1:
        raise ValueError('l4_replan_source_missing')
    source=json.loads(rows[0]['payload_json'])
    if (not veto_symbols and not weight_caps and reason!='account_risk_changed') or (set(veto_symbols)|set(weight_caps))-set(source['targets']):
        raise ValueError('l4_replan_veto_outside_pool')
    head=paper.query('SELECT p.* FROM l4_portfolio_head_v1 h JOIN l4_portfolio_plans_v1 p ON h.plan_id=p.plan_id WHERE h.account_id=1',[])
    if len(head)!=1:
        raise ValueError('l4_replan_head_missing')
    latest=json.loads(head[0]['payload_json'])
    if latest['signal_date']!=source['signal_date'] or latest['policy_identity']!=source['policy_identity']:
        raise ValueError('l4_replan_source_expired')
    rows=head
    source=latest
    from services.paired_nav_journal import read_snapshot
    saved=read_snapshot(learning.query,rows[0]['allocation_snapshot_id'])
    inputs=deepcopy(saved['payload']['content']['inputs'])
    policy=inputs['alpha_policy']['l4Distribution']
    if policy['artifact']['model_checksum']!=source['model_checksum']:
        raise ValueError('l4_replan_model_changed')
    started=datetime.now(timezone.utc)
    account=account_reader(source['signal_date'])
    observed=datetime.fromisoformat(account['observed_at'].replace('Z','+00:00'))
    if not started-timedelta(seconds=5)<=observed<=datetime.now(timezone.utc)+timedelta(seconds=5):
        raise ValueError('l4_replan_account_observation_stale')
    account['forbidden_buys']=sorted(set(account.get('forbidden_buys',[]))|set(source.get('forbidden_buys',[]))|set(veto_symbols))
    if not account.get('risk_limits') or not account.get('fees'):
        raise ValueError('l4_replan_canonical_risk_context_missing')
    if account.get('active_plan_id')!=source['plan_id']:
        raise ValueError('l4_replan_concurrent_change_retry')
    caps=dict(account.get('name_caps') or {})
    for symbol,cap in weight_caps.items():
        if not 0<=cap<=source['constraints']['name_cap']:
            raise ValueError('l4_replan_weight_cap_invalid')
        caps[symbol]=min(caps.get(symbol,1.),cap)
    account['name_caps']=caps
    policy['runtime']['account']=account
    paper.batch_execute([('INSERT INTO l4_replan_requests_v1(request_id,source_plan_id,request_json) VALUES(?,?,?) ON CONFLICT(request_id) DO NOTHING',
                         [request_id,plan_id,json.dumps(request,sort_keys=True)])])
    output=run(inputs['recommendations'],policy,return_history=inputs['return_history'],
               reward_ledger=inputs['opb_reward_ledger'])
    plan=output[0]['_l4_portfolio_plan']
    if plan['policy_identity']!=source['policy_identity']:
        raise ValueError('l4_replan_policy_changed')
    publisher(plan,rows[0]['allocation_snapshot_id'])
    paper.batch_execute([('UPDATE l4_replan_requests_v1 SET result_plan_id=? WHERE request_id=? AND result_plan_id IS NULL',
                          [plan['plan_id'],request_id])])
    return {'status':'replanned','plan_id':plan['plan_id'],'request_id':request_id}
