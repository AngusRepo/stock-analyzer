from copy import deepcopy
from datetime import date,timedelta
from pathlib import Path
import json
import numpy as np
import polars as pl
import pytest
from services import l4_p6_recipe as recipe
from services.l4_p6_final_inputs import prepare_final
from services.training_dual_cutoff import TrainingCutoff
from services.l4_distribution import digest
from test_l4_p6_recipe import rows,graph,MODELS


@pytest.fixture
def batch(tmp_path):
    calendar=[(date(2026,7,1)+timedelta(days=i)).isoformat() for i in range(100)
        if (date(2026,7,1)+timedelta(days=i)).weekday()<5]
    source=[]
    for i,day in enumerate(calendar[10:55],10):
        for row in rows(day):
            row.update(label_known_date=calendar[i+5],feature_roots={**{m:'base' for m in MODELS},'native_meta':'meta'})
            source.append(row)
    g=graph();g['nodes']['known'].update(date='2026-06-01',label_known_date='2026-06-08')
    g['checksum']=digest({k:v for k,v in g.items() if k!='checksum'})
    cutoff=TrainingCutoff('2026-09-22','2026-10-01');directories=[];checksums={}
    for fold,start in enumerate((43,46,49,52),1):
        directory=tmp_path/str(fold);directories.append(directory)
        spec=dict(fold=fold,head_eligible_train_dates=[calendar[30]],head_eligible_validation_dates=calendar[start:start+3],
            calendar_purge_dates=calendar[start-5:start+8])
        receipt=recipe.prepare_fold(source,spec=spec,graph=g,cutoff=cutoff,calendar=calendar,calendar_sha256='a'*64,output=directory)
        checksums[str(fold)]=receipt['checksum']
    identity=digest(dict(recipe=recipe.RECIPE,fold_receipt_checksums=checksums,cutoff=cutoff.__dict__))
    selections={}
    for seed in recipe.PROTOCOL['seeds']:
        s=dict(seed=seed,recipe=recipe.RECIPE,fold_receipt_checksums=checksums,batch_id=identity,
            selection_target=recipe.PROTOCOL['selection_target'],selected=[[2,1],[2,1],[4,3]],refit_max_epoch=4)
        selections[seed]={**s,'checksum':digest(s)}
    return directories,selections,cutoff,tmp_path/'final'


def test_final_refit_uses_current_heldout_rows_and_crossfitted_probabilities(batch):
    directories,selections,cutoff,out=batch
    result=prepare_final(directories,selections=selections,cutoff=cutoff,output=out)
    assert result['rows']==84 and len(result['dates'])==12 and result['feature_count']==31
    assert result['outer_rows']==0 and result['neural_training_started'] is False
    assert result['epoch_reselection_allowed'] is False
    raw=pl.read_parquet(out/'crossfitted-native.parquet').to_dicts()
    p=pl.read_parquet(out/'crossfitted-p-loss.parquet')['p_loss'].to_numpy()
    actual_recipe=json.loads((out/'recipe.json').read_bytes())
    expected,_=recipe.matrix(raw,p,actual_recipe)
    with np.load(out/'arrays.npz') as arrays:
        assert set(arrays.files)=={'train_x','train_y'}
        np.testing.assert_array_equal(arrays['train_x'],expected)
        np.testing.assert_array_equal(arrays['train_y'],recipe.targets(raw,training=True)['target'].to_numpy().astype(np.float32))
    assert prepare_final(directories,selections=selections,cutoff=cutoff,output=out)==result
    assert result['checksum']==digest({k:v for k,v in result.items() if k!='checksum'})


def test_final_refit_rejects_old_selection_changed_epoch_or_tampered_file(batch):
    directories,selections,cutoff,out=batch
    old=deepcopy(selections);old[42]['batch_id']='old-r16'
    with pytest.raises(ValueError,match='selection_binding'):prepare_final(directories,selections=old,cutoff=cutoff,output=out)
    changed=deepcopy(selections);changed[42]['refit_max_epoch']=5
    changed[42]['checksum']=digest({k:v for k,v in changed[42].items() if k!='checksum'})
    with pytest.raises(ValueError,match='epoch_changed'):prepare_final(directories,selections=changed,cutoff=cutoff,output=out)
    with pytest.raises(ValueError,match='four_folds'):prepare_final(directories[:3],selections=selections,cutoff=cutoff,output=out)
    (directories[0]/'val-pure-p-loss.parquet').write_bytes(b'tamper')
    with pytest.raises(ValueError,match='fold_file_changed'):prepare_final(directories,selections=selections,cutoff=cutoff,output=out)
    assert not out.exists()
