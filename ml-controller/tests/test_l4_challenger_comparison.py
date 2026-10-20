from copy import deepcopy
import pytest
from services.l4_challenger_comparison import RULES, digest, seal, evaluate, qualify_data
from services.l4_comparison_statistics import primary

def fixtures(count=7):
    entries = {
        'old-chain': {'components': {'l3':'old','l4':'old'},'calibration':'raw'},
        'refit-202610-c': {'components': {'l3':'new','l4':'new'},'calibration':'empirical_bayes'},
        'refit-202610-a': {'components': {'l3':'old','l4':'new'},'calibration':'raw'},
    }
    registry = seal({'rules_sha':digest(RULES),'champion_id':'old-chain','entries':entries})
    calendar = [{'signal_date':f'2026-10-{d+2:02d}','label_known_at_max':f'2026-10-{d+12:02d}',
                 'accounts':{k:{'eligible':True,'reasons':[]} for k in entries}} for d in range(count)]
    eligibility = seal({'rules_sha':digest(RULES),'registry_checksum':registry['checksum'],
                        'sealed_at':'2026-10-20T00:00:00Z','calendar':calendar})
    observations=[]
    for row in calendar:
        accounts={k:{'target_weight_timing':'preopen_targets','target_receipt_sha':'a'*64,
                     'solve_success':True,'exposure':.2,'primary':.02 if k!='old-chain' else .01,
                     'target_holding_age_value_sum':2.,'target_holding_market_value':1.} for k in entries}
        observations.append(seal({'signal_date':row['signal_date'],'eligibility_checksum':eligibility['checksum'],
                                  'calculated_at':'2026-10-20T01:00:00Z','accounts':accounts}))
    return dict(registry=registry,eligibility=eligibility,observations=observations,
                assessment_date='2026-10-30',user_request_id='explicit-user-request')

def update_sealed(record, mutate):
    body=deepcopy({k:v for k,v in record.items() if k!='checksum'});mutate(body);return seal(body)

def test_arbitrary_ids_and_seven_days_have_no_twenty_day_gate_and_simpler_wins():
    result=evaluate(**fixtures())
    assert result['status']=='recommend_user_decision'
    assert result['selected_id']=='refit-202610-a'
    assert result['challenger_count']==2 and len(result['common_eligible_dates'])==7
    assert result['promotion_allowed'] is False

def test_assessment_is_user_triggered():
    data=fixtures();data['user_request_id']=''
    with pytest.raises(ValueError,match='requires_user_request'):evaluate(**data)

def test_zero_exposure_not_zero_performance():
    assert primary({'x':0.},{'x':.3},['x'])['primary'] is None
    data=fixtures()
    data['observations'][0]=update_sealed(data['observations'][0],lambda b:b['accounts']['old-chain'].update(exposure=0.,primary=0.))
    with pytest.raises(ValueError,match='zero_exposure'):evaluate(**data)

def test_missing_observation_is_not_silently_excluded():
    data=fixtures();removed=data['observations'].pop(0)
    result=evaluate(**data)
    assert result['status']=='incomplete_observations'
    assert result['missing_dates']==[removed['signal_date']]

def test_failed_solve_remains_in_operational_denominator():
    data=fixtures()
    data['observations'][0]=update_sealed(data['observations'][0],lambda b:b['accounts']['refit-202610-a'].update(solve_success=False,primary=None))
    result=evaluate(**data)
    assert result['selected_id']=='refit-202610-a'
    assert result['operational']['refit-202610-a']['solve_rate']==6/7
    assert not result['gates']['solve_rate'] and result['status']=='retain_champion_operational_gate_failed'

def test_eligibility_must_precede_performance_and_cannot_be_changed():
    data=fixtures()
    data['observations'][0]=update_sealed(data['observations'][0],lambda b:b.update(calculated_at='2026-10-19T00:00:00Z'))
    with pytest.raises(ValueError,match='performance_before'):evaluate(**data)
    data=fixtures();data['eligibility']['calendar'][0]['accounts']['old-chain']['eligible']=False
    with pytest.raises(ValueError,match='checksum'):evaluate(**data)

def test_negative_pool_excess_blocks_switch_despite_beating_champion():
    data=fixtures()
    for i,r in enumerate(data['observations']):
        def mutate(b):
            for key,row in b['accounts'].items():row['primary']=-.02 if key=='old-chain' else -.01
        data['observations'][i]=update_sealed(r,mutate)
    assert evaluate(**data)['status']=='L4 選股未勝過候選池平均'

def test_fewer_changed_components_precedes_calibration_simplicity():
    data=fixtures()
    registry=deepcopy({k:v for k,v in data['registry'].items() if k!='checksum'})
    registry['entries']['refit-202610-c']['components']['l3']='old'
    registry['entries']['refit-202610-a']['components']['l3']='new'
    data['registry']=seal(registry)
    data['eligibility']=update_sealed(data['eligibility'],lambda b:b.update(registry_checksum=data['registry']['checksum']))
    data['observations']=[update_sealed(r,lambda b:b.update(eligibility_checksum=data['eligibility']['checksum'])) for r in data['observations']]
    assert evaluate(**data)['selected_id']=='refit-202610-c'

def data_proofs():
    cutoff=seal({'component_checksum':'model','signal_date_max':'2026-09-22','label_known_at_max':'2026-10-01',
                 'ancestor_label_known_at_max':'2026-10-01','feature_vintage':'verified-raw-receipt',
                 'actual_trained_at':'2026-10-19T00:00:00Z'})
    return dict(entry={'components':{'l4':'model'},'trainable_components':['l4'],'training_receipts':{'l4':cutoff}},
        signal_date='2026-10-02',next_open='2026-10-05T09:00:00+08:00',incidents=[],
        input_evidence=seal({'signal_date':'2026-10-02','reconstruction_verified':True,'source_receipt_shas':['a'*64],
          'latest_source_available_at':'2026-10-05T08:40:00+08:00','hmm_computed_at':'2026-10-02T23:00:00+08:00',
          'recorded_at':'2026-10-19T00:00:00Z','evidence_kind':'retrospective_holdout'}))

def test_retrospective_keeps_real_recording_time_but_requires_pit_sources():
    data=data_proofs();result=qualify_data(**data)
    assert result['eligible'] and result['reconstruction_recorded_at']=='2026-10-19T00:00:00Z'
    data['input_evidence']=update_sealed(data['input_evidence'],lambda b:b.update(hmm_computed_at='2026-10-05T09:01:00+08:00'))
    assert qualify_data(**data)['reasons']==['hmm_computed_after_open']

def test_same_day_training_label_or_ancestor_is_rejected():
    data=data_proofs()
    data['entry']['training_receipts']['l4']=update_sealed(data['entry']['training_receipts']['l4'],lambda b:b.update(ancestor_label_known_at_max='2026-10-02'))
    assert not qualify_data(**data)['eligible']
