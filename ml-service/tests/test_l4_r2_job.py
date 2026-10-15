import io,zipfile
import pytest
from app.l4_r2_job import validate_request,extract


@pytest.mark.parametrize('seed',[42,43,44])
def test_fixed_seed_and_batch_scope(seed):
    value={'seed':seed,'batch_id':'a'*64,'inputs':{'path':'l4_distribution/r2_batches/'+('a'*64)+'/inputs.zip','sha256':'b'*64}}
    assert validate_request(value).endswith(f'/seed{seed}/')
    value['seed']=45
    with pytest.raises(ValueError):validate_request(value)


@pytest.mark.parametrize('name',['../outside','/absolute','C:/absolute','safe\\bad'])
def test_archive_paths_checked_before_extraction(name):
    buffer=io.BytesIO()
    info=zipfile.ZipInfo('placeholder');info.filename=name
    with zipfile.ZipFile(buffer,'w') as z:z.writestr(info,b'bad')
    with pytest.raises(ValueError,match='unsafe_archive'):extract(buffer.getvalue(),'never-created')
