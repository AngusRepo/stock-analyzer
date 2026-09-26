"""Generate auditable, idempotent SQL from generation/checksum-pinned exports.

No network or writes to production. Operators apply the generated SQL only to
Research D1 after reviewing the reconciliation report. All recovered runs are
partial: retained candidates do not prove that failed/discarded trials survived.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import math
from datetime import date
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.research_trial_ledger import observation, encode, TABLES, checksum


def read_pinned(root, item):
    path = (root / item['source_file']).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('research_backfill_source_outside_root')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('research_backfill_source_changed')
    return json.loads(raw)


def records(root, manifest):
    sources, data = manifest['sources'], {}
    for name, entry in sources.items():
        data[name] = read_pinned(root, entry)
        if len(data[name]) != entry['rows']:
            raise ValueError('research_backfill_row_count_changed')
        yield observation('source', run_key='historical-import', logical_id=name,
            source={'pointer': f"d1://{entry['database']}/{name}@{entry['read_at']}", 'sha256':entry['sha256']},
            content={'source_file':entry['source_file'], 'query':entry['query'], 'rows':entry['rows'],
                     'coverage':'partial', 'read_at':entry['read_at']})
    run_configs = {r['run_id']: json.loads(r['config_json']) for r in data['strategy_mining_runs']}
    def d1_source(name):
        entry = sources[name]
        return {'pointer':f"d1://{entry['database']}/{name}@{entry['read_at']}", 'sha256':entry['sha256']}
    for row in data['strategy_mining_runs']:
        yield observation('run', run_key='mining:'+row['run_id'], logical_id=row['run_id'],
            source=d1_source('strategy_mining_runs'), content={**row,'coverage':'partial',
                'gaps':['retained_rows_do_not_prove_complete_search'], 'raw_row_checksum':checksum(row)})
    evidence = {}
    for row in data['parameter_candidate_evidence']:
        evidence.setdefault(row['candidate_id'], []).append(row)
    for row in data['parameter_candidate_registry']:
        key='parameter:'+(row.get('run_id') or row['candidate_id'])
        content={'state':row['status'], 'parameters':None, 'metadata':json.loads(row['metadata_json']),
                 'candidate_config_hash':row['config_hash'], 'candidate_evidence':evidence.get(row['candidate_id'],[]),
                 'coverage':'partial', 'gaps':['full_trial_history_missing','original_parameters_not_exported'],
                 'raw_row':row, 'raw_row_checksum':checksum(row)}
        yield observation('run', run_key=key, logical_id=key, source=d1_source('parameter_candidate_registry'),
            content={'state':'legacy_candidate_retained','coverage':'partial','gaps':['full_trial_history_missing']})
        yield observation('trial', run_key=key, logical_id=row['candidate_id'],
            source=d1_source('parameter_candidate_registry'), content=content)
    confirmations={}
    for row in data['strategy_backtest_results']:
        confirmations.setdefault(row['candidate_id'],[]).append(row)
    def mining_content(row, config, *, projection=False):
        metrics=json.loads(row['metrics_json']) if projection else row
        params={'factor_ids':json.loads(row['factor_ids_json']) if projection else row.get('factor_ids'),
                'weights':json.loads(row['factor_weights_json']) if projection else row.get('weights')}
        if not projection:params['combine']=row.get('combine')
        dates,returns=metrics.get('holdout_dates'),metrics.get('holdout_daily_returns')
        aligned=(isinstance(dates,list) and isinstance(returns,list) and len(dates)==len(returns)
                 and bool(dates) and all(isinstance(d,str) for d in dates)
                 and dates==sorted(set(dates))
                 and all(isinstance(r,(int,float)) and not isinstance(r,bool) and math.isfinite(r) for r in returns))
        if aligned:
            try:aligned=all(date.fromisoformat(d).isoformat()==d for d in dates)
            except ValueError:aligned=False
        gaps=['full_trial_history_not_proven','immutable_dataset_snapshot_missing']
        if not aligned:gaps.append('dated_return_panel_missing')
        if projection:gaps.append('combine_not_retained_in_d1_projection')
        return {'state':metrics.get('status',row.get('validation_status','unknown')),
            'parameters':params,'validation':metrics.get('validation'),'holdout':metrics.get('holdout'),
            'cost':{'fee_tax_cost':config.get('fee_tax_cost')},
            'validation_window':[config.get('validation_start'),config.get('validation_end')],
            'holdout_window':[config.get('holdout_start'),config.get('holdout_end')],
            'holdout_dates':dates,'holdout_daily_returns':returns,
            'dated_panel_checksum':checksum([dates,returns]) if aligned else None,
            'coverage':'partial','gaps':gaps,'reported_metrics':metrics,'raw_row_checksum':checksum(row)}
    for row in data['strategy_mining_candidates']:
        run=row['run_id'];prefix=run+'__'
        if not row['candidate_id'].startswith(prefix):
            raise ValueError('research_backfill_candidate_run_mismatch')
        content=mining_content(row,run_configs[run],projection=True)
        content['confirmations']=confirmations.get(row['candidate_id'],[])
        yield observation('trial',run_key='mining:'+run,logical_id=row['candidate_id'][len(prefix):],
            source=d1_source('strategy_mining_candidates'),content=content)
    for entry in manifest.get('gcs_artifacts',[]):
        artifact=read_pinned(root,entry);run=entry['run_id']
        source={'pointer':entry['uri']+'#'+entry['generation'],'sha256':entry['sha256']}
        yield observation('source',run_key='mining:'+run,logical_id=source['pointer'],source=source,
            content={'rows':len(artifact['rows']),'source_file':entry['source_file'],'coverage':'partial'})
        yield observation('run',run_key='mining:'+run,logical_id=run,source=source,
            content={'state':'artifact_recovered','coverage':'partial','config':artifact['config'],
                'reported_summary':artifact.get('summary'),'reported_multiple_testing':artifact.get('multiple_testing'),
                'gaps':['failed_or_discarded_trials_not_proven_retained']})
        for row in artifact['rows']:
            yield observation('trial',run_key='mining:'+run,logical_id=row['candidate_id'],source=source,
                content=mining_content(row,artifact['config']))


def sql(record, recorded_at):
    body=record['payload'];table=TABLES[body['kind']]
    def quote(value):return "'"+value.replace("'","''")+"'"
    values=[record['receipt_id'],body['run_key'],body['logical_id'],encode(body),recorded_at]
    return f'INSERT INTO {table}(receipt_id,run_key,logical_id,payload_json,recorded_at) SELECT '+','.join(map(quote,values))+' WHERE NOT EXISTS (SELECT 1 FROM '+table+' WHERE receipt_id='+quote(record['receipt_id'])+');'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();manifest=json.loads(args.manifest.read_text(encoding='utf-8'))
    raw=list(records(args.root,manifest))
    found=list({r['receipt_id']:r for r in raw}.values())
    ids={(r['payload']['run_key'],r['payload']['logical_id'])
        for r in found if r['payload']['kind']=='trial'}
    args.output.mkdir(parents=True,exist_ok=True)
    if list(args.output.glob('backfill-*.sql')):
        raise ValueError('research_backfill_requires_fresh_output_directory')
    # Bounded files support resume and avoid the remote D1 request size limit.
    for index in range(0,len(found),100):
        (args.output/f'backfill-{index//100:03d}.sql').write_text(
            '\n'.join(sql(r,manifest['finished_at']) for r in found[index:index+100])+'\n',encoding='utf-8')
    report={'schema_version':'research-history-reconciliation-v1',
        'raw_observation_count':len(raw),'deduplicated_observation_count':len(found),
        'observation_counts':dict(Counter(
        r['payload']['kind'] for r in found)), 'known_unique_trials':len(ids),
        'known_mining_trials':sum(k.startswith('mining:') for k,_ in ids),
        'receipt_checksum':checksum(sorted(r['receipt_id'] for r in found)),
        'historical_complete_runs':0,'promotion_authority':False,
        'source_manifest_sha256':hashlib.sha256(args.manifest.read_bytes()).hexdigest()}
    (args.output/'reconciliation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
