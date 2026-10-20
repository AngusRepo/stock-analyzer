from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import hashlib
import io
import json
import numpy as np
import polars as pl
import pytest
from services import l4_p6_recipe as recipe
from services.l4_distribution import digest
from services.l4_p6_results import collect_cv
from services.l4_p6_final_inputs import prepare_final
from test_l4_p6_final_inputs import batch


class Bucket:
    def __init__(self):self.saved={}
    def put(self,path,raw):
        ref=dict(path=path,sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw),generation='1')
        self.saved[path]=(raw,ref)
        return ref
    def json(self,path,value):return self.put(path,json.dumps(value).encode())
    def get_blob(self,path):
        if path not in self.saved:return None
        raw,ref=self.saved[path]
        def read(**kwargs):
            assert str(kwargs['if_generation_match'])==ref['generation']
            return raw
        return SimpleNamespace(generation=1,metadata={'sha256':ref['sha256']},download_as_bytes=read)


def results(batch):
    directories,selections,cutoff,out=batch
    frame=pl.concat([pl.read_parquet(d/'val-rows.parquet') for d in directories])
    bucket=Bucket();batch_id='c'*64
    for seed in (42,43,44):
        prefix=f'l4_distribution/p6_batches/{batch_id}/cv/seed{seed}/'
        arrays=dict(dates=frame['date'].to_numpy().astype(str),symbols=frame['symbol'].to_numpy().astype(str),
            gross_return=frame['gross_return'].to_numpy(),relative_return=frame['relative_return'].to_numpy(),
            prediction=frame['relative_return'].to_numpy()*(seed-41))
        buffer=io.BytesIO();np.savez_compressed(buffer,**arrays)
        ref=bucket.put(prefix+'selected-validation.npz',buffer.getvalue());bucket.json(prefix+'objects.json',[ref])
        bucket.json(prefix+'completed.json',dict(schema_version='p6-seed-result-v1',recipe=recipe.RECIPE,
            sealed_batch_id=batch_id,seed=seed,phase='cv',training_completed=True,promoted=False,outer_rows=0,
            checkpoint_restoration=[dict(fold=f,training_steps=0) for f in range(1,5)],selection=selections[seed]))
    return bucket,batch_id


def test_verified_three_seed_results_feed_new_calibration_and_fixed_final_refit(batch):
    bucket,batch_id=results(batch);directories,selections,cutoff,out=batch
    dest=out.parent/'results'
    receipt,selected,calibration=collect_cv(bucket,directories,sealed_batch_id=batch_id,cutoff=cutoff,output=dest)
    assert selected==selections and receipt['rows']==84
    assert calibration['linear_b']==pytest.approx(.5)
    assert calibration['outer_data_used'] is False and calibration['refit_predictions_used'] is False
    assert calibration['eb_application']=='diagnostic_only_not_registered'
    assert collect_cv(bucket,directories,sealed_batch_id=batch_id,cutoff=cutoff,output=dest)==(receipt,selected,calibration)
    final=prepare_final(directories,selections=selected,cutoff=cutoff,output=out)
    assert final['batch_id']==receipt['input_identity']
    assert final['epoch_reselection_allowed'] is False


def test_self_consistent_wrong_label_row_or_old_selection_is_rejected(batch):
    bucket,batch_id=results(batch);directories,selections,cutoff,out=batch
    prefix=f'l4_distribution/p6_batches/{batch_id}/cv/seed42/'
    pristine=deepcopy(bucket.saved)
    for column in ('gross_return','symbols'):
        bucket.saved=deepcopy(pristine)
        path=prefix+'selected-validation.npz'
        with np.load(io.BytesIO(bucket.saved[path][0]),allow_pickle=False) as saved:
            arrays={k:saved[k].copy() for k in saved.files}
        if column=='gross_return':arrays[column][0]+=1
        else:arrays[column][[0,1]]=arrays[column][[1,0]]
        buffer=io.BytesIO();np.savez_compressed(buffer,**arrays)
        reference=bucket.put(path,buffer.getvalue());bucket.json(prefix+'objects.json',[reference])
        with pytest.raises(ValueError,match='row_or_target_changed'):
            collect_cv(bucket,directories,sealed_batch_id=batch_id,cutoff=cutoff,output=out)
        assert not out.exists()
    bucket.saved=deepcopy(pristine)
    path=prefix+'completed.json';value=json.loads(bucket.saved[path][0]);value['selection']['batch_id']='old'
    value['selection']['checksum']=digest({k:v for k,v in value['selection'].items() if k!='checksum'})
    bucket.json(path,value)
    with pytest.raises(ValueError,match='selection_identity'):
        collect_cv(bucket,directories,sealed_batch_id=batch_id,cutoff=cutoff,output=out)
    assert not out.exists()
