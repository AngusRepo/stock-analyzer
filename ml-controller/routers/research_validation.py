"""Authenticated research workbench; replay uses sealed snapshots, never trades."""
from __future__ import annotations
from copy import deepcopy
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
import json
import uuid
import anyio
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from services.d1_domain_client import DomainD1Client, D1DataDomain
from services.research_trial_ledger import verified_rows, search_inventory, checksum, observation, append
from services.research_validation import robustness_report, bundle, bundle_drift, causal_replay_audit, execution_component
from services.worker_config_client import worker_fetch

router=APIRouter(prefix='/research_validation',tags=['research_validation'])


def research_client():return DomainD1Client(D1DataDomain.RESEARCH,require_specific=True)


@router.get('/runs')
def runs():
    client=research_client()
    try:rows=verified_rows('run',query=client.query)
    except Exception as exc:raise HTTPException(503,'research_ledger_unavailable') from exc
    grouped={}
    for row in rows:
        found=grouped.setdefault(row['run_key'],{'run_key':row['run_key'],'states':[], 'coverage':'partial','gaps':[]})
        found['states'].append(row['content'].get('state',row['content'].get('status','unknown')))
        found['gaps'].extend(row['content'].get('gaps',[]))
    return {'runs':sorted(grouped.values(),key=lambda row:row['run_key'],reverse=True),'promotion_authority':False}


@router.get('/run')
async def run_report(run_key: str = Query(min_length=1,max_length=240)):
    client=research_client()
    inventory=await anyio.to_thread.run_sync(lambda:search_inventory(run_key,query=client.query))
    current=await worker_fetch('/api/admin/config',method='GET')
    live_contexts=[r['content'].get('context',{}) for r in inventory['runs'] if r['content'].get('context')]
    context=live_contexts[-1] if live_contexts else {}
    space=context.get('search_space') or []
    flat={}
    for dim in space:
        value=current
        for key in dim.get('path',dim['name']).split('.'):
            value=value.get(key) if isinstance(value,dict) else None
        flat[dim['name']]=value
    robust=robustness_report(inventory['trials'],current_parameters=flat,search_space=space)
    return {**{k:v for k,v in inventory.items() if k not in ('trials','runs')},
        'run_receipts':[{'receipt_id':r['receipt_id'],'source':r['source'],'state':r['content'].get('state',r['content'].get('status'))}
                        for r in inventory['runs']], 'robustness':robust,
        'trials':[{'trial_id':r['logical_id'],'state':r['content'].get('state'),
            'parameters':r['content'].get('parameters'),'validation':r['content'].get('validation'),
            'holdout':r['content'].get('holdout'),'cost':r['content'].get('cost'),
            'sample_count':r['content'].get('sample_count'), 'gaps':r['content'].get('gaps',[]),
            'source':r['source'],'receipt_id':r['receipt_id']} for r in inventory['trials']]}


class CausalRequest(BaseModel):
    candidate_id: str=Field(min_length=1,max_length=240)
    start_date: date
    end_date: date
    symbols: list[str]=Field(min_length=1,max_length=50)


async def candidate_configuration(candidate_id):
    client=DomainD1Client(D1DataDomain.LEARNING,require_specific=True)
    rows=await anyio.to_thread.run_sync(lambda:client.query(
        'SELECT candidate_id,sandbox_id,source FROM parameter_candidate_registry WHERE candidate_id=?',[candidate_id]))
    if len(rows)!=1 or not rows[0]['sandbox_id']:raise HTTPException(404,'candidate_sandbox_missing')
    from urllib.parse import quote
    saved=await worker_fetch('/api/admin/config/sandbox/'+quote(rows[0]['sandbox_id'],safe=''),method='GET')
    current=await worker_fetch('/api/admin/config',method='GET')
    from services.alpha_evidence_runner import _deep_merge,_candidate_config
    return rows[0],_deep_merge(current,_candidate_config(saved))


