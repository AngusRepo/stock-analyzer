from copy import deepcopy
from datetime import date,timedelta
from services.active8_oof_stacker import ACTIVE8_MODELS
from services.l4_native_meta_replica import replica_builder


def test_native_research_replica_cannot_see_future_labels_or_parent_validation():
    rows=[]
    first=date(2026,1,1)
    for d in range(32):
        day=str(first+timedelta(days=d))
        for i in range(60):
            rank=i/59
            for model in ACTIVE8_MODELS:
                rows.append({'fold_id':'synthetic-fold','prediction_date':day,'symbol':f'S{i:03d}',
                    'market_segment':'TW','model_name':model,'rank_score':rank,
                    'target_return':(rank-.5)*.08,'label_known_date':str(first+timedelta(days=d+5)),
                    'artifact_version':model+'-synthetic','test_start':str(first),'test_end':'2026-02-01'})
    parent={'signal_policy':{},'cohort_id':'synthetic','base_artifact_set_checksum':'b'*64,
            'validation':{'decision':'PASS','future_return':999}}
    cutoff='2026-01-29'
    prior=[r for r in rows if r['label_known_date']<=cutoff]
    build,_=replica_builder(rows,parent)
    actual=build(prior,knowledge_cutoff_date=cutoff)
    changed=deepcopy(rows)
    for row in changed:
        if row['label_known_date']>cutoff:row['target_return']=-row['target_return']+10
    parent['validation']={'decision':'FAIL','future_return':-999}
    again,_=replica_builder(changed,parent)
    assert again(prior,knowledge_cutoff_date=cutoff)==actual
    assert actual['serving_eligible'] is False
    assert actual['validation']['decision']=='FAIL'
    assert actual['training']['label_known_max']<actual['training']['prediction_date']
