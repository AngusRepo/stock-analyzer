from copy import deepcopy
import hashlib,io,json
import numpy as np
import pytest
from services import l4_p6_bundle as owner
from services.l4_distribution import digest,feature_names
from services.alpha_model_roster import TIMEXER_MODELS
from services.l4_p6_recipe import RECIPE,PROTOCOL
from services.l4_p6_pure_head import NAMES

def sealed(value):return dict(value,checksum=digest(value))
def fixture():
    bounds={'signal_date_max':'2026-09-22','label_known_at_max':'2026-10-01'}
    frozen=sealed(dict(binding={'batch_id':'a'*64,'cutoff':bounds},model={
        'recipe':{'names':NAMES,'mean':[0.]*16,'scale':[1.]*16},
        'head':{'head':'p_loss','beta':[0.]*16,'intercept':0.}},
        receipt={'label_known_at_max':'2026-10-01'},training_head_replaced=False,outer_updates_allowed=False))
    headraw=json.dumps(frozen,sort_keys=True).encode();headsha=hashlib.sha256(headraw).hexdigest()
    final=sealed(dict(schema_version='p6-final-refit-inputs-v1',recipe=RECIPE,batch_id='a'*64,
        epoch_reselection_allowed=False,outer_rows=0,requested_cutoff=bounds,
        signal_date_max='2026-09-22',label_known_at_max='2026-10-01',
        fold_receipt_checksums={str(i):str(i)*64 for i in range(1,5)},files_sha256={'frozen-p-loss.json':headsha}))
    calibration=sealed(dict(schema_version='p6-frozen-oof-calibration-v1',scope='full_classified_candidate_pool',
        requested_cutoff=bounds,outer_updates_allowed=False,outer_data_used=False,refit_predictions_used=False,
        linear_b=.4,label_known_at_max='2026-10-01',realized_bins=[{'bin':i,'mean':.01} for i in range(9)]))
    report=sealed(dict(schema_version='p6-inner-validation-r32-v1',evidence_scope='inner_development_only',outer_credit=0,
        metrics={'all':{'top5_excess_pp':{'mean':1.2}}},calibration=calibration,champion_B_gate={'status':'pass'}))
    recipe=dict(recipe_version=RECIPE,gain_loss_A_removed=True,A_weight=0,p_loss_features=NAMES,
        feature_names=feature_names(TIMEXER_MODELS)+['p_loss'],
        native={'names':feature_names(TIMEXER_MODELS),'mean':[0.]*30,'scale':[1.]*30},
        p_loss_scaler={'mean':.5,'scale':.1})
    buffer=io.BytesIO();np.savez_compressed(buffer,m0_l0_weight=np.zeros((31,384),np.float32),
        m0_l0_bias=np.zeros(384,np.float32),m0_l1_weight=np.zeros((384,1),np.float32),m0_l1_bias=np.zeros(1,np.float32))
    raw=buffer.getvalue();weights={};results=[];selections={}
    for seed in [42,43,44]:
        selection=sealed(dict(seed=seed,recipe=RECIPE,fold_receipt_checksums=final['fold_receipt_checksums'],batch_id='a'*64,selection_target=PROTOCOL['selection_target'],
                              selected=[[1,0]],refit_max_epoch=1))
        selections[seed]=selection
        path=f'l4_distribution/p6_batches/{"b"*64}/final/seed{seed}/weights.npz';weights[path]=raw
        results.append(dict(seed=seed,phase='final',recipe=RECIPE,training_completed=True,promoted=False,outer_rows=0,
            training_lineage=dict(input_receipt_checksum=final['checksum'],fold_receipt_checksums=final['fold_receipt_checksums'],
                requested_cutoff=bounds,label_known_at_max='2026-10-01',signal_date_max='2026-09-22',
                frozen_p_loss_sha256=headsha,selection_checksum=selection['checksum']),
            checkpoint_restoration=[{'training_steps':0}],completed_epochs=1,
            training_started_at='2026-10-19T11:00:00+00:00',training_completed_at='2026-10-19T12:00:00+00:00',
            sealed_batch_id='b'*64,weights={'path':path,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'generation':'123'},
            final_recipe=recipe,members=[{'epoch':1,'member_id':0,'weight':1.,'depth':1}],target_mean=0.,target_scale=1.))
    args=dict(results=results,final_receipt=final,frozen_p_loss=frozen,frozen_p_loss_raw=headraw,
        inner_report=report,selections=selections,l3_identity={'artifact_id':'new-l3'},l3_training_label_known_max='2026-10-01',
        calibration_kind='linear',signal_date='2026-10-19',load_bytes=lambda ref:weights[ref['path']])
    return args

def test_build_binds_fresh_final_seeds_without_granting_release():
    args=fixture();bundle=owner.assemble(**args)
    assert owner.is_p6(bundle) and bundle['training_label_known_max']=='2026-10-01'
    assert 'release' not in bundle and 'heads' not in bundle['model']
    owner.validate(bundle,l3_identity=args['l3_identity'],signal_date='2026-10-19')

@pytest.mark.parametrize('field',['label_known_at_max','frozen_p_loss_sha256','selection_checksum'])
def test_old_or_mismatched_final_checkpoint_rejected(field):
    args=fixture();args['results'][0]['training_lineage'][field]='wrong'
    with pytest.raises(ValueError,match='seed_lineage'):owner.assemble(**args)

def test_positive_eb_or_pass_flag_cannot_hide_negative_raw_high_z_bin():
    args=fixture();report=args['inner_report'];c=report['calibration'];c['realized_bins'][8]['mean']=-.01
    c['checksum']=digest({k:v for k,v in c.items() if k!='checksum'})
    report['checksum']=digest({k:v for k,v in report.items() if k!='checksum'})
    with pytest.raises(ValueError,match='R32_B_gate_failed'):owner.assemble(**args)

def test_member_selection_and_weight_bytes_verified():
    args=fixture();args['results'][0]['members'][0]['epoch']=2
    with pytest.raises(ValueError,match='members_differ'):owner.assemble(**args)
    args=fixture();args['load_bytes']=lambda _:b'corrupt'
    with pytest.raises(ValueError,match='checksum_mismatch'):owner.assemble(**args)

def test_future_cutoff_wrong_identity_and_eb_rejected():
    args=fixture();bundle=owner.assemble(**args)
    with pytest.raises(ValueError,match='training_after_signal'):
        owner.validate(bundle,l3_identity=args['l3_identity'],signal_date='2026-10-01')
    with pytest.raises(ValueError,match='l3_identity'):
        owner.validate(bundle,l3_identity={'artifact_id':'old-l3'},signal_date='2026-10-19')
    args['calibration_kind']='eb'
    with pytest.raises(ValueError,match='bundle_contract'):owner.assemble(**args)