def components(configuration):
    from services.backtest_engine import FeeParams
    return {'strategy':{'owner':'parameter_candidate','mode':'A'},
            'models':{'owner':'rule_based_mode_a','ml_artifacts':'none'},'parameters':configuration,
            'data_semantics':{'kind':'backtest_dataset','feature_source':execution_component()['source_hashes'],
                'corporate_actions':'sealed_daily_sources','universe':'point_in_time'},
            'cost':asdict(FeeParams.from_trading_config(configuration)),'execution':execution_component()}


@router.post('/causal')
async def causal(req:CausalRequest):
    if not 5 <= (req.end_date-req.start_date).days <= 730 or req.end_date>datetime.now(timezone(timedelta(hours=8))).date():
        raise HTTPException(422,'replay_window_invalid')
    _,configuration=await candidate_configuration(req.candidate_id)
    def replay():
        from services.backtest_engine import BacktestDataset
        dataset,access=BacktestDataset.load_for_research(lane='research_causal_audit',mode='snapshot',
            business_date=req.end_date.isoformat(),start_date=req.start_date.isoformat(),
            end_date=req.end_date.isoformat(),symbols=req.symbols)
        audit=causal_replay_audit(dataset=dataset,params=configuration,start_date=req.start_date.isoformat(),
            end_date=req.end_date.isoformat(),snapshot=access)
        saved=bundle(candidate_id=req.candidate_id,components=components(configuration),snapshot=access,
            window=[req.start_date.isoformat(),req.end_date.isoformat()])
        # Universe selection is part of the evidence, not an interchangeable UI filter.
        saved['evaluation']['symbols']=sorted(set(req.symbols))
        saved['bundle_checksum']=checksum({k:v for k,v in saved.items() if k!='bundle_checksum'})
        run_key='validation:'+uuid.uuid4().hex
        source={'pointer':'runtime://'+run_key,'sha256':checksum(saved)}
        record=observation('run',run_key=run_key,logical_id=req.candidate_id,source=source,
            content={'state':'causal_audit_completed','coverage':'partial','candidate_id':req.candidate_id,
                     'causal_audit':audit,'validation_bundle':saved,'gaps':['statistical_and_native_nav_gates_still_required']})
        client=research_client();receipt=append(record,query=client.query,writer=client.batch_execute)
        return {'run_key':run_key,'receipt_id':receipt,'causal_audit':audit,'validation_bundle':saved,
                'bundle_drift':bundle_drift(saved,components(configuration)),'promotion_authority':False}
    try:return await anyio.to_thread.run_sync(replay)
    except (ValueError,RuntimeError,KeyError,TypeError) as exc:
        raise HTTPException(503,'sealed_replay_or_ledger_unavailable') from exc


@router.get('/bundle')
async def drift(run_key: str=Query(min_length=1,max_length=240)):
    client=research_client()
    rows=await anyio.to_thread.run_sync(lambda:verified_rows('run',query=client.query,run_key=run_key))
    artifacts=[r for r in rows if r['content'].get('validation_bundle')]
    if len(artifacts)!=1:raise HTTPException(404,'validation_bundle_missing')
    row=artifacts[0];saved=row['content']['validation_bundle']
    _,current=await candidate_configuration(saved['candidate_id'])
    return {'run_key':run_key,'receipt_id':row['receipt_id'],'bundle':saved,
            'drift':bundle_drift(saved,components(current)),'promotion_authority':False}


@router.get('/production_bundle')
def production_bundle():
    from services.research_canonical_bundle_view import canonical_bundle_view
    client=DomainD1Client(D1DataDomain.LEARNING,require_specific=True)
    try:return canonical_bundle_view(query=client.query)
    except (ValueError,RuntimeError,KeyError,TypeError):
        return {'status':'FAIL','reason':'canonical_serving_authority_unverified',
                'promotion_authority':False,'drift_fields':[]}
