from copy import deepcopy
import pytest
from services import premarket_pipeline as owner
from services import premarket_publication as publication
from test_premarket_pipeline import f, Storage, Blob

def prepared(f):
    storage,state,context=f
    owner.seal_l3(state,client=storage)
    state['premarket_context']=context
    state['l4_pending_plan']={'plan_id':'a'*64,'signal_date':state['run_date'],'execution_scope':'paper',
                            'policy_identity':'b'*64,'targets':{'2330':{'weight':.1}}}
    state['paired_nav_collection']={'status':'allocation_context_frozen','snapshot_id':'c'*64}
    state['metrics']={'l4_plan_publication':{'status':'stored','plan_id':'a'*64},
        'prediction_seed_symbols':1,'prediction_symbols':1,'predictions_written':8,
        'prediction_symbol_closure_passed':True,'incomplete_active_model_symbols':0,
        'recommendation_seed_rows':1,'recommendation_closed_rows':1,'recommendation_row_closure_passed':True}
    checkpoint=storage.blob(owner.prefix(state['run_date'],state['producer_run_id'])+'/phases/node_write_d1.json.gz')
    checkpoint.upload_from_string(b'fixture verified by resume owner')
    return storage,state,checkpoint

def test_serving_receipt_is_idempotent_and_does_not_claim_nav_success(f):
    storage,state,_=prepared(f);before=deepcopy(state)
    one=publication.record(state,client=storage)
    assert publication.record(state,client=storage)==one
    assert one['research_status']=='separate_owner_pending' and one['nav_maturity_credit']==0
    assert state==before
    state['paired_nav_collection']={'status':'failed','reason':'research_after_publication_failed'}
    assert publication.read(state['run_date'],state['producer_run_id'],client=storage)==one
    assert state['paired_nav_collection']['status']=='failed'

@pytest.mark.parametrize('fault',('closure','readback','snapshot','checkpoint','nonresearch_error'))
def test_no_receipt_for_incomplete_or_unverified_serving(f,fault):
    storage,state,checkpoint=prepared(f)
    if fault=='closure':state['metrics']['recommendation_row_closure_passed']=False
    elif fault=='readback':state['metrics']['l4_plan_publication']['status']='unknown'
    elif fault=='snapshot':state['paired_nav_collection']['status']='failed'
    elif fault=='checkpoint':checkpoint.raw=None
    else:state['errors']=['d1_write:failed']
    with pytest.raises(ValueError):publication.record(state,client=storage)
    assert publication.read(state['run_date'],state['producer_run_id'],client=storage) is None

def test_changed_plan_and_corrupt_receipt_are_rejected(f):
    storage,state,_=prepared(f);publication.record(state,client=storage)
    state['l4_pending_plan']['policy_identity']='d'*64
    with pytest.raises(ValueError,match='identity_changed'):publication.record(state,client=storage)
    key=owner.prefix(state['run_date'],state['producer_run_id'])+'/serving-publication.json'
    storage.blob(key).raw=storage.blob(key).raw.replace(b'"target_count":1',b'"target_count":2')
    with pytest.raises(ValueError,match='corrupt'):publication.read(state['run_date'],state['producer_run_id'],client=storage)

def test_old_checkpoint_does_not_invent_publication_receipt(f):
    storage,state,_=prepared(f);state['metrics'].pop('l4_plan_publication')
    assert publication.record(state,client=storage) is None
