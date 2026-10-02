"""Bounded Learning-D1 receipts; existing Paper plans and accounts are read-only."""
from datetime import datetime, timezone, timedelta
import json
import re
from services.l4_distribution import digest
from services.rfs_sparse_comparison import SCHEMA, build_comparison, adjusted_basket_outcome, seal
from services.rfs_liquidity import with_liquidity

TW=timezone(timedelta(hours=8))


def failure_code(exc):
    value=str(exc)
    return value if re.fullmatch(r'(?:rfs_|l4_)[a-z0-9_]+',value) else 'rfs_comparison_source_unavailable'


def observe_safely(plan, snapshot_id):
    """Research failure is visible but cannot roll back formal publication."""
    import logging
    try:
        return observe_published_plan(plan,snapshot_id)
    except Exception as exc:
        reason=failure_code(exc)
        logging.getLogger(__name__).warning('[RFS comparison] observation failed: %s',reason)
        return {'status':'failed','reason':reason,'production_effect':False}


def persist(packet, snapshot_id, *, learning, observed_at):
    if packet.get('packet_checksum')!=digest({k:v for k,v in packet.items() if k!='packet_checksum'}):
        raise ValueError('rfs_packet_checksum_invalid')
    raw=json.dumps(packet,sort_keys=True,separators=(',',':'),allow_nan=False)
    if len(raw.encode())>500_000:raise ValueError('rfs_packet_size_bound')
    learning.batch_execute([('INSERT INTO rfs_sparse_comparisons_v1(plan_id,schema_version,signal_date,policy_identity,allocation_snapshot_id,observed_at,status,packet_checksum,payload_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(plan_id) DO NOTHING',
        [packet['plan_id'],SCHEMA,packet['signal_date'],packet['policy_identity'],snapshot_id,observed_at,
         packet['status'],packet['packet_checksum'],raw])])
    rows=learning.query('SELECT packet_checksum,allocation_snapshot_id FROM rfs_sparse_comparisons_v1 WHERE plan_id=?',[packet['plan_id']])
    if len(rows)!=1 or rows[0]['packet_checksum']!=packet['packet_checksum'] or rows[0]['allocation_snapshot_id']!=snapshot_id:
        raise ValueError('rfs_immutable_receipt_conflict')


def refresh_outcomes(*, learning, market, now):
    local=now.astimezone(TW)
    # Canonical daily close must already exist and the session must be over.
    cutoff=local.date().isoformat() if (local.hour,local.minute)>=(14,0) else (local.date()-timedelta(days=1)).isoformat()
    pending=learning.query("SELECT c.plan_id,c.payload_json,c.observed_at FROM rfs_sparse_comparisons_v1 c WHERE c.status='collecting' AND c.schema_version=? AND (SELECT count(*) FROM rfs_sparse_outcomes_v1 o WHERE o.plan_id=c.plan_id)<2 ORDER BY coalesce(last_outcome_check_at,''),observed_at LIMIT 40",[SCHEMA])
    written=0
    for row in pending:
        learning.batch_execute([('UPDATE rfs_sparse_comparisons_v1 SET last_outcome_check_at=? WHERE plan_id=?',[now.isoformat(),row['plan_id']])])
        packet=json.loads(row['payload_json'])
        if packet.get('packet_checksum')!=digest({k:v for k,v in packet.items() if k!='packet_checksum'}):
            raise ValueError('rfs_outcome_packet_corrupt')
        captured=datetime.fromisoformat(row['observed_at']).astimezone(TW)
        # First close strictly after this actual prospective collection. A
        # replay of an old plan can only start a new future experiment.
        start=captured.date() if (captured.hour,captured.minute)<(13,30) else captured.date()+timedelta(days=1)
        days=market.query("SELECT date FROM canonical_market_daily WHERE date>=? AND date<=? AND source IN ('finlab.price','finlab.rotc_price') GROUP BY date HAVING count(DISTINCT stock_id)>=100 ORDER BY date LIMIT 21",[start.isoformat(),cutoff])
        sessions=[x['date'] for x in days]
        if len(sessions)<6:continue
        symbols=sorted({s for side in ('weights','incumbent_weights') for s,w in packet[side].items() if w>1e-7})
        marks={};duplicates=set()
        for offset in range(0,len(symbols),50):
            subset=symbols[offset:offset+50]
            prices=market.query('SELECT stock_id,date,adj_close FROM canonical_market_daily WHERE stock_id IN ('+','.join('?' for _ in subset)+") AND date>=? AND date<=? AND source IN ('finlab.price','finlab.rotc_price')",[*subset,sessions[0],sessions[-1]])
            for p in prices:
                key=(str(p['stock_id']),p['date'])
                if key in marks and marks[key]!=p['adj_close']:duplicates.add(key)
                marks[key]=p['adj_close']
        for key in duplicates:marks[key]=None
        for horizon in (5,20):
            if learning.query('SELECT checksum FROM rfs_sparse_outcomes_v1 WHERE plan_id=? AND horizon=?', [row['plan_id'], horizon]):
                continue
            result=adjusted_basket_outcome(packet,marks,sessions,horizon)
            if result is None:continue
            result.update(plan_id=row['plan_id'],packet_checksum=packet['packet_checksum'],known_at=now.isoformat())
            checksum=digest(result)
            learning.batch_execute([('INSERT INTO rfs_sparse_outcomes_v1(plan_id,horizon,entry_date,exit_date,delta,incumbent_net,challenger_net,known_at,payload_json,checksum) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(plan_id,horizon) DO NOTHING',
                [row['plan_id'],horizon,result['entry_date'],result['exit_date'],result['delta'],result['incumbent_net'],result['challenger_net'],now.isoformat(),json.dumps(result,sort_keys=True),checksum])])
            saved=learning.query('SELECT checksum FROM rfs_sparse_outcomes_v1 WHERE plan_id=? AND horizon=?',[row['plan_id'],horizon])
            if len(saved)!=1 or saved[0]['checksum']!=checksum:
                raise ValueError('rfs_outcome_write_readback_failed')
            written+=1
    return {'pending_checked':len(pending),'outcome_attempts':written}


