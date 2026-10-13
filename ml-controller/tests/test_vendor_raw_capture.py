import importlib
import io
import json
import pandas as pd
import polars as pl
import pytest
from services.vendor_raw_capture import FullRawCapture, audit_wide_raw, sha


@pytest.mark.parametrize('alias_values', [['2330', None], ['2317', None], ['2330', '2317']])
def test_holding_identity_aliases_keep_raw_bytes_and_reject_conflicts(tmp_path, alias_values):
    capture = FullRawCapture(tmp_path/'holding', roster=['2330'], required={'holding':'inventory'})
    root = capture.root/'sdk'
    frame = pd.DataFrame({'stock_id':pd.Categorical(['2330',None]),
                          'symbol':pd.Categorical(alias_values),
                          'date':pd.to_datetime(['2026-10-09','2026-10-09']),
                          '持股分級':pd.Categorical(['1','2']), '占集保庫存數比例':[0.,None]})
    stream = io.BytesIO()
    frame.to_feather(stream)
    wire = stream.getvalue()
    (root/'inventory.feather').write_bytes(wire)
    if alias_values == ['2330',None]:
        record = capture.seal('holding')
        assert record['status'] == 'raw_verified'
        assert record['inventory']['identity_column'] == 'symbol'
    else:
        with pytest.raises(ValueError, match='raw_holding_identity_alias_conflict'):
            capture.seal('holding')
        assert capture.receipt['status'] == 'rejected'
    assert (capture.root/'sealed/holding.feather').read_bytes() == wire


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    import requests
    def blocked(*a,**kw):raise AssertionError('network_forbidden_in_capture_tests')
    monkeypatch.setattr(requests.sessions.Session,'request',blocked)


def raw_bytes(*,conflict=False,duplicate_date=False,infinite=False):
    raw=pd.DataFrame({'date':pd.to_datetime(['2026-10-06','2026-10-06' if duplicate_date else '2026-10-07']),
      '0050 元大':[0.0,None],'0050 舊名':[1.0 if conflict else 0.0,None],
      '2330 台積電':[10.0,float('inf') if infinite else 11.0], '9999 額外全欄':[22.0,23.0]})
    buf=io.BytesIO();raw.to_feather(buf)
    return raw,buf.getvalue()


def new_capture(tmp_path,required=None):
    return FullRawCapture(tmp_path/'fresh',roster=['0050','2330','8888'],
                          required=required or {'close':'price:收盤價'})


def sdk_persist(cap,raw,payload,key='price:收盤價'):
    storage=cap.make_sdk_storage()
    get=importlib.import_module('finlab.data.get')
    # Actual SDK function, with a supplied already-downloaded payload, no fetch.
    get._persist_downloaded_frame(storage,key,raw,payload,None)
    return storage


def test_sdk_persists_full_raw_before_any_selection(tmp_path):
    cap=new_capture(tmp_path);raw,payload=raw_bytes();sdk_persist(cap,raw,payload)
    record=cap.seal('close');inv=record['inventory']
    assert (cap.root/record['path']).read_bytes()==payload
    assert inv['raw_columns']==4 and inv['rows']==2
    assert inv['formal_present_symbols']==['0050','2330'] and inv['formal_absent_symbols']==['8888']
    assert inv['duplicate_aliases']=={'0050':['0050 元大','0050 舊名']}
    retained=pl.read_ipc(cap.root/record['path'],memory_map=False)
    assert retained['0050 元大'].to_list()==[0.0,None]
    assert retained['9999 額外全欄'].to_list()==[22.0,23.0]
    receipt=cap.finish()
    assert receipt['status']=='raw_complete_not_formal_admitted' and not receipt['formal_admission_passed']


@pytest.mark.parametrize('fault,error',[('conflict','raw_alias_conflict'),('duplicate_date','raw_index_empty_null_or_duplicate'),('infinite','raw_infinite_value')])
def test_invalid_raw_retained_but_capture_rejected(tmp_path,fault,error):
    cap=new_capture(tmp_path);raw,payload=raw_bytes(**{fault:True});sdk_persist(cap,raw,payload)
    with pytest.raises(ValueError,match=error):cap.seal('close')
    receipt=json.loads((cap.root/'capture.json').read_text(encoding='utf8'))
    assert receipt['status']=='rejected'
    assert (cap.root/'sealed/close.feather').read_bytes()==payload
    with pytest.raises(ValueError,match='capture_closed'):cap.finish()


def test_incomplete_capture_cannot_finish(tmp_path):
    cap=new_capture(tmp_path,{'close':'price:收盤價','open':'price:開盤價'})
    raw,payload=raw_bytes();sdk_persist(cap,raw,payload);cap.seal('close')
    with pytest.raises(ValueError,match='capture_incomplete'):cap.finish()
    assert json.loads((cap.root/'capture.json').read_text(encoding='utf8'))['status']=='incomplete'


def test_no_existing_vintage_resume(tmp_path):
    cap=new_capture(tmp_path)
    with pytest.raises(FileExistsError):new_capture(tmp_path)
    assert cap.receipt['status']=='incomplete'


def test_no_repeat_seal_or_overwrite(tmp_path):
    cap=new_capture(tmp_path);raw,payload=raw_bytes();sdk_persist(cap,raw,payload);r=cap.seal('close')
    with pytest.raises(ValueError,match='dataset_already_sealed'):cap.seal('close')
    assert sha(cap.root/r['path'])==r['sha256']


def test_changed_sealed_bytes_rejected(tmp_path):
    cap=new_capture(tmp_path);raw,payload=raw_bytes();sdk_persist(cap,raw,payload);r=cap.seal('close')
    (cap.root/r['path']).write_bytes(b'corrupted isolated fixture')
    with pytest.raises(ValueError,match='capture_corrupt_or_unverified'):cap.finish()


def test_expired_capture_no_cross_window_completion(tmp_path):
    cap=new_capture(tmp_path);cap.started-=3601
    with pytest.raises(ValueError,match='capture_window_expired'):cap.seal('close')
    with pytest.raises(ValueError,match='capture_window_expired'):cap.finish()


def test_missing_raw_never_seals_as_complete(tmp_path):
    cap=new_capture(tmp_path)
    with pytest.raises(FileNotFoundError):cap.seal('close')
    assert not cap.receipt['datasets']


def test_index_ambiguity_rejected(tmp_path):
    file=tmp_path/'ambiguous.feather'
    pl.DataFrame({'date':[1],'index':[1],'0050':[0.0]}).write_ipc(file)
    with pytest.raises(ValueError,match='raw_index_missing_or_ambiguous'):audit_wide_raw(file,['0050'])


def test_dataset_path_cannot_escape_capture(tmp_path):
    cap=new_capture(tmp_path,{'close':'../../outside'})
    with pytest.raises(ValueError,match='source_path_invalid'):cap.seal('close')
