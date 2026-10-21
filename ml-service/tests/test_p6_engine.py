import copy
import io
from types import SimpleNamespace
import numpy as np
import pytest
import torch
from app.p6_engine import p6_train as engine


def test_31_column_export_preserves_predictions_with_constant_features_removed():
    rng=np.random.default_rng(42)
    indices=np.array([0,3,9,30])
    state={'backbone.n_blocks':torch.tensor([2]),
        'backbone.blocks.0.linear.weight':torch.tensor(rng.normal(size=(1,7,4)),dtype=torch.float32),
        'backbone.blocks.0.linear.bias':torch.tensor(rng.normal(size=(1,7)),dtype=torch.float32),
        'backbone.blocks.1.linear.weight':torch.tensor(rng.normal(size=(1,7,7)),dtype=torch.float32),
        'backbone.blocks.1.linear.bias':torch.tensor(rng.normal(size=(1,7)),dtype=torch.float32),
        'output.weight':torch.tensor(rng.normal(size=(1,1,7)),dtype=torch.float32),
        'output.bias':torch.tensor(rng.normal(size=(1,1)),dtype=torch.float32)}
    pack=SimpleNamespace(indices=indices,model=SimpleNamespace(state_dict=lambda:state))
    x=rng.normal(size=(12,31)).astype(np.float32)
    values=torch.from_numpy(x[:,indices])
    for name in ('backbone.blocks.0.linear','backbone.blocks.1.linear','output'):
        values=torch.nn.functional.linear(values,state[name+'.weight'][0],state[name+'.bias'][0])
        if name!='output':values=torch.relu(values)
    depth,weights=engine.export_member(pack,0)
    assert weights['l0_weight'].shape==(31,7)
    np.testing.assert_allclose(engine.numpy_member(x,depth,weights),values[:,0].numpy(),rtol=2e-5,atol=2e-6)


@pytest.mark.parametrize('phase',['cv','final'])
def test_arrays_reject_retired_width_and_nonfinite(tmp_path,phase):
    arrays={r+s:v for r in (('train','val') if phase=='cv' else ('train',))
        for s,v in (('_x',np.ones((4,31))),('_y',np.arange(4.)))}
    np.savez(tmp_path/'arrays.npz',**arrays)
    assert engine.arrays_at(tmp_path,phase)['train_x'].shape==(4,31)
    arrays['train_x']=np.ones((4,34))
    np.savez(tmp_path/'arrays.npz',**arrays)
    with pytest.raises(ValueError,match='shape_or_value'):engine.arrays_at(tmp_path,phase)
    arrays['train_x']=np.full((4,31),np.nan)
    np.savez(tmp_path/'arrays.npz',**arrays)
    with pytest.raises(ValueError,match='shape_or_value'):engine.arrays_at(tmp_path,phase)


def test_checksum_and_archive_path_boundaries(tmp_path):
    (tmp_path/'arrays.npz').write_bytes(b'fixture')
    valid={'arrays.npz':engine.sha(tmp_path/'arrays.npz')}
    engine.verify_files(tmp_path,valid,{'arrays.npz'})
    with pytest.raises(ValueError,match='incomplete'):engine.verify_files(tmp_path,{}, {'arrays.npz'})
    with pytest.raises(ValueError,match='changed'):engine.verify_files(tmp_path,{'arrays.npz':'0'*64},set())
    for name in ('../outside','/absolute','C:/absolute','safe\\bad'):
        with pytest.raises(ValueError,match='unsafe'):engine.checked_file(tmp_path,name)


def test_selection_binds_current_fold_target_and_fixed_epochs():
    receipt={'batch_id':'current','fold_receipt_checksums':{'1':'a'}}
    selection=dict(recipe=engine.RECIPE,seed=42,batch_id='current',fold_receipt_checksums={'1':'a'},
        selection_target='actual_pool_relative_return_daily_equal_rank_IC',selected=[[5,2],[5,2],[7,4]],refit_max_epoch=7)
    def signed(s):return {**s,'checksum':engine.digest(s)}
    assert engine.verify_selection(signed(selection),receipt,42)==[(5,2),(5,2),(7,4)]
    for key,value in [('batch_id','old'),('selection_target','residual_IC'),('refit_max_epoch',8),
            ('selected',[[5,16]]),('selected',[[201,0]]),('selected',[[True,0]])]:
        bad={**selection,key:value}
        with pytest.raises(ValueError):engine.verify_selection(signed(bad),receipt,42)
    bad=signed(selection);bad['seed']=43
    with pytest.raises(ValueError):engine.verify_selection(bad,receipt,43)


def test_checkpoint_restoration_does_not_train_or_reset_rng():
    model=torch.nn.Linear(2,1);optimizer=torch.optim.AdamW(model.parameters())
    # Synthetic CPU update creates optimizer state; this is not a production fit.
    model(torch.ones((2,2))).sum().backward();optimizer.step()
    expected=copy.deepcopy(model.state_dict());buffer=io.BytesIO()
    torch.save(dict(model=expected,optimizer=optimizer.state_dict(),epoch=3),buffer)
    pack=SimpleNamespace(model=model,optimizer=optimizer,x=torch.ones(1),steps=1)
    with torch.no_grad():model.weight.zero_()
    rng=torch.get_rng_state().clone()
    engine.restore(pack,buffer.getvalue(),3)
    assert pack.steps==1 and torch.equal(rng,torch.get_rng_state())
    assert torch.equal(pack.model.weight,expected['weight'])
    with pytest.raises(ValueError,match='state_invalid'):engine.restore(pack,buffer.getvalue(),4)


def test_final_lineage_retains_input_identity_and_rejects_late_labels(tmp_path):
    (tmp_path/'receipt.json').write_text('sealed receipt',encoding='utf8')
    receipt=dict(checksum='receipt-hash',signal_date_max='2026-09-22',label_known_at_max='2026-10-01',
        requested_cutoff=dict(signal_date_max='2026-09-22',label_known_at_max='2026-10-01'),
        fold_receipt_checksums={'1':'fold-hash'},files_sha256={'frozen-p-loss.json':'head-hash','source.json':'source-hash'})
    proof=engine.final_lineage(tmp_path,receipt,{'checksum':'selection-hash'})
    assert proof['input_receipt_sha256']==engine.sha(tmp_path/'receipt.json')
    assert proof['selection_checksum']=='selection-hash' and proof['frozen_p_loss_sha256']=='head-hash'
    for changes in ({'signal_date_max':'2026-09-23'},{'label_known_at_max':'2026-10-02'},
                    {'label_known_at_max':'2026-09-22'},{'signal_date_max':'2026-9-22'}):
        with pytest.raises(ValueError):engine.final_lineage(tmp_path,{**receipt,**changes},{'checksum':'selection-hash'})
