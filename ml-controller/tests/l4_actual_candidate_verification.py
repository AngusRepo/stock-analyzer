"""Actual candidate + archived native L3 feature vectors, synthetic account/risk.
This verifies the inference/allocation contract, never historical portfolio P&L.
"""
import json,sys,time
from pathlib import Path
from copy import deepcopy
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from services.l4_distribution import MODELS,digest,predict
from services.l4_distribution_runtime import run,native_features,distribution_policy_identity
from services.l4_allocation_contract import initial_paper_constraints,native_opb_policy

def main():
    output=Path(sys.argv[1]) if len(sys.argv)>1 else Path('audits/l4-completion')
    source=Path('audits/l4-completion')
    candidate=json.loads(Path('audits/l4-regression/native-three-fold-candidate.json').read_text(encoding='utf-8-sig'))
    cfg=json.loads((source/'current-worker-config-response.json').read_text(encoding='utf-8-sig'))
    rows=json.loads(Path('audits/l4-refactor/native-oof-rows.json').read_text(encoding='utf-8-sig'))
    baseline={(r['date'],r['symbol']):r['native_l3_gross'] for r in json.loads(Path('audits/l4-regression/native-l3-predictions.json').read_text(encoding='utf-8-sig'))}
    identity=candidate['l3_identity'];checks=[];rng=np.random.default_rng(17)
    constraints=initial_paper_constraints(cfg)
    for day in sorted({r['date'] for r in rows if r['date']>candidate['training_label_known_max']}):
        observations=[r for r in rows if r['date']==day];recs=[];predictions={}
        for row in observations:
            symbol=row['symbol'];f=row['features'];available=[m for m in MODELS if f[m+'_available']]
            p={'rank_scores':{m:f[m+'_rank'] for m in available},
                'model_score_lineage':{'raw_scores':{m:f[m+'_raw'] for m in available},
                    'selected_models':available,'coverage_policy':'validated-bundle-selected-core-sequence-missingness-v1',
                    'ensemble_payload_checksum':identity['payload_checksum'],'complete':True},
                'ensemble_v2':{'artifact_id':identity['artifact_id'],'cohort_id':identity['cohort_id'],
                    'artifact_checksum':identity['payload_checksum'],'base_artifact_set_checksum':identity['base_artifact_set_checksum'],
                    'avg_rank':f['ensemble_directional_margin']+.5,'probability_positive_net_return':f['ensemble_directional_margin']+.5,
                    'avg_rank_semantic':'compatibility_alias_probability_positive_net_return','lineage_status':'complete',
                    'validation':{'decision':'PASS'},'signal':'HOLD',
                    'target_semantic_version':'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4',
                    'forecast_horizon_bars':5,'forecast_return_5bar_source':'active8_ensemble_expected_net_return',
                    'forecast_return_5bar_owner':'active8_ensemble_artifact',
                    'ml_expected_net_return':baseline[day,symbol]-.0018,'forecast_return_5bar':baseline[day,symbol]-.0018}}
            rec={'symbol':symbol,'eligible_for_pending_buy':1,'score_components':{'components':{'mlEdge':f['ml_edge_norm']*25}}}
            assert native_features(rec,p,identity)==f
            recs.append(rec);predictions[symbol]=p
        policy={'scope':'private_research','artifact':candidate,'constraints':constraints,
            'opb':native_opb_policy(constraints),
            'runtime':{'signal_date':day,'l3_identity':identity,'predictions':predictions,
                'account':{'schema_version':'l4-account-context-v1','account_id':1,'signal_date':day,'complete':True,
                    'nav':1000000,'available_cash':1000000,'holdings':[],'locked_symbols':[],'forbidden_buys':[],
                    'risk_limits':{'exposure_cap':1.,'name_cap':cfg['circuit']['maxPositionPct'],
                        'max_positions':cfg['position']['maxPositions'],'min_trade_value':cfg['position']['minPositionValue']},
                    'fees':{'buy_cost':constraints['buy_cost'],'sell_cost':constraints['sell_cost']}}}}
        policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,identity)
        history={r['symbol']:rng.normal(0,.015,60).tolist() for r in recs}
        started=time.perf_counter();result=run(recs,policy,return_history=history,private_research=True)
        plan=result[0]['_l4_portfolio_plan'];direct=dict(zip([r['symbol'] for r in observations],predict(observations,candidate['model'])))
        for row in result:
            actual=row['l4_distribution'];expected=direct[row['symbol']]
            assert all(actual[k]==v for k,v in expected.items())
            assert abs(actual['l3_baseline']['expected_return_gross']-baseline[day,row['symbol']])<1e-12
        assert plan['proof']['evaluated_candidate_count']==len(observations) and not plan['proof']['preselection']
        checks.append({'date':day,'rows':len(observations),'seconds':time.perf_counter()-started,
            'selected':sum(w>1e-7 for w in plan['weights'].values()),'cash_weight':plan['cash_weight'],
            'plan_id':plan['plan_id'],'gap':plan['proof']['absolute_objective_gap']})
    packet={'scope':'actual_model_native_features_synthetic_account_risk','complete':True,
        'candidate_model_checksum':candidate['model_checksum'],'l3_identity':identity,'constraints':constraints,
        'dates':checks,'source_rows':sum(c['rows'] for c in checks),'max_feature_error':0,'inference_parity':True,
        'source_config_checksum':digest(cfg),'opb_policy':policy['opb'],
        'historical_l15_routing_reconstructed':False,'financial_superiority_proven':False}
    (output/'actual-candidate-runtime.json').write_text(json.dumps(packet,indent=2),encoding='utf8')
    print(json.dumps(packet))
if __name__=='__main__':main()