def observe_published_plan(plan, snapshot_id, *, now=None, learning=None, paper=None, market=None):
    from services.d1_domain_client import client_for_domain
    from services.paired_nav_journal import read_context_projection
    now=now or datetime.now(timezone.utc)
    learning=learning or client_for_domain('learning');paper=paper or client_for_domain('paper');market=market or client_for_domain('market')
    # Do not block creation of a new receipt on a historical label gap.
    existing=learning.query('SELECT packet_checksum,status FROM rfs_sparse_comparisons_v1 WHERE plan_id=?',[plan['plan_id']])
    if not existing:
        published=paper.query('SELECT allocation_snapshot_id,payload_json FROM l4_portfolio_plans_v1 WHERE plan_id=? AND activated=1',[plan['plan_id']])
        if (len(published)!=1 or published[0]['allocation_snapshot_id']!=snapshot_id
                or json.loads(published[0]['payload_json'])!=plan):
            raise ValueError('rfs_published_plan_not_verified')
        saved=read_context_projection(learning.query,snapshot_id,
            ['inputs.recommendations','inputs.return_history','inputs.alpha_policy.l4Distribution.runtime.account','capture.portfolio_plan'])
        inputs=saved['payload']['content']['inputs']
        try:
            if saved['payload']['content']['capture']['portfolio_plan'] != plan:
                raise ValueError('rfs_frozen_capture_plan_mismatch')
            enriched, liquidity = with_liquidity(inputs['recommendations'], sorted(plan['targets']), plan['signal_date'], market)
            packet=build_comparison(plan,enriched,inputs['return_history'],inputs['alpha_policy']['l4Distribution']['runtime']['account'])
            packet.pop('packet_checksum')
            packet=seal({**packet,'liquidity_evidence':liquidity})
        except (ValueError,RuntimeError) as exc:
            packet=seal({'schema_version':SCHEMA,'plan_id':plan['plan_id'],'policy_identity':plan['policy_identity'],
                'model_checksum':plan['model_checksum'],
                'signal_date':plan['signal_date'],'status':'blocked','production_effect':False,'promotion_eligible':False,
                'validation_blockers':[failure_code(exc)],'source_expected_return_candidate_count':sum(x['expected_return_gross'] is not None for x in plan['targets'].values())})
        persist(packet,snapshot_id,learning=learning,observed_at=now.isoformat())
    status=existing[0]['status'] if existing else packet['status']
    return {'status':status,'plan_id':plan['plan_id'],'production_effect':False,
            **refresh_outcomes(learning=learning,market=market,now=now)}
