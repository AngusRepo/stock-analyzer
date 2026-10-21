from copy import deepcopy
import io
import json
from unittest.mock import Mock
import zipfile
import pytest
from app import l4_p6_job as job


def request():
    return dict(seed=42,phase='cv',batch_id='a'*64,
        inputs=dict(path='l4_distribution/p6_batches/'+('a'*64)+'/inputs.zip',sha256='b'*64))


def result(payload):
    return dict(schema_version='p6-seed-result-v1',recipe='p6-a-direct-excess-pure8-ploss-fourfold-v1',
        sealed_batch_id=payload['batch_id'],phase=payload['phase'],seed=payload['seed'],
        training_completed=True,promoted=False,outer_rows=0,checkpoint_restoration=[dict(training_steps=0)])


def test_job_and_result_do_not_accept_other_batches_or_r2_paths():
    payload=request()
    assert job.validate_request(payload).endswith('/cv/seed42/')
    for change in (dict(seed=45),dict(phase='monthly'),dict(batch_id='..'),dict(inputs=dict(path='l4_distribution/r2_batches/x',sha256='b'*64))):
        with pytest.raises(ValueError):job.validate_request({**payload,**change})
    assert job.verify_result(result(payload),payload)['promoted'] is False
    for change in (dict(sealed_batch_id='old'),dict(promoted=True),dict(outer_rows=1),dict(checkpoint_restoration=[]),
            dict(checkpoint_restoration=[dict(training_steps=1)])):
        with pytest.raises(ValueError):job.verify_result({**result(payload),**change},payload)


def test_completed_delivery_does_not_claim_or_launch_again(monkeypatch):
    from google.cloud import storage
    payload=request();bucket=Mock();launch=Mock()
    monkeypatch.setattr(storage,'Client',lambda:Mock(bucket=lambda _:bucket))
    monkeypatch.setattr(job,'read_verified',lambda *_:result(payload))
    monkeypatch.setattr(job.subprocess,'run',launch)
    assert job.run(payload)['training_completed'] is True
    bucket.blob.assert_not_called();launch.assert_not_called()


def test_claimed_incomplete_delivery_does_not_restart(monkeypatch):
    from google.cloud import storage
    from google.api_core.exceptions import PreconditionFailed
    payload=request();body=dict(phase='cv');payload['batch_id']=job.hashlib.sha256(json.dumps(body,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    payload['inputs']['path']=f"l4_distribution/p6_batches/{payload['batch_id']}/inputs.zip"
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w') as z:z.writestr('batch-seal.json',json.dumps({**body,'batch_id':payload['batch_id']}))
    raw=buffer.getvalue();payload['inputs']['sha256']=job.hashlib.sha256(raw).hexdigest()
    source=Mock(generation=1);source.download_as_bytes.return_value=raw
    bucket=Mock();bucket.get_blob.return_value=source
    bucket.blob.return_value.upload_from_string.side_effect=PreconditionFailed('already claimed')
    monkeypatch.setattr(storage,'Client',lambda:Mock(bucket=lambda _:bucket))
    monkeypatch.setattr(job,'read_verified',lambda *_:None)
    launch=Mock();monkeypatch.setattr(job.subprocess,'run',launch)
    with pytest.raises(PreconditionFailed):job.run(payload)
    launch.assert_not_called()
