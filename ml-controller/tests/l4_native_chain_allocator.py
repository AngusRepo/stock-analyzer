"""Synthetic engineering input adapter; executes the real L4/OPB allocator."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from test_l4_distribution_runtime import fixture
from services.l4_distribution_runtime import run,distribution_policy_identity
from services.l4_distribution import digest
args=json.load(sys.stdin)
rows,policy,history=fixture();row=rows[0];row['symbol']='2330';row['sector']='TECH'
pred=policy['runtime']['predictions']['A'];identity=args['identity']
pred['ensemble_v2'].update(artifact_id=identity['artifact_id'],cohort_id=identity['cohort_id'],
    artifact_checksum=identity['payload_checksum'],base_artifact_set_checksum=identity['base_artifact_set_checksum'])
policy['scope']='private_research';policy['artifact'].pop('release');policy['artifact']['l3_identity']=identity
policy['constraints'].update(args['constraints'])
policy['runtime'].update(signal_date=args['account']['signal_date'],l3_identity=identity,account=args['account'],predictions={'2330':pred})
policy['runtime']['account']['forbidden_buys']=args['account'].get('forbidden_buys',[])
from services.l4_allocation_contract import native_opb_policy
policy['opb']=native_opb_policy(policy['constraints'])
policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,identity)
result=run([row],policy,reward_ledger=args.get('reward_ledger',[]),return_history={'2330':history['A']},private_research=True)
plan=result[0].pop('_l4_portfolio_plan');unsigned={k:v for k,v in plan.items() if k!='plan_id'}
print(json.dumps({'policy':policy,'envelope':{'plan':plan,'canonical_payload':json.dumps(unsigned,sort_keys=True,separators=(',',':'),allow_nan=False),'allocation_snapshot_id':'e'*64}}))
