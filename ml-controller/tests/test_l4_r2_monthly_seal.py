import hashlib,io,json,zipfile
import pytest
from services.l4_r2_monthly import seal_inputs


def test_dynamic_monthly_seal_is_byte_identical_and_binds_every_matrix(tmp_path):
    manifest={'training_ready':True,'eligible_dates':[str(n) for n in range(20)],
              'folds':[{'fold':s} for s in ['1','2','3','4','final']]}
    (tmp_path/'matrices-manifest.json').write_text(json.dumps(manifest))
    (tmp_path/'arrays.npz').write_bytes(b'fixed training inputs')
    kwargs=dict(protocol={'seeds':[42,43,44]},provenance={'as_of':'2026-10-15'})
    first,raw=seal_inputs(tmp_path,**kwargs)
    assert (first,raw)==seal_inputs(tmp_path,**kwargs)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for row in first['input_files']:
            assert hashlib.sha256(archive.read(row['path'])).hexdigest()==row['sha256']
    (tmp_path/'arrays.npz').write_bytes(b'a newer matured source')
    second,_=seal_inputs(tmp_path,**kwargs)
    assert second['batch_id']!=first['batch_id']


def test_not_enough_dates_cannot_start_monthly_fit(tmp_path):
    (tmp_path/'matrices-manifest.json').write_text(json.dumps(
        {'training_ready':True,'eligible_dates':['2026-10-01'],'folds':[]}))
    with pytest.raises(ValueError,match='matrices_not_ready'):
        seal_inputs(tmp_path,protocol={},provenance={})
